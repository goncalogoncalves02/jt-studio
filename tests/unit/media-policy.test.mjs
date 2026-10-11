import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

function u16(value) { return new Uint8Array([value >> 8, value & 0xff]); }
function u32(value) { return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]); }
function join(...parts) { const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }
function box(type, payload) { return join(u32(payload.length + 8), new TextEncoder().encode(type), payload); }
function ispe(width, height, malformed = false) {
  return malformed ? join(u32(8), new TextEncoder().encode('ispe')) : box('ispe', join(new Uint8Array(4), u32(width), u32(height)));
}
function heifFile({ width = 4032, height = 3024, tile = 512, malformed = false, overflow = false, payloadDecoy = false, format = 'heic', rotation = null, crop = false } = {}) {
  const major = format === 'heif' ? 'mif1' : format;
  const compatible = format === 'avif' ? 'mif1' : 'heic';
  const ftyp = box('ftyp', join(new TextEncoder().encode(major), u32(0), new TextEncoder().encode(compatible)));
  const pitm = box('pitm', join(new Uint8Array(4), u16(49)));
  const item = (id, kind) => box('infe', join(new Uint8Array([2, 0, 0, 0]), u16(id), u16(0), new TextEncoder().encode(kind), new Uint8Array([0])));
  const iinf = box('iinf', join(new Uint8Array(4), u16(3), item(1, 'hvc1'), item(49, 'grid'), item(50, 'hvc1')));
  const tileProperty = ispe(tile, tile);
  const mainProperty = ispe(width, height, malformed);
  const thumbnailProperty = ispe(320, 240);
  const properties = [tileProperty, mainProperty, thumbnailProperty];
  const primaryIndexes = [2];
  if (crop) {
    properties.push(box('clap', join(u32(320), u32(1), u32(240), u32(1), u32(0), u32(1), u32(0), u32(1))));
    primaryIndexes.push(properties.length);
  }
  if (rotation !== null) {
    properties.push(box('irot', new Uint8Array([rotation])));
    primaryIndexes.push(properties.length);
  }
  const ipco = box('ipco', join(...properties));
  const ipma = box('ipma', join(new Uint8Array(4), u32(3), u16(1), new Uint8Array([1, 1]), u16(49), new Uint8Array([primaryIndexes.length, ...primaryIndexes]), u16(50), new Uint8Array([1, 3])));
  const iprp = box('iprp', join(ipco, ipma));
  const meta = box('meta', join(new Uint8Array(4), pitm, iinf, iprp));
  let decoy = new Uint8Array();
  if (payloadDecoy) decoy = box('mdat', join(new TextEncoder().encode('ispe'), u32(12), u32(12), new TextEncoder().encode('ispe'), u32(8), u32(8)));
  let bytes = join(ftyp, decoy, meta);
  if (overflow) {
    const at = bytes.findIndex((_, i) => i + 8 <= bytes.length && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'ispe');
    if (at >= 0) new DataView(bytes.buffer).setUint32(at, 1000);
  }
  return new File([bytes], 'camera.heic', { type: '' });
}

test('recognizes supported image formats from file bytes without trusting name or MIME', async () => {
  const validateInputImage = requireExport(processing, 'validateInputImage');
  for (const kind of ['jpeg', 'png', 'webp']) {
    const info = await validateInputImage(imageFile(kind));
    assert.equal(info.format, kind);
    assert.equal(info.width, 32);
    assert.equal(info.height, 24);
  }
  for (const format of ['heic', 'heif', 'avif']) {
    const info = await validateInputImage(heifFile({ format, width: 32, height: 24 }));
    assert.equal(info.format, format);
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
  assert.deepEqual(contract.VARIANT_LONG_SIDES, [480, 960, 1600]);
  assert.equal(contract.MASTER_MAX_LONG_SIDE, 1600);
  assert.equal(contract.INITIAL_QUALITY, 0.84);
  assert.equal(contract.MIN_QUALITY, 0.78);
});

test('parses the primary HEIF item and ignores earlier tile, thumbnail and payload ispe bytes', async () => {
  const validateInputImage = requireExport(processing, 'validateInputImage');
  const actual = new File([await readFile('tests/fixtures/media/iphone-xr-original.HEIC')], 'camera.HEIC');
  assert.deepEqual(await validateInputImage(actual).then(({ format, width, height }) => ({ format, width, height })), { format: 'heic', width: 4032, height: 3024 });
  const decoy = await validateInputImage(heifFile({ payloadDecoy: true }));
  assert.deepEqual([decoy.width, decoy.height], [4032, 3024]);
  const transformed = await validateInputImage(heifFile({ rotation: 1, crop: true }));
  assert.deepEqual([transformed.width, transformed.height], [240, 320]);
  assert.deepEqual(transformed.orientation, { quarterTurns: 1, mirrorAxis: null, cleanAperture: true, primaryItemType: 'grid' });
});

test('rejects malformed HEIF property boxes and oversized primary dimensions before decode', async () => {
  const validateInputImage = requireExport(processing, 'validateInputImage');
  await assert.rejects(validateInputImage(heifFile({ malformed: true })), /HEIF|imagem|metadados|dimensões/i);
  await assert.rejects(validateInputImage(heifFile({ overflow: true })), /HEIF|imagem|metadados|dimensões/i);
  await assert.rejects(validateInputImage(heifFile({ width: 12_001, height: 5000 })), /12 000|megapíxeis|limite/i);
  await assert.rejects(validateInputImage(heifFile({ width: 32, height: 24, tile: 12_001 })), /12 000|megapíxeis|limite/i);
});

test('caps the long side and emits unique proportional output dimensions', () => {
  const masterDimensions = requireExport(contract, 'getMasterDimensions');
  const buildVariants = requireExport(contract, 'buildVariantDimensions');
  assert.deepEqual(masterDimensions(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(masterDimensions(8, 12_000), { width: 1, height: 1600 });
  assert.deepEqual(buildVariants(72, 48), [{ width: 72, height: 48, longSide: 72, targetBytes: 128 * 1024 }]);
  assert.deepEqual(buildVariants(640, 480), [
    { width: 480, height: 360, longSide: 480, targetBytes: 128 * 1024 },
    { width: 640, height: 480, longSide: 640, targetBytes: 256 * 1024 },
  ]);
  assert.deepEqual(buildVariants(1200, 1600).map(({ width, height }) => [width, height]), [[360, 480], [720, 960], [1200, 1600]]);
});
