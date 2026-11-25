import { INITIAL_QUALITY, MIN_QUALITY, PIPELINE_VERSION, UPLOAD_MAX_BYTES, MediaPipelineError, assertDimensions, buildVariantDimensions, getMasterDimensions } from './media-contract.js';
import { validateInputImage } from './media-header.js';
import { isStaticUploadWebp } from './webp-upload.js';

let active = true;

async function encode(canvas, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    try {
      const native = await canvas.convertToBlob({ type: 'image/webp', quality });
      if (native?.type === 'image/webp' && isStaticUploadWebp(new Uint8Array(await native.arrayBuffer()))) return { blob: native, encoder: 'native' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      /* A rejected native encoder gets the same local WASM fallback as an invalid MIME/signature. */
    }
  }
  const { default: encodeWebP } = await import('@jsquash/webp/encode.js');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = await encodeWebP(imageData, { quality: Math.round(quality * 100) });
  const blob = new Blob([bytes], { type: 'image/webp' });
  if (!isStaticUploadWebp(new Uint8Array(bytes))) throw new MediaPipelineError('O codificador não produziu um WebP válido.');
  return { blob, encoder: 'wasm' };
}

async function sourceBitmap(file, format) {
  try {
    if (format === 'heic' || format === 'heif') {
      const { decodePrimaryHeif } = await import('./codecs/heif-codec.js');
      return await decodePrimaryHeif(file);
    }
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new MediaPipelineError('A imagem está incompleta ou não pôde ser descodificada. Confirme o ficheiro e tente novamente.');
  }
}

async function digest(blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function run(file) {
  let bitmap;
  try {
    const info = await validateInputImage(file);
    postMessage({ type: 'progress', value: { stage: 'decode', format: info.format } });
    bitmap = await sourceBitmap(file, info.format);
    const width = bitmap.width; const height = bitmap.height;
    assertDimensions(width, height);
    const { width: masterWidth, height: masterHeight } = getMasterDimensions(width, height);
    const master = new OffscreenCanvas(masterWidth, masterHeight);
    const context = master.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0, masterWidth, masterHeight);
    bitmap.close(); bitmap = null;
    const variants = [];
    let encoder = 'native';
    const variantDimensions = buildVariantDimensions(masterWidth, masterHeight);
    for (let index = 0; index < variantDimensions.length; index += 1) {
      const { width: outputWidth, height: outputHeight, targetBytes } = variantDimensions[index];
      const canvas = new OffscreenCanvas(outputWidth, outputHeight);
      canvas.getContext('2d', { alpha: true }).drawImage(master, 0, 0, outputWidth, outputHeight);
      let quality = INITIAL_QUALITY;
      let encoded = await encode(canvas, quality);
      while (encoded.blob.size > targetBytes && quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, Math.round((quality - 0.02) * 100) / 100);
        encoded = await encode(canvas, quality);
      }
      encoder = encoded.encoder;
      if (encoded.blob.size > UPLOAD_MAX_BYTES) throw new MediaPipelineError('Uma das versões da imagem excede o limite de envio de 1 MiB.');
      variants.push({ blob: encoded.blob, width: canvas.width, height: canvas.height, size: encoded.blob.size, sha256: await digest(encoded.blob), quality, targetBytes, withinTarget: encoded.blob.size <= targetBytes });
      postMessage({ type: 'progress', value: { stage: 'encode', completed: index + 1, total: variantDimensions.length } });
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
    const result = await run(data.file);
    if (active) postMessage({ type: 'result', result });
  } catch (error) {
    if (active) postMessage({
      type: 'error',
      name: error?.name === 'AbortError' ? 'AbortError' : undefined,
      message: error?.name === 'AbortError' ? 'Processamento cancelado.' : error instanceof MediaPipelineError ? error.message : 'Não foi possível processar esta imagem. Confirme o ficheiro e tente novamente.',
    });
  }
};

self.onmessageerror = () => { active = false; };
