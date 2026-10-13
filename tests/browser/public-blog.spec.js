import { expect, test } from '@playwright/test';
import { parse } from 'parse5';

const localBase = 'http://127.0.0.1:4173';
const releaseId = '00000000-0000-4000-8000-000000000099';

test('published index is body-free and opening one article downloads only its versioned JSON', async ({ page, request }) => {
  const browserErrors = [];
  const postRequests = [];
  await page.route('**/storage/v1/object/public/blog-public/**', (route) => route.fulfill({ path: 'tests/fixtures/media/small.webp', contentType: 'image/webp' }));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (event) => {
    const url = new URL(event.url());
    if (url.pathname.startsWith(`/blog-data/${releaseId}/posts/`)) postRequests.push(url.pathname);
  });

  const indexResponse = await request.get(`/blog-data/${releaseId}/index.json`);
  expect(indexResponse.status()).toBe(200);
  const indexText = await indexResponse.text();
  expect(JSON.parse(indexText)).toHaveLength(100);
  expect(indexText).not.toContain('body-sentinel-post-');

  await page.goto('/blog');
  await expect(page.locator('main article')).toHaveCount(100);
  await expect(page.locator('main')).not.toContainText('body-sentinel-post-050-unique');
  expect(postRequests).toEqual([]);
  await page.locator('main a[href="/blog/post-050"]').first().click();
  await expect(page).toHaveURL(`${localBase}/blog/post-050`);
  await expect(page.locator('main')).toContainText('body-sentinel-post-050-unique');
  await expect(page.locator('main')).not.toContainText('body-sentinel-post-049-unique');
  expect(postRequests).toEqual([`/blog-data/${releaseId}/posts/post-050.json`]);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jaquelinetakiutistudio.com/blog/post-050');
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
  expect(browserErrors).toEqual([]);
});

test('shared cover and inline image load together after client navigation', async ({ page }) => {
  await page.route('**/storage/v1/object/public/blog-public/**', (route) => route.fulfill({ path: 'tests/fixtures/media/small.webp', contentType: 'image/webp' }));
  await page.goto('/blog');
  await page.locator('main a[href="/blog/post-000"]').first().click();
  await expect(page).toHaveURL(`${localBase}/blog/post-000`);
  await expect(page.locator('main h1')).toContainText('Artigo sintético 000');
  await expect(page.locator('main article img')).toHaveCount(2);
  const sources = await page.locator('main article img').evaluateAll((images) => images.map((image) => image.currentSrc || image.src));
  expect(sources[0]).toBe(sources[1]);
});

test('article HTML has escaped bootstrap data, one BlogPosting schema, and hydrates without errors', async ({ page, request }) => {
  const browserErrors = [];
  await page.route('**/storage/v1/object/public/blog-public/**', (route) => route.fulfill({ path: 'tests/fixtures/media/small.webp', contentType: 'image/webp' }));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const raw = await request.get('/blog/post-050');
  expect(raw.status()).toBe(200);
  const html = await raw.text();
  expect(html).toContain('body-sentinel-post-050-unique');
  expect(html).toContain('\\u003c/script>');
  const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  expect((head.match(/application\/ld\+json/g) ?? [])).toHaveLength(3);
  const parsed = parse(html);
  const find = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => find(child, predicate)), ...(node.content ? find(node.content, predicate) : []) ];
  const attribute = (node, name) => node.attrs?.find((entry) => entry.name === name)?.value;
  const parsedTitle = find(parsed, (node) => node.tagName === 'title')[0].childNodes[0].value;
  const parsedScripts = find(parsed, (node) => node.tagName === 'script').map((node) => node.childNodes.map((child) => child.value ?? '').join(''));
  expect(parsedScripts.some((script) => script.includes('</script><script>alert(1)</script>'))).toBe(false);
  const parsedMeta = (selector) => {
    const [kind, value] = selector.startsWith('meta[name=') ? ['name', selector.match(/"([^"]+)"/)[1]] : ['property', selector.match(/"([^"]+)"/)[1]];
    return find(parsed, (node) => node.tagName === 'meta' && attribute(node, kind) === value)[0];
  };
  const expectedTitle = `Post 050 </script><script>alert(1)</script> | JT Studio`;
  const expectedDescription = `Resumo "especial" da Jaqueline's: </script><script>alert(1)</script> & cuidados.`;
  expect(parsedTitle).toBe(expectedTitle);
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="twitter:title"]', 'meta[name="twitter:description"]']) {
    const meta = parsedMeta(selector);
    expect(attribute(meta, 'content')).toBe(selector.includes('title') ? expectedTitle : expectedDescription);
  }
  await page.goto('/blog/post-050');
  await expect(page).toHaveTitle(expectedTitle);
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    await expect(page.locator(selector)).toHaveAttribute('content', expectedDescription);
  }
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    await expect(page.locator(selector)).toHaveAttribute('content', expectedTitle);
  }
  await expect(page.locator('meta[property="article:published_time"]')).toHaveAttribute('content', '2026-10-13T12:00:50.000Z');
  await expect(page.locator('meta[property="article:modified_time"]')).toHaveAttribute('content', '2026-10-13T12:00:50.000Z');
  await expect(page.locator('main h1')).toContainText('</script>');
  await expect(page.locator('head script[type="application/ld+json"]')).toHaveCount(3);
  const types = await page.locator('head script[type="application/ld+json"]').evaluateAll((nodes) => nodes.map((node) => JSON.parse(node.textContent)['@type']));
  expect(types).toEqual(['BeautySalon', 'BreadcrumbList', 'BlogPosting']);
  await expect(page.locator('head meta[name="robots"]')).toHaveCount(0);
  const articleSchema = JSON.parse(await page.locator('head script[type="application/ld+json"]').nth(2).textContent());
  expect(articleSchema.headline).toContain('</script><script>alert(1)</script>');
  expect(await page.locator('head script[type="application/ld+json"]').count()).toBe(3);
  expect(browserErrors).toEqual([]);
});

