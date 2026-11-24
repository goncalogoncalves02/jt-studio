const imageChunks = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);

export function isStaticUploadWebp(bytes) {
  const fourCC = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 20 || fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) return false;
  let cursor = 12;
  let count = 0;
  let extended = false;
  let primary = 0;
  let alpha = false;
  while (cursor < bytes.byteLength) {
    if (++count > 32 || bytes.byteLength - cursor < 8) return false;
    const type = fourCC(cursor);
    const length = view.getUint32(cursor + 4, true);
    const dataStart = cursor + 8;
    const paddedEnd = dataStart + length + (length % 2);
    if (paddedEnd > bytes.byteLength || !imageChunks.has(type)) return false;
    if (type === 'VP8X') {
      if (extended || cursor !== 12 || length !== 10 || (bytes[dataStart] & 0x2e) !== 0) return false;
      extended = true;
    } else if (type === 'ALPH') {
      if (alpha || primary > 0) return false;
      alpha = true;
    } else if (++primary > 1) return false;
    cursor = paddedEnd;
  }
  return primary === 1 && (!alpha || extended);
}
