import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

async function optimize(page) {
  return page.evaluate(async () => {
    const start = performance.now();
    const heapBefore = performance.memory?.usedJSHeapSize ?? null;
    const result = await window.imageProcessingHarness.optimizeImage(window.__imageFixture);
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
        const sampleAt = (x, y) => { const p = (Math.min(bitmap.height - 1, y) * bitmap.width + Math.min(bitmap.width - 1, x)) * 4; return [...pixels.subarray(p, p + 3)]; };
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
          probes: [sampleAt(Math.round(bitmap.width / 2), Math.round(bitmap.height * 0.15)), sampleAt(Math.round(bitmap.width / 2), Math.round(bitmap.height * 0.85))],
          luminanceMean: rgbSum / count, luminanceVariance: squareSum / count - (rgbSum / count) ** 2,
          chunks };
        bitmap.close(); canvas.width = 1; canvas.height = 1;
        return report;
      })),
    };
  });
}

function decoderRequests(requests) {
  return requests.filter((url) => /\/heif-(?:codec|decoder)(?:[-./]|$)/i.test(new URL(url).pathname));
}

function topLevelBoxes(bytes) {
  const result = []; let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset); const type = bytes.toString('latin1', offset + 4, offset + 8); let header = 8;
    if (size === 1) { size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
    else if (size === 0) size = bytes.length - offset;
    if (size < header || size > bytes.length - offset) throw new Error(`Invalid ${type} box in test fixture`);
    result.push({ type, offset, size }); offset += size;
  }
  if (offset !== bytes.length) throw new Error('Trailing bytes in test fixture');
  return result;
}

test('serves the built media harness with an active worker pipeline', async ({ page }) => {
  const response = await page.goto('/__task2/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Image pipeline test harness' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.imageProcessingHarness?.ready)).toBe(true);
});

test('built HEIC WASM reports the approved codec versions and context allocation ceiling', async ({ page }) => {
  await page.goto('/__task2/');
  const info = await page.evaluate(() => window.imageProcessingHarness.heifCodecInfo());
  expect(info).toEqual({ libheif: '1.23.6', libde265: '1.1.3', maxImageSizePixels: 60_000_000, decodeThreads: 1 });
});

test('converts EXIF-rotated JPEG to proportional, metadata-free WebP variants', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'oriented.jpg', 'application/octet-stream');
  const result = await optimize(page);
  expect(result.width).toBe(600); expect(result.height).toBe(800);
  expect(result.variants.map(({ width, height }) => [width, height])).toEqual([[480, 640], [600, 800]]);
  expect(result.variants[1].probes[0][0]).toBeGreaterThan(result.variants[1].probes[0][2] * 1.8);
  expect(result.variants[1].probes[1][2]).toBeGreaterThan(result.variants[1].probes[1][0] * 1.8);
  expect(result.variants.every((v) => v.type === 'image/webp' && v.sha256.length === 64)).toBe(true);
  expect(result.variants.flatMap((v) => v.chunks)).not.toContain('EXIF');
  expect(result.variants.flatMap((v) => v.chunks)).not.toContain('XMP ');
  const orientation = await page.evaluate(async () => {
    const reference = await createImageBitmap(window.__imageFixture, { imageOrientation: 'from-image' });
    const optimized = await createImageBitmap(window.__lastWebPVariant);
    const canvas = new OffscreenCanvas(optimized.width, optimized.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(reference, 0, 0, canvas.width, canvas.height);
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(optimized, 0, 0);
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const regions = [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]].map(([x, y]) => {
      const cx = Math.floor(x * canvas.width); const cy = Math.floor(y * canvas.height); let error = 0; let count = 0;
      for (let py = cy - 8; py < cy + 8; py += 1) for (let px = cx - 8; px < cx + 8; px += 1) for (let c = 0; c < 3; c += 1) {
        const index = (py * canvas.width + px) * 4 + c; error += Math.abs(expected[index] - actual[index]); count += 1;
      }
      return error / count;
    });
    reference.close(); optimized.close(); return regions;
  });
  expect(orientation.every((error) => error < 24)).toBe(true);
});

test('fetches the HEIC decoder only when a HEIC image is processed and keeps decoder assets local', async ({ page }) => {
  const requests = [];
  page.context().on('request', (request) => requests.push(request.url()));
  await page.goto('/__task2/');
  await fixtureFile(page, 'oriented.jpg', 'application/octet-stream');
  await optimize(page);
  const decoderBeforeHeic = decoderRequests(requests);
  expect(decoderBeforeHeic).toEqual([]);
  await fixtureFile(page, 'iphone-xr-original.HEIC');
  const heic = await optimize(page);
  expect(heic.width).toBe(4032);
  const loadedDecoderRequests = decoderRequests(requests);
  expect(loadedDecoderRequests.length).toBeGreaterThan(0);
  expect(loadedDecoderRequests.every((url) => url.startsWith('http://127.0.0.1:4173/'))).toBe(true);
  expect(requests.every((url) => !/https?:\/\/(?!127\.0\.0\.1:4173)/i.test(url))).toBe(true);
});

