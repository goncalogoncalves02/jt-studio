export const MAX_INPUT_BYTES = 30 * 1024 * 1024;
export const MAX_DIMENSION = 12_000;
export const MAX_PIXELS = 60_000_000;
export const MASTER_MAX_LONG_SIDE = 1600;
export const VARIANT_LONG_SIDES = Object.freeze([480, 960, 1600]);
export const INITIAL_QUALITY = 0.84;
export const MIN_QUALITY = 0.78;
export const UPLOAD_MAX_BYTES = 1024 * 1024;
export const PIPELINE_VERSION = 1;

export class MediaPipelineError extends Error {
  constructor(message) { super(message); this.name = 'MediaPipelineError'; }
}

export function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new MediaPipelineError('Não foi possível ler as dimensões da imagem.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new MediaPipelineError('A imagem excede o limite de 12 000 px ou 60 megapíxeis.');
  }
  return { width, height };
}

export function getMasterDimensions(width, height) {
  assertDimensions(width, height);
  const longSide = Math.max(width, height);
  const scale = Math.min(1, MASTER_MAX_LONG_SIDE / longSide);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function buildVariantDimensions(width, height) {
  assertDimensions(width, height);
  const longSide = Math.max(width, height);
  const candidates = VARIANT_LONG_SIDES.map((requestedLongSide) => Math.min(requestedLongSide, longSide));
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const scale = candidate / longSide;
    const size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), longSide: candidate };
    const key = `${size.width}x${size.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(size);
  }
  return unique.map((size, index) => ({ ...size, targetBytes: [128 * 1024, 256 * 1024, 512 * 1024][index] }));
}
