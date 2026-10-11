import { MAX_INPUT_BYTES, assertDimensions } from './media-contract.js';

const brands = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function jpegDimensions(b) {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p += 1; continue; }
    while (b[p] === 0xff) p += 1;
    const marker = b[p++];
    if (marker === 0xd9 || marker === 0xda) break;
    if ([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) continue;
    const length = (b[p] << 8) | b[p + 1];
    if (length < 2 || p + length > b.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (b[p + 3] << 8) | b[p + 4], width: (b[p + 5] << 8) | b[p + 6] };
    }
    p += length;
  }
  return null;
}

function webpDimensions(b) {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8X') return { width: 1 + b[24] + (b[25] << 8) + (b[26] << 16), height: 1 + b[27] + (b[28] << 8) + (b[29] << 16) };
  if (kind === 'VP8 ' && b.length >= 30) return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  if (kind === 'VP8L' && b.length >= 25) return { width: 1 + b[21] + ((b[22] & 0x3f) << 8), height: 1 + (b[22] >> 6) + (b[23] << 2) + ((b[24] & 0x0f) << 10) };
  return null;
}

function isoBmff(b) {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return null;
  const size = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (size < 16 || size > b.length) return null;
  const major = ascii(b, 8, 4);
  const found = [major];
  for (let p = 16; p + 4 <= size; p += 4) {
    const brand = ascii(b, p, 4);
    if (brands.has(brand)) found.push(brand);
  }
  if (!found.length) return null;
  let dims = null;
  for (let i = 0; i + 20 <= b.length; i += 1) {
    if (ascii(b, i + 4, 4) === 'ispe') {
      const view = new DataView(b.buffer, b.byteOffset + i, b.byteLength - i);
      dims = { width: view.getUint32(12), height: view.getUint32(16) };
      if (dims.width && dims.height) break;
    }
  }
  const format = major === 'avif' || major === 'avis' || (found.includes('avif') || found.includes('avis')) ? 'avif'
    : major === 'heic' || major === 'heix' || major === 'hevc' || major === 'hevx' ? 'heic'
      : HEIF_BRANDS.has(major) || found.some((x) => HEIF_BRANDS.has(x)) ? 'heif' : null;
  return format ? { format, ...dims } : null;
}

export async function validateInputImage(file) {
  if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw new Error('Escolha um ficheiro de imagem válido.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('O ficheiro excede o limite de 30 MiB.');
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  let format, dimensions;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    format = 'png'; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    format = 'jpeg'; dimensions = jpegDimensions(bytes);
  } else {
    const webp = webpDimensions(bytes);
    if (webp) { format = 'webp'; dimensions = webp; }
    else {
      const iso = isoBmff(bytes);
      if (iso) ({ format, ...dimensions } = iso);
    }
  }
  if (!format) throw new Error('Formato de imagem não suportado ou ficheiro inválido.');
  if (!dimensions?.width || !dimensions?.height) throw new Error('Não foi possível ler as dimensões da imagem.');
  return { format, ...assertDimensions(dimensions.width, dimensions.height), size: file.size };
}

export function optimizeImage(file, options = {}) {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(new DOMException('Processamento cancelado.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.terminate();
      fn(value);
    };
    const abort = () => finish(reject, new DOMException('Processamento cancelado.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') { try { onProgress?.(data.value); } catch { /* UI callbacks do not own the worker lifecycle. */ } }
      else if (data.type === 'result') finish(resolve, data.result);
      else if (data.type === 'error') finish(reject, new Error(data.message));
    };
    worker.onerror = () => finish(reject, new Error('O processamento da imagem falhou. Tente novamente.'));
    worker.postMessage({ type: 'process', file, encoder: options.encoder === 'wasm' ? 'wasm' : 'auto' });
  });
}