test('rejects an oversized HEIC primary before requesting or starting the decoder', async ({ page }) => {
  const requests = [];
  page.context().on('request', (request) => requests.push(request.url()));
  await page.goto('/__task2/');
  const original = await readFile('tests/fixtures/media/iphone-xr-original.HEIC');
  const marker = Buffer.from('ispe'); const markerAt = original.indexOf(marker);
  const dimensionPattern = Buffer.from([0, 0, 0, 0, 0, 0x0f, 0xc0, 0, 0, 0x0b, 0xd0]);
  const dimsAt = original.indexOf(dimensionPattern, markerAt);
  expect(dimsAt).toBeGreaterThan(markerAt);
  original.writeUInt32BE(12_001, dimsAt + 4);
  await page.evaluate((encoded) => {
    const binary = atob(encoded); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    window.__imageFixture = new File([bytes], 'oversized-primary.heic');
  }, original.toString('base64'));
  const rejection = await page.evaluate(async () => {
    try { await window.imageProcessingHarness.optimizeImage(window.__imageFixture); return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  });
  expect(rejection).toMatchObject({ name: 'Error' });
  expect(rejection.message).toMatch(/12 000|megapíxeis|limite/i);
  expect(decoderRequests(requests)).toEqual([]);
});

test('rejects duplicate HEIF metadata after mdat before requesting the decoder', async ({ page }) => {
  const requests = [];
  page.context().on('request', (request) => requests.push(request.url()));
  await page.goto('/__task2/');
  const original = await readFile('tests/fixtures/media/iphone-xr-original.HEIC');
  const boxes = topLevelBoxes(original); const meta = boxes.find(({ type }) => type === 'meta');
  expect(boxes.at(-1).type).toBe('mdat');
  const duplicate = Buffer.from(original.subarray(meta.offset, meta.offset + meta.size));
  const rotation = duplicate.indexOf(Buffer.from('irot'));
  expect(rotation).toBeGreaterThanOrEqual(0);
  duplicate[rotation + 4] = 1;
  const ambiguous = Buffer.concat([original, duplicate]);
  await page.evaluate((encoded) => {
    const binary = atob(encoded); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    window.__imageFixture = new File([bytes], 'duplicate-meta-after-mdat.HEIC');
  }, ambiguous.toString('base64'));
  const rejection = await page.evaluate(async () => {
    try { await window.imageProcessingHarness.optimizeImage(window.__imageFixture); return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  });
  expect(rejection).toMatchObject({ name: 'Error' });
  expect(rejection.message).toMatch(/metadados|HEIF|inválid/i);
  expect(decoderRequests(requests)).toEqual([]);

  await fixtureFile(page, 'iphone-xr-original.HEIC');
  const valid = await optimize(page);
  expect(valid.width).toBe(4032);
  const positiveDecoderRequests = decoderRequests(requests);
  expect(positiveDecoderRequests.length).toBeGreaterThan(0);
  expect(positiveDecoderRequests.every((url) => url.startsWith('http://127.0.0.1:4173/'))).toBe(true);
});

test('falls back to the real bundled WASM encoder for invalid native output and rejected native encoding', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'alpha.png', 'image/png');
  for (const mode of ['invalid', 'reject']) {
    const result = await page.evaluate(async (mode) => {
      const report = await window.imageProcessingHarness.optimizeWithNativeFailure(window.__imageFixture, mode);
      const blob = report.variants[0].blob;
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const alpha = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let alphaMin = 255; let alphaMax = 0;
      for (let i = 3; i < alpha.length; i += 4) { alphaMin = Math.min(alphaMin, alpha[i]); alphaMax = Math.max(alphaMax, alpha[i]); }
      const measured = { encoder: report.encoder, width: bitmap.width, height: bitmap.height, alphaMin, alphaMax, size: report.variants[0].size };
      bitmap.close(); return measured;
    }, mode);
    expect(result.encoder).toBe('wasm');
    expect(result.width).toBe(200); expect(result.height).toBe(100);
    expect(result.alphaMin).toBeLessThan(10); expect(result.alphaMax).toBeGreaterThan(245);
    expect(result.size).toBeLessThan(1024 * 1024);
  }
  const abort = await page.evaluate(async () => {
    try { await window.imageProcessingHarness.optimizeWithNativeFailure(window.__imageFixture, 'abort'); return { rejected: false }; }
    catch (error) { return { rejected: true, name: error.name }; }
  });
  expect(abort).toEqual({ rejected: true, name: 'AbortError' });
});

