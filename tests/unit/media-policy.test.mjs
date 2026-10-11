import assert from 'node:assert/strict';
import { test } from 'node:test';

const modules = await Promise.all([
  import('../../src/blog/media-contract.js').catch(() => null),
  import('../../src/blog/image-processing.js').catch(() => null),
]);
const [contract, processing] = modules;

function requireExport(module, name) {
  assert.equal(typeof module?.[name], 'function', name + ' must be implemented');
  return module[name];
}

function bytesFor(kind, width = 32, height = 24) {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  if (kind === 'jpeg') {
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
    view.setUint16(7, height);
    view.setUint16(9, width);
    bytes.set([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 11);
  } else if (kind === 'png') {
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
    view.setUint32(16, width);
    view.setUint32(20, height);
  } else if (kind === 'webp') {
    bytes.set([...Buffer.from('RIFF')]);
    view.setUint32(4, 40, true);
    bytes.set([...Buffer.from('WEBPVP8X')], 8);
    bytes[24] = width - 1;
    bytes[27] = height - 1;
  } else if (kind === 'heic' || kind === 'heif' || kind === 'avif') {
    view.setUint32(0, 32);
    bytes.set([...Buffer.from('ftyp')], 4);
    bytes.set([...Buffer.from(kind === 'heic' ? 'heic' : kind === 'heif' ? 'mif1' : 'avif')], 8);
    bytes.set([...Buffer.from(kind === 'heic' ? 'heic' : kind === 'heif' ? 'heix' : 'avif')], 20);
    view.setUint32(32, 20);
    bytes.set([...Buffer.from('ispe')], 36);
    view.setUint32(44, width);
    view.setUint32(48, height);
  }
  return bytes;
}

function imageFile(kind, name = 'camera-upload.bin', type = '') {
  return new File([bytesFor(kind)], name, { type });
}

test('recognizes supported image formats from file bytes without trusting name or MIME', async () => {
  const validateInputImage = requireExport(processing, 'validateInputImage');
  for (const kind of ['jpeg', 'png', 'webp', 'heic', 'heif', 'avif']) {
    const info = await validateInputImage(imageFile(kind));
    assert.equal(info.format, kind);
    assert.equal(info.width, 32);
    assert.equal(info.height, 24);
  }
});

test('rejects unsupported and oversized files with a readable Portuguese error', async () => {
  const validateInputImage = requireExport(processing, 'validateInputImage');
  await assert.rejects(
    validateInputImage(new File([new Uint8Array([1, 2, 3])], 'not-an-image.dat')),
    (error) => /imagem|formato|ficheiro/i.test(error.message),
  );
  await assert.rejects(
    validateInputImage(new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'large.jpg')),
    (error) => /30|grande|limite/i.test(error.message),
  );
  await assert.rejects(
    validateInputImage(new File([bytesFor('png', 12_001, 10)], 'too-wide.png')),
    (error) => /12 000|megapíxeis|limite/i.test(error.message),
  );
});

test('publishes the approved responsive image policy', () => {
  assert.ok(contract, 'media-contract.js must be implemented');
  assert.equal(contract.MAX_INPUT_BYTES, 30 * 1024 * 1024);
  assert.equal(contract.MAX_DIMENSION, 12000);
  assert.equal(contract.MAX_PIXELS, 60_000_000);
  assert.deepEqual(contract.VARIANT_WIDTHS, [480, 960, 1600]);
  assert.equal(contract.MASTER_MAX_WIDTH, 1600);
  assert.equal(contract.INITIAL_QUALITY, 0.84);
  assert.equal(contract.MIN_QUALITY, 0.78);
});
