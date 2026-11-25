let decoderPromise;

async function decoder() {
  decoderPromise ??= import('./heif-decoder.js').then(({ default: createModule }) => createModule());
  return decoderPromise;
}

export async function getHeifCodecVersions() {
  const module = await decoder();
  const version = (prefix) => [0, 1, 2]
    .map((part) => module[`_${prefix}_${['major', 'minor', 'maintenance'][part]}`]())
    .join('.');
  return {
    libheif: version('task2_libheif_version'),
    libde265: version('task2_libde265_version'),
    maxImageSizePixels: module._task2_heif_context_image_pixel_limit(),
    decodeThreads: module._task2_heif_decode_thread_count(),
  };
}

export async function decodePrimaryHeif(file) {
  const module = await decoder();
  const input = new Uint8Array(await file.arrayBuffer());
  const inputPointer = module._malloc(input.byteLength);
  if (!inputPointer) throw new Error('HEIF decoder input allocation failed');
  module.HEAPU8.set(input, inputPointer);
  let framePointer = 0;
  try {
    framePointer = module._task2_decode_primary_heif(inputPointer, input.byteLength);
  } finally {
    module._free(inputPointer);
  }
  if (!framePointer) throw new Error('HEIF primary image decode failed');
  try {
    const header = framePointer >>> 2;
    const width = module.HEAPU32[header];
    const height = module.HEAPU32[header + 1];
    const byteLength = module.HEAPU32[header + 2];
    if (!width || !height || byteLength !== width * height * 4) throw new Error('Invalid HEIF decoder output');
    const pixelPointer = framePointer + 12;
    const pixels = module.HEAPU8.slice(pixelPointer, pixelPointer + byteLength);
    return await createImageBitmap(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height));
  } finally {
    module._free(framePointer);
  }
}