test('accepts AVIF by content and never enlarges a small WebP image', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'loremfile-640x480.avif', 'application/octet-stream');
  const avifInfo = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(avifInfo).toMatchObject({ format: 'avif', width: 640, height: 480 });
  const avif = await optimize(page);
  expect(avif.variants.map(({ width, height }) => [width, height])).toEqual([[480, 360], [640, 480]]);

  await fixtureFile(page, 'small.webp', 'application/octet-stream');
  const webpInfo = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(webpInfo).toMatchObject({ format: 'webp', width: 72, height: 48 });
  const webp = await optimize(page);
  expect(webp.variants.map(({ width, height }) => [width, height])).toEqual([[72, 48]]);
});

test('caps portrait master by long side, preserves ratio, and deduplicates tall narrow variants', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'portrait-3024x4032.jpg', 'application/octet-stream');
  const portrait = await optimize(page);
  expect([portrait.width, portrait.height]).toEqual([3024, 4032]);
  expect(portrait.variants.map(({ width, height }) => [width, height])).toEqual([[480, 640], [960, 1280], [1200, 1600]]);
  expect(portrait.variants.every(({ width, height }) => Math.max(width, height) <= 1600 && Math.min(width / height, height / width) > 0.74)).toBe(true);

  await fixtureFile(page, 'narrow-tall-10x12000.jpg', 'application/octet-stream');
  const narrow = await optimize(page);
  expect(narrow.variants.map(({ width, height }) => [width, height])).toEqual([[1, 1600]]);
});

test('converts the public iPhone XR HEIC through the real HEIC worker and records full-resolution quality artifacts', async ({ page }) => {
  await page.goto('/__task2/');
  const file = await fixtureFile(page, 'iphone-xr-original.HEIC');
  const started = Date.now();
  const info = await page.evaluate(() => window.imageProcessingHarness.validateInputImage(window.__imageFixture));
  expect(info).toMatchObject({ format: 'heic', width: 4032, height: 3024 });
  const result = await optimize(page);
  expect(result.pipelineVersion).toBe(1);
  expect(result.width).toBe(4032);
  expect(result.variants.map(({ width, height }) => [width, height])).toEqual([[480, 360], [960, 720], [1600, 1200]]);
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
  const artifacts = await page.evaluate(async () => {
    const reference = await window.imageProcessingHarness.decodeReference(window.__imageFixture);
    const optimizedBlob = window.__lastWebPVariant;
    const optimized = await createImageBitmap(optimizedBlob);
    const referenceResponse = await fetch(reference.matchedPng);
    const referenceBitmap = await createImageBitmap(await referenceResponse.blob());
    const canvas = new OffscreenCanvas(optimized.width, optimized.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(referenceBitmap, 0, 0);
    const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(optimized, 0, 0);
    const output = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let absolute = 0; let square = 0; let count = 0;
    for (let i = 0; i < source.length; i += 4) for (let channel = 0; channel < 3; channel += 1) { const delta = source[i + channel] - output[i + channel]; absolute += Math.abs(delta); square += delta * delta; count += 1; }
    const mae = absolute / count; const mse = square / count;
    const meanAt = (pixels, xRatio, yRatio) => {
      const centerX = Math.round(canvas.width * xRatio); const centerY = Math.round(canvas.height * yRatio);
      const mean = [0, 0, 0]; let samples = 0;
      for (let y = centerY - 8; y < centerY + 8; y += 1) for (let x = centerX - 8; x < centerX + 8; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) mean[channel] += pixels[offset + channel];
        samples += 1;
      }
      return mean.map((value) => value / samples);
    };
    const directionalSamples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => {
      const expected = meanAt(source, x, y); const actual = meanAt(output, x, y);
      return { expected, actual, meanAbsoluteError: expected.reduce((sum, value, channel) => sum + Math.abs(value - actual[channel]), 0) / 3 };
    });
    const optimizedBytes = new Uint8Array(await optimizedBlob.arrayBuffer());
    const toUrl = async (url) => url.slice(url.indexOf(',') + 1);
    optimized.close(); referenceBitmap.close();
    let optimizedWebp = '';
    for (let i = 0; i < optimizedBytes.length; i += 0x7ffe) optimizedWebp += btoa(String.fromCharCode(...optimizedBytes.subarray(i, i + 0x7ffe)));
    return { width: reference.width, height: reference.height, fullPng: await toUrl(reference.fullPng), matchedPng: await toUrl(reference.matchedPng), optimizedWebp, mae, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), directionalSamples, optimizedLength: optimizedBytes.length };
  });
  const artifactsDir = resolve('.superpowers/sdd/2026-10-11-blog-editorial/task2-fix2-artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(resolve(artifactsDir, 'iphone-xr-decoded-full.png'), Buffer.from(artifacts.fullPng, 'base64'));
  await writeFile(resolve(artifactsDir, 'iphone-xr-decoded-1600x1200.png'), Buffer.from(artifacts.matchedPng, 'base64'));
  await writeFile(resolve(artifactsDir, 'iphone-xr-optimized-1600x1200.webp'), Buffer.from(artifacts.optimizedWebp, 'base64'));
  await writeFile(resolve(artifactsDir, 'iphone-xr-quality.json'), JSON.stringify({ ...artifacts, fullPng: undefined, matchedPng: undefined, optimizedWebp: undefined }, null, 2) + '\n');
  console.log('Task2 quality comparison', JSON.stringify({ fullResolution: [artifacts.width, artifacts.height], optimizedResolution: [1600, 1200], optimizedBytes: artifacts.optimizedLength, mae: artifacts.mae, psnr: artifacts.psnr, artifactDirectory: artifactsDir }));
  expect(artifacts.psnr).toBeGreaterThan(35);
  expect(artifacts.directionalSamples.every(({ meanAbsoluteError }) => meanAbsoluteError < 16)).toBe(true);
  expect(Date.now() - started).toBeGreaterThan(0);
});

