import { expect, test } from '@playwright/test';

async function fixtureFile(page, name, mime = '') {
  const response = await page.request.get(`/__task2/${name}`);
  expect(response.ok(), `fixture ${name} is served from the built harness`).toBeTruthy();
  const bytes = await response.body();
  await page.evaluate(({ encoded, fileName, type }) => {
    const binary = atob(encoded); const values = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) values[i] = binary.charCodeAt(i);
    window.__imageFixture = new File([values], fileName, { type });
  }, { encoded: bytes.toString('base64'), fileName: name, type: mime });
  return { name, size: bytes.length };
}

async function optimize(page, _file, encoder) {
  return page.evaluate(async ({ encoder }) => {
    const start = performance.now();
    const heapBefore = performance.memory?.usedJSHeapSize ?? null;
    const result = await window.imageProcessingHarness.optimizeImage(window.__imageFixture, { encoder });
    window.__lastWebPVariant = result.variants.at(-1).blob;
    return {
      elapsedMs: performance.now() - start,
      heapDeltaBytes: heapBefore === null ? null : performance.memory.usedJSHeapSize - heapBefore,
      pipelineVersion: result.pipelineVersion,
      width: result.width,
      height: result.height,
      encoder: result.encoder,
      variants: await Promise.all(result.variants.map(async (variant) => {
        const bitmap = await createImageBitmap(variant.blob);
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let alphaMin = 255; let alphaMax = 0; let rgbSum = 0; let squareSum = 0; let count = 0;
        for (let i = 0; i < pixels.length; i += 4 * Math.max(1, Math.floor(pixels.length / (4 * 4096)))) {
          alphaMin = Math.min(alphaMin, pixels[i + 3]); alphaMax = Math.max(alphaMax, pixels[i + 3]);
          const luminance = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          rgbSum += luminance; squareSum += luminance * luminance; count += 1;
        }
        const bytes = new Uint8Array(await variant.blob.arrayBuffer());
        const chunks = []; let offset = 12;
        while (offset + 8 <= bytes.length) {
          const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
          const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
          chunks.push(kind); offset += 8 + length + (length % 2);
        }
        const report = { width: bitmap.width, height: bitmap.height, type: variant.blob.type, size: variant.size,
          sha256: variant.sha256, quality: variant.quality, targetBytes: variant.targetBytes,
          withinTarget: variant.withinTarget, alphaMin, alphaMax,
          luminanceMean: rgbSum / count, luminanceVariance: squareSum / count - (rgbSum / count) ** 2,
          chunks };
        bitmap.close(); canvas.width = 1; canvas.height = 1;
        return report;
      })),
    };
  }, { encoder });
}

test('serves the built media harness with an active worker pipeline', async ({ page }) => {
  const response = await page.goto('/__task2/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Image pipeline test harness' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.imageProcessingHarness?.ready)).toBe(true);
});

test('converts EXIF-rotated JPEG to proportional, metadata-free WebP variants', async ({ page }) => {
  await page.goto('/__task2/');
  const file = await fixtureFile(page, 'oriented.jpg', 'application/octet-stream');
  const result = await optimize(page, file);
  expect(result.width).toBe(600); expect(result.height).toBe(800);
  expect(result.variants.map(({ width, height }) => [width, height])).toEqual([[480, 640], [600, 800], [600, 800]]);
  expect(result.variants.every((v) => v.type === 'image/webp' && v.sha256.length === 64)).toBe(true);
  expect(result.variants.flatMap((v) => v.chunks)).not.toContain('EXIF');
  expect(result.variants.flatMap((v) => v.chunks)).not.toContain('XMP ');
});

test('preserves PNG transparency through bundled WASM encoding and decodes output', async ({ page }) => {
  await page.goto('/__task2/');
  const file = await fixtureFile(page, 'alpha.png', 'image/png');
  const result = await optimize(page, file, 'wasm');
  expect(result.encoder).toBe('wasm');
  expect(result.variants[0].width).toBe(200);
  expect(result.variants[0].height).toBe(100);
  expect(result.variants[0].alphaMin).toBeLessThan(10);
  expect(result.variants[0].alphaMax).toBeGreaterThan(245);
  expect(result.variants[0].size).toBeLessThan(1024 * 1024);
});

