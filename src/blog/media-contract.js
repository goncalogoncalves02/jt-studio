export const MAX_INPUT_BYTES = 30 * 1024 * 1024;
export const MAX_DIMENSION = 12_000;
export const MAX_PIXELS = 60_000_000;
export const MASTER_MAX_WIDTH = 1600;
export const VARIANT_WIDTHS = Object.freeze([480, 960, 1600]);
export const INITIAL_QUALITY = 0.84;
export const MIN_QUALITY = 0.78;
export const UPLOAD_MAX_BYTES = 1024 * 1024;
export const PIPELINE_VERSION = 1;

export function assertDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Não foi possível ler as dimensões da imagem.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('A imagem excede o limite de 12 000 px ou 60 megapíxeis.');
  }
  return { width, height };
}
