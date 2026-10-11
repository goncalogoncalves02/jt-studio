import { INITIAL_QUALITY, MASTER_MAX_WIDTH, MIN_QUALITY, PIPELINE_VERSION, UPLOAD_MAX_BYTES, VARIANT_WIDTHS, assertDimensions } from './media-contract.js';
import { validateInputImage } from './image-processing.js';

const TARGET_BYTES = [128 * 1024, 256 * 1024, 512 * 1024];
let active = true;

function isWebP(blob) {
  return blob?.type === 'image/webp' && blob.size >= 12;
}

function hasWebPSignature(bytes) {
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
}

async function encode(canvas, quality, forceWasm) {
  if (!forceWasm && typeof canvas.convertToBlob === 'function') {
    const native = await canvas.convertToBlob({ type: 'image/webp', quality });
    const sig = new Uint8Array(await native.slice(0, 12).arrayBuffer());
    if (isWebP(native) && hasWebPSignature(sig)) return { blob: native, encoder: 'native' };
  }
  const { default: encodeWebP } = await import('@jsquash/webp/encode.js');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = await encodeWebP(imageData, { quality: Math.round(quality * 100) });
  const blob = new Blob([bytes], { type: 'image/webp' });
  const sig = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (!hasWebPSignature(sig)) throw new Error('O codificador não produziu um WebP válido.');
  return { blob, encoder: 'wasm' };
}

async function sourceBitmap(file, format) {
  if (format === 'heic' || format === 'heif') {
    const { heicTo } = await import('heic-to/next');
    // heic-to 1.6.6 returns the first top-level image as an ImageBitmap.
    return heicTo({ blob: file, type: 'bitmap' });
  }
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

async function digest(blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function run(file, forceWasm) {
  let bitmap;
  try {
    const info = await validateInputImage(file);
    postMessage({ type: 'progress', value: { stage: 'decode', format: info.format } });
    bitmap = await sourceBitmap(file, info.format);
    const width = bitmap.width; const height = bitmap.height;
    assertDimensions(width, height);
    const scale = Math.min(1, MASTER_MAX_WIDTH / width);
    const masterWidth = Math.max(1, Math.round(width * scale));
    const masterHeight = Math.max(1, Math.round(height * scale));
    const master = new OffscreenCanvas(masterWidth, masterHeight);
    const context = master.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0, masterWidth, masterHeight);
    bitmap.close(); bitmap = null;
    const variants = [];
    let encoder = 'native';
    for (let index = 0; index < VARIANT_WIDTHS.length; index += 1) {
      const outputWidth = Math.min(VARIANT_WIDTHS[index], masterWidth);
      const outputHeight = Math.max(1, Math.round(masterHeight * outputWidth / masterWidth));
      const canvas = new OffscreenCanvas(outputWidth, outputHeight);
      canvas.getContext('2d', { alpha: true }).drawImage(master, 0, 0, outputWidth, outputHeight);
      let quality = INITIAL_QUALITY;
      let encoded = await encode(canvas, quality, forceWasm);
      const targetBytes = TARGET_BYTES[index];
      while (encoded.blob.size > targetBytes && quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, Math.round((quality - 0.02) * 100) / 100);
        encoded = await encode(canvas, quality, forceWasm);
      }
      encoder = encoded.encoder;
      if (encoded.blob.size > UPLOAD_MAX_BYTES) throw new Error('Uma das versões da imagem excede o limite de envio de 1 MiB.');
      variants.push({ blob: encoded.blob, width: canvas.width, height: canvas.height, size: encoded.blob.size, sha256: await digest(encoded.blob), quality, targetBytes, withinTarget: encoded.blob.size <= targetBytes });
      postMessage({ type: 'progress', value: { stage: 'encode', completed: index + 1, total: VARIANT_WIDTHS.length } });
      canvas.width = 1; canvas.height = 1;
    }
    master.width = 1; master.height = 1;
    return { pipelineVersion: PIPELINE_VERSION, width, height, encoder, variants };
  } finally {
    bitmap?.close();
  }
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'process') return;
  active = true;
  try {
    const result = await run(data.file, data.encoder === 'wasm');
    if (active) postMessage({ type: 'result', result });
  } catch (error) {
    if (active) postMessage({ type: 'error', message: error instanceof Error ? error.message : 'O processamento da imagem falhou.' });
  }
};

self.onmessageerror = () => { active = false; };