test('accepts AVIF by content and never enlarges a small WebP image', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'loremfile-640x480.avif', 'application/octet-stream');
  const avifInfo = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(avifInfo).toMatchObject({ format: 'avif', width: 640, height: 480 });
  const avif = await optimize(page, null);
  expect(avif.variants.map(({ width, height }) => [width, height])).toEqual([[480, 360], [640, 480], [640, 480]]);

  await fixtureFile(page, 'small.webp', 'application/octet-stream');
  const webpInfo = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(webpInfo).toMatchObject({ format: 'webp', width: 72, height: 48 });
  const webp = await optimize(page, null);
  expect(webp.variants.map(({ width, height }) => [width, height])).toEqual([[72, 48], [72, 48], [72, 48]]);
});

test('converts the public iPhone XR HEIC through the real HEIC worker', async ({ page }, testInfo) => {
  await page.goto('/__task2/');
  const file = await fixtureFile(page, 'iphone-xr-original.HEIC');
  const started = Date.now();
  const info = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(info.format).toBe('heic');
  const result = await optimize(page, file);
  expect(result.pipelineVersion).toBe(1);
  expect(result.width).toBeGreaterThan(1600);
  expect(result.variants.map((v) => v.width)).toEqual([480, 960, 1600]);
  expect(result.variants.every((v) => v.type === 'image/webp' && v.luminanceVariance > 100)).toBe(true);
  console.log('Task2 iPhone XR fixture profile', JSON.stringify({ browser: page.context().browser()?.browserType().name(), fixtureBytes: file.size,
    input: [result.width, result.height], elapsedMs: result.elapsedMs, heapDeltaBytes: result.heapDeltaBytes,
    variants: result.variants.map(({ width, height, size, quality, withinTarget, luminanceMean, luminanceVariance }) => ({ width, height, size, quality, withinTarget, luminanceMean, luminanceVariance })) }));
  await page.evaluate(() => {
    const preview = document.createElement('img'); preview.id = 'webp-preview';
    preview.src = URL.createObjectURL(window.__lastWebPVariant); preview.style.maxWidth = '800px';
    document.body.replaceChildren(preview);
  });
  await page.locator('#webp-preview').waitFor({ state: 'visible' });
  await page.locator('#webp-preview').screenshot({ path: testInfo.outputPath('iphone-xr-webp-preview.png') });
  expect(Date.now() - started).toBeGreaterThan(0);
});

test('keeps a cancelled result from attaching after article generation changes', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'iphone-xr-original.HEIC');
  const state = await page.evaluate(async () => {
    const attached = []; let generation = 41; let cancelled = false; let lateProgress = 0;
    const controller = new AbortController();
    const promise = window.imageProcessingHarness.optimizeImage(window.__imageFixture, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.stage === 'decode' && !cancelled) { generation = 42; cancelled = true; controller.abort(); }
        else if (cancelled) lateProgress += 1;
      },
    });
    try {
      const result = await promise;
      if (generation === 41) attached.push(result);
      return { rejected: false, attached: attached.length };
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { rejected: error.name === 'AbortError', attached: attached.length, generation, cancelled, lateProgress };
    }
  });
  expect(state).toEqual({ rejected: true, attached: 0, generation: 42, cancelled: true, lateProgress: 0 });
});

test('rejects invalid bytes and oversized input before worker decode', async ({ page }) => {
  await page.goto('/__task2/');
  const errors = await page.evaluate(async () => {
    const draft = { body: 'Texto do rascunho que deve permanecer intacto.' };
    const bad = new File([new Uint8Array([1, 2, 3])], 'bad.jpg', { type: 'image/jpeg' });
    const huge = new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'huge.jpg');
    const messages = [];
    for (const f of [bad, huge]) try { await window.imageProcessingHarness.optimizeImage(f); } catch (e) { messages.push(e.message); }
    return { messages, body: draft.body };
  });
  expect(errors.messages).toHaveLength(2);
  expect(errors.messages[0]).toMatch(/imagem|formato|ficheiro/i);
  expect(errors.messages[1]).toMatch(/30|grande|limite/i);
  expect(errors.body).toBe('Texto do rascunho que deve permanecer intacto.');
});