test('missing blog pages return a real 404 and client navigation keeps 404 and hash behavior', async ({ page, request }) => {
  const missing = await request.get('/blog/not-in-this-release');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('Página não encontrada');
  const missingPage = await page.goto('/blog/not-in-this-release');
  expect(missingPage.status()).toBe(404);
  await expect(page.locator('main')).toContainText('Página não encontrada');
  await expect(page.locator('head meta[name="robots"]')).toHaveCount(1);
  await expect(page.locator('head meta[name="robots"]').first()).toHaveAttribute('content', 'noindex, nofollow');

  const admin = await request.get('/admin');
  expect(admin.status()).toBe(200);
  expect(await admin.text()).toContain('noindex, nofollow');
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap).not.toContain('/admin');
  expect(sitemap).not.toContain('/404');

  await page.goto('/blog');
  await page.goto('/404');
  await page.getByRole('link', { name: 'Início' }).first().click();
  await page.getByRole('link', { name: 'Blog', exact: true }).first().click();
  await expect(page.locator('main')).toContainText('Notas de beleza');
  await page.locator('main a[href="/blog/post-000"]').first().click();
  await expect(page.locator('main h1')).toContainText('Artigo sintético 000');
  await page.goto('/blog');
  await page.locator('main a[href="/blog/post-000"]').first().click();
  await expect(page.locator('main h1')).toContainText('Artigo sintético 000');
  await page.getByRole('link', { name: 'Conhecer serviço relacionado' }).click();
  await expect(page).toHaveURL(/\/servicos#servico-1$/);
  const anchor = page.locator('#servico-1');
  await expect(anchor).toBeInViewport();
  await expect.poll(() => anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(240);
});

test('mobile Blog navigation closes the menu and keeps public pages responsive', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  const blogLink = page.locator('.fixed.inset-0').getByRole('link', { name: 'Blog', exact: true });
  await expect(blogLink).toBeVisible();
  await blogLink.click();
  await expect(page).toHaveURL(`${localBase}/blog`);
  await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
  await expect(page.locator('main h1')).toContainText('Notas de beleza');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('desktop navigation fits at the 1024px lg breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    links: [...document.querySelectorAll('nav ul a')].map((node) => {
      const box = node.getBoundingClientRect();
      return { label: node.textContent.trim(), left: box.left, right: box.right };
    }),
    button: document.querySelector('nav > a[href^="https://"]')?.getBoundingClientRect().toJSON(),
  }));
  expect(layout.links).toHaveLength(6);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.links.every((link) => link.left >= 0 && link.right <= layout.width)).toBe(true);
  expect(layout.button?.right).toBeLessThanOrEqual(layout.width);
});

test('direct missing and removed article 404s hydrate cleanly and recover through client navigation', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/storage/v1/object/public/blog-public/**', (route) => route.fulfill({ path: 'tests/fixtures/media/small.webp', contentType: 'image/webp' }));
  const allowedResource404 = /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u;
  const assertNoHydrationErrors = () => {
    expect(consoleErrors.filter((message) => !allowedResource404.test(message))).toEqual([]);
    expect(pageErrors).toEqual([]);
  };

  const firstResponse = await page.goto('/blog/not-in-this-release');
  expect(firstResponse.status()).toBe(404);
  await expect(page.locator('main h1')).toContainText('Página não encontrada');
  await page.waitForTimeout(120);
  assertNoHydrationErrors();

  consoleErrors.length = 0;
  const removedResponse = await page.goto('/blog/article-removed-after-publication');
  expect(removedResponse.status()).toBe(404);
  await expect(page.locator('main h1')).toContainText('Página não encontrada');
  await page.waitForTimeout(120);
  assertNoHydrationErrors();

  await page.getByRole('link', { name: 'Blog', exact: true }).first().click();
  await expect(page).toHaveURL(`${localBase}/blog`);
  await page.locator('main a[href="/blog/post-000"]').first().click();
  await expect(page).toHaveURL(`${localBase}/blog/post-000`);
  await expect(page.locator('main h1')).toContainText('Artigo sintético 000');
  await expect(page.locator('main article figure')).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(`${localBase}/blog`);
  await page.goBack();
  await expect(page).toHaveURL(`${localBase}/blog/article-removed-after-publication`);
  await expect(page.locator('main h1')).toContainText('Página não encontrada');
  assertNoHydrationErrors();
});

test('malformed encoded fragments leave public page content and navigation usable', async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  for (const fragment of ['%', '%E0%A4%A']) {
    const response = await page.goto(`/servicos?fragment=${encodeURIComponent(fragment)}#${fragment}`);
    expect(response.status()).toBe(200);
    await expect(page.locator('main h1')).toContainText('Seis técnicas');
    await expect(page.getByRole('link', { name: 'Blog', exact: true }).first()).toBeVisible();
    expect(await page.locator('#root').textContent()).not.toBe('');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }
  await page.getByRole('link', { name: 'Blog', exact: true }).first().click();
  await expect(page.locator('main h1')).toContainText('Notas de beleza');
});
