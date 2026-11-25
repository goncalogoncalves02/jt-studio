import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/media/preview?*', route => route.fulfill({
    path: 'tests/fixtures/media/small.webp',
    contentType: 'image/webp',
  }));
});

async function openPicker(page) {
  await page.goto('/__task5/');
  await expect(page.getByRole('heading', { name: 'Task 5 media picker harness' })).toHaveCount(0);
  await expect(page.getByLabel('Escolher imagem')).toBeVisible();
}

async function selectImage(page, name) {
  await page.getByLabel('Escolher imagem').setInputFiles({ name, mimeType: 'image/jpeg', buffer: Buffer.from('fixture-image') });
}

async function completeWorker(page, workerIndex, mediaId) {
  await page.evaluate(({ index, id }) => window.__task5Workers[index].complete(id), { index: workerIndex, id: mediaId });
}

test('clears an already decoded private preview on logout and successor login', async ({ page }) => {
  await openPicker(page);
  await selectImage(page, 'first.jpg');
  await expect.poll(() => page.evaluate(() => window.__task5Workers.length)).toBe(1);
  await completeWorker(page, 0, 'first');
  const preview = page.getByRole('img', { name: 'Pré-visualização privada da imagem' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true);
  await page.evaluate(() => window.__task5Session.logout());
  await expect(page.getByRole('img', { name: 'Pré-visualização privada da imagem' })).toHaveCount(0);
  await page.evaluate(() => window.__task5Session.login());
  await expect(page.getByRole('img', { name: 'Pré-visualização privada da imagem' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('shows processing and sequential upload progress and lets the user cancel during processing', async ({ page }) => {
  await openPicker(page);
  await selectImage(page, 'processing.jpg');
  await expect(page.getByRole('status')).toContainText(/processar.*JPEG/i);
  await page.getByRole('button', { name: 'Cancelar carregamento' }).click();
  await expect(page.getByRole('status')).toContainText(/cancelad/i);
  await expect(page.locator('article')).toHaveText('Rascunho do artigo preservado durante o carregamento.');
  expect(await page.evaluate(() => window.__task5Counts)).toEqual({ upload: 0, complete: 0, onComplete: 0 });
});

test('cancels an active upload without completing media or changing the article', async ({ page }) => {
  await openPicker(page);
  await page.evaluate(() => { window.__task5HoldNextUpload = true; });
  await selectImage(page, 'upload.jpg');
  await expect.poll(() => page.evaluate(() => window.__task5Workers.length)).toBe(1);
  await completeWorker(page, 0, 'cancel-upload');
  await expect(page.getByRole('status')).toContainText(/carregar versão 1 de 2/i);
  await page.getByRole('button', { name: 'Cancelar carregamento' }).click();
  await expect(page.getByRole('status')).toContainText(/cancelad/i);
  await expect.poll(() => page.evaluate(() => window.__task5SettledUploads)).toBe(1);
  expect(await page.evaluate(() => window.__task5Counts)).toEqual({ upload: 1, complete: 0, onComplete: 0 });
  await expect(page.locator('article')).toHaveText('Rascunho do artigo preservado durante o carregamento.');
});

test('a late old-session upload response cannot overwrite a successor operation', async ({ page }) => {
  await openPicker(page);
  await page.evaluate(() => { window.__task5HoldNextUpload = true; window.__task5IgnoreNextUploadAbort = true; });
  await selectImage(page, 'old.jpg');
  await expect.poll(() => page.evaluate(() => window.__task5Workers.length)).toBe(1);
  await completeWorker(page, 0, 'old');
  await expect.poll(() => page.evaluate(() => window.__task5Counts.upload)).toBe(1);
  await page.evaluate(() => window.__task5Session.logout());
  await page.evaluate(() => window.__task5Session.login());
  await page.evaluate(() => { window.__task5HoldNextUpload = true; });
  await selectImage(page, 'new.jpg');
  await expect.poll(() => page.evaluate(() => window.__task5Workers.length)).toBe(2);
  await completeWorker(page, 1, 'new');
  const successorPreview = page.getByRole('img', { name: 'Pré-visualização privada da imagem' });
  await expect(page.getByRole('button', { name: 'Cancelar carregamento' })).toBeVisible();
  await expect(page.getByLabel('Escolher imagem')).toBeDisabled();
  await page.evaluate(() => window.__task5Held[0]());
  await expect.poll(() => page.evaluate(() => window.__task5SettledUploads)).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancelar carregamento' })).toBeVisible();
  await expect(page.getByLabel('Escolher imagem')).toBeDisabled();
  await expect(successorPreview).toHaveCount(0);
  expect(await page.evaluate(() => window.__task5Counts)).toEqual({ upload: 2, complete: 0, onComplete: 0 });
  await page.evaluate(() => window.__task5Held[1]());
  await expect.poll(() => page.evaluate(() => window.__task5SettledUploads)).toBe(3);
  await expect(successorPreview).toBeVisible();
  const successorSrc = await successorPreview.getAttribute('src');
  expect(successorSrc).toMatch(/mediaId=[0-9a-f-]{36}/i);
  await expect(successorPreview).toHaveAttribute('src', successorSrc);
  await expect(page.getByRole('status')).toContainText('pronta para usar');
  expect(await page.evaluate(() => window.__task5Counts)).toEqual({ upload: 3, complete: 1, onComplete: 1 });
});
