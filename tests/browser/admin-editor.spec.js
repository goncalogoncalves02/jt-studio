import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'b64a04cf-4451-4cce-a27b-ea5ac877f085';
const post = {
  id, revision: 1, title: 'Como cuidar da pele após a micropigmentação',
  slug: 'cuidados-apos-micropigmentacao', excerpt: 'Os primeiros dias fazem a diferença. Veja os cuidados essenciais.',
  document: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Os primeiros cuidados' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Respeite o tempo de recuperação da pele e siga os cuidados que combinámos na sua sessão.' }] },
  ] },
  coverMediaId: null, serviceId: 1, preparedAction: null, contentModifiedAt: '2026-11-24T12:00:00Z',
};

async function setup(page) {
  const writes = [];
  let confirms = 0;
  let allowLive = false;
  const status = { requestId: id, releaseId: id };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4173(?:\/|$))/u, (route) => route.abort());
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const reply = (json) => route.fulfill({ json });
    switch (url.pathname) {
      case '/api/admin/session':
        return reply({ user: { id }, csrfToken: 'fixture-csrf-token', expiresAt: '2026-12-24T12:00:00Z' });
      case '/api/admin/publication/confirm':
        confirms += 1;
        return reply({ ...status, state: 'confirmed' });
      case '/api/admin/publication/progress': return reply({ ...status, state: 'queued' });
      case '/api/admin/publication/reconcile': return reply({ ...status, state: allowLive ? 'live' : 'building' });
      case '/api/admin/publication/current': return reply({ publication: null });
      case '/api/admin/publication/review':
        return reply({ changes: [{ postId: id, revision: 1, action: 'upsert', title: post.title, slug: post.slug }] });
      case '/api/admin/posts':
        if (method === 'PUT') {
          const body = route.request().postDataJSON();
          writes.push(body);
          return reply({ post: { ...post, ...body.post, revision: body.expectedRevision + 1 } });
        }
        return reply(url.searchParams.has('id') ? { post, media: [] } : {
          posts: [post, { ...post, id: '7d85d808-02c7-48b5-9f36-ab3a36551d6e', title: 'Nanoblading e Shadow', preparedAction: 'upsert' }],
          hasNext: false,
        });
      default: return route.fulfill({ status: 404, json: {} });
    }
  });
  return { writes, getConfirms: () => confirms, publish: () => { allowLive = true; } };
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test('responsive editor and keyboard controls at ' + viewport.width, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const { writes, getConfirms, publish } = await setup(page);
    const response = await request.get('/admin');
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(await response.text()).not.toContain(post.title);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Painel editorial' })).toBeVisible();
    await page.getByRole('button', { name: post.title, exact: false }).click();
    await expect(page.getByRole('textbox', { name: 'Corpo do artigo' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    expect((await new AxeBuilder({ page }).include('.editor-surface').analyze()).violations).toEqual([]);

    const screenshotRoot = process.env.JT_EDITOR_SCREENSHOTS;
    if (screenshotRoot) await page.screenshot({ path: screenshotRoot + '/editor-' + viewport.width + '.png', fullPage: true });

    await page.getByRole('textbox', { name: 'Corpo do artigo' }).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Negrito' }).click();
    await expect(page.getByRole('textbox', { name: 'Corpo do artigo' })).toBeFocused();
    await page.keyboard.type('Texto em negrito');
    await expect(page.getByRole('textbox', { name: 'Corpo do artigo' })).toContainText('Texto em negrito');
    await page.getByRole('button', { name: 'Guardar agora' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
    expect(writes.at(-1).post.document.content.at(-1).content[0]).toEqual({
      type: 'text', text: 'Texto em negrito', marks: [{ type: 'bold' }],
    });
    await page.getByRole('button', { name: 'Rever publicação' }).click();
    const review = page.getByRole('region', { name: 'Rever publicação' });
    await expect(review.getByText(post.title)).toBeVisible();
    if (screenshotRoot) await page.screenshot({ path: screenshotRoot + '/revisao-' + viewport.width + '.png', fullPage: true });
    if (viewport.width === 390) {
      await review.getByRole('button', { name: 'Confirmar publicação' }).click();
      await expect(review.getByText('A aguardar o build')).toBeVisible();
      expect(getConfirms()).toBe(1);
      await expect(review.getByText('Publicação online')).toHaveCount(0);
      publish();
      await expect(review.getByText('Publicação online')).toBeVisible({ timeout: 10_000 });
      expect(getConfirms()).toBe(1);
    }
  });
}

test('public pages do not load the editor or image codecs', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4173(?:\/|$))/u, (route) => route.abort());
  await page.goto('/blog');
  await expect(page.getByRole('heading', { name: 'Notas de beleza' })).toBeVisible();
  expect(requests.filter((path) => /\/api\/admin\/|\/(?:Admin|ArticleEditor|image-worker)-|\.wasm$/u.test(path))).toEqual([]);
});

test('a new article opens the empty editor', async ({ page }) => {
  await setup(page);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Novo artigo' }).click();
  await expect(page.getByRole('textbox', { name: 'Título', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Corpo do artigo' })).toBeVisible();
});