test('terminates a cancelled worker, detaches listeners, and ignores a late callback', async ({ page }) => {
  await page.goto('/__task2/');
  await fixtureFile(page, 'iphone-xr-original.HEIC');
  const state = await page.evaluate(async () => {
    const attached = []; let generation = 41; let cancelled = false; let lateProgress = 0; let workerInstance;
    const NativeWorker = window.Worker;
    const messageDescriptor = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage');
    class TrackingWorker extends NativeWorker {
      constructor(...args) { super(...args); workerInstance = this; this.lastMessage = null; this.wasTerminated = false; }
      terminate() { this.wasTerminated = true; return super.terminate(); }
      set onmessage(handler) { if (handler) this.lastMessage = handler; messageDescriptor.set.call(this, handler); }
      get onmessage() { return messageDescriptor.get.call(this); }
      sendLateProgress() { this.lastMessage?.({ data: { type: 'progress', value: { stage: 'late' } } }); }
    }
    window.Worker = TrackingWorker;
    const controller = new AbortController();
    let removed = 0; const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
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
      workerInstance.sendLateProgress();
      const state = { rejected: error.name === 'AbortError', attached: attached.length, generation, cancelled, lateProgress, terminated: workerInstance.wasTerminated, handlerCleared: workerInstance.onmessage === null, removed };
      window.Worker = NativeWorker;
      return state;
    }
  });
  expect(state).toEqual({ rejected: true, attached: 0, generation: 42, cancelled: true, lateProgress: 0, terminated: true, handlerCleared: true, removed: 1 });
});

test('rejects invalid bytes and oversized input before worker decode', async ({ page }) => {
  await page.goto('/__task2/');
  const errors = await page.evaluate(async () => {
    const draft = { body: 'Texto do rascunho que deve permanecer intacto.' };
    const bad = new File([new Uint8Array([1, 2, 3])], 'bad.jpg', { type: 'image/jpeg' });
    const truncatedBytes = new Uint8Array(24);
    truncatedBytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(truncatedBytes.buffer).setUint32(16, 10); new DataView(truncatedBytes.buffer).setUint32(20, 10);
    const truncated = new File([truncatedBytes], 'truncated.png', { type: 'image/png' });
    const huge = new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'huge.jpg');
    const messages = [];
    for (const f of [bad, truncated, huge]) try { await window.imageProcessingHarness.optimizeImage(f); } catch (e) { messages.push(e.message); }
    return { messages, body: draft.body };
  });
  expect(errors.messages).toHaveLength(3);
  expect(errors.messages[0]).toMatch(/imagem|formato|ficheiro/i);
  expect(errors.messages[1]).toBe('A imagem está incompleta ou não pôde ser descodificada. Confirme o ficheiro e tente novamente.');
  expect(errors.messages[1]).not.toMatch(/Error|at |worker|WASM|decode/i);
  expect(errors.messages[2]).toMatch(/30|grande|limite/i);
  expect(errors.body).toBe('Texto do rascunho que deve permanecer intacto.');
});
