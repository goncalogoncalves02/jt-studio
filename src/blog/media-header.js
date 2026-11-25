import { MAX_INPUT_BYTES, MediaPipelineError, assertDimensions } from './media-contract.js';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_BOXES = 4096;
const MAX_ITEMS = 10_000;
const MAX_ASSOCIATIONS_PER_ITEM = 128;

function text(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function fail() {
  throw new MediaPipelineError('Os metadados HEIF/AVIF estão inválidos, incompletos ou não identificam a imagem principal.');
}

function boxes(bytes, start, end, budget) {
  const results = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8 || --budget.count < 0) fail();
    let size = new DataView(bytes.buffer, bytes.byteOffset + cursor, end - cursor).getUint32(0);
    const type = text(bytes, cursor + 4, cursor + 8);
    let headerSize = 8;
    if (size === 1) {
      if (end - cursor < 16) fail();
      const large = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8).getBigUint64(0);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      size = Number(large); headerSize = 16;
    } else if (size === 0) size = end - cursor;
    if (size < headerSize || size > end - cursor) fail();
    results.push({ type, start: cursor, payload: cursor + headerSize, end: cursor + size, size, headerSize });
    cursor += size;
  }
  return results;
}

function fullBoxVersion(bytes, box) {
  if (box.end - box.payload < 4) fail();
  return { version: bytes[box.payload], flags: (bytes[box.payload + 1] << 16) | (bytes[box.payload + 2] << 8) | bytes[box.payload + 3], cursor: box.payload + 4 };
}

function readPitm(bytes, box) {
  const { version, cursor } = fullBoxVersion(bytes, box);
  if (version === 0 && box.end - cursor >= 2) return new DataView(bytes.buffer, bytes.byteOffset + cursor, 2).getUint16(0);
  if (version === 1 && box.end - cursor >= 4) return new DataView(bytes.buffer, bytes.byteOffset + cursor, 4).getUint32(0);
  return fail();
}

function parseItemInfo(bytes, box, budget) {
  const { version, cursor } = fullBoxVersion(bytes, box);
  const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, box.end - cursor);
  let count, childrenStart;
  if (version === 0) {
    if (view.byteLength < 2) return fail();
    count = view.getUint16(0); childrenStart = cursor + 2;
  } else if (version === 1) {
    if (view.byteLength < 4) return fail();
    count = view.getUint32(0); childrenStart = cursor + 4;
  } else return fail();
  if (count < 1 || count > MAX_ITEMS) fail();
  const entries = boxes(bytes, childrenStart, box.end, budget);
  if (entries.length !== count) fail();
  const map = new Map();
  for (const entry of entries) {
    if (entry.type !== 'infe') fail();
    const info = fullBoxVersion(bytes, entry);
    const view = new DataView(bytes.buffer, bytes.byteOffset + info.cursor, entry.end - info.cursor);
    let id;
    if (info.version === 2 && view.byteLength >= 8) id = view.getUint16(0);
    else if (info.version === 3 && view.byteLength >= 10) id = view.getUint32(0);
    else return fail();
    const type = text(bytes, info.cursor + (info.version === 2 ? 4 : 6), info.cursor + (info.version === 2 ? 8 : 10));
    if (id === 0 || map.has(id)) fail();
    map.set(id, type);
  }
  return map;
}

function parseProperty(bytes, box) {
  if (box.type === 'ispe') {
    const info = fullBoxVersion(bytes, box);
    if (box.end - info.cursor !== 8) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset + info.cursor, 8);
    const width = view.getUint32(0); const height = view.getUint32(4);
    if (!width || !height) fail();
    return { type: 'ispe', width, height };
  }
  if (box.type === 'irot' || box.type === 'imir') {
    if (box.end - box.payload !== 1) fail();
    return { type: box.type, value: bytes[box.payload] };
  }
  if (box.type === 'clap') {
    if (box.end - box.payload !== 32) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset + box.payload, 32);
    const apertureWidth = view.getUint32(0) / view.getUint32(4);
    const apertureHeight = view.getUint32(8) / view.getUint32(12);
    if (!Number.isFinite(apertureWidth) || !Number.isFinite(apertureHeight) || apertureWidth <= 0 || apertureHeight <= 0 || !view.getUint32(4) || !view.getUint32(12)) fail();
    return { type: 'clap', width: Math.ceil(apertureWidth), height: Math.ceil(apertureHeight) };
  }
  return { type: box.type };
}

function parseAssociations(bytes, box, propertyList, itemMap) {
  const { version, flags, cursor } = fullBoxVersion(bytes, box);
  if (version > 1) fail();
  const data = new DataView(bytes.buffer, bytes.byteOffset + cursor, box.end - cursor);
  if (data.byteLength < 4) fail();
  const count = data.getUint32(0); let offset = cursor + 4;
  if (count > MAX_ITEMS) fail();
  for (let i = 0; i < count; i += 1) {
    const idLength = version < 1 ? 2 : 4;
    if (box.end - offset < idLength + 1) fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, box.end - offset);
    const itemId = idLength === 2 ? view.getUint16(0) : view.getUint32(0); offset += idLength;
    const associationCount = bytes[offset++];
    if (associationCount > MAX_ASSOCIATIONS_PER_ITEM) fail();
    const associated = [];
    for (let j = 0; j < associationCount; j += 1) {
      const length = flags & 1 ? 2 : 1;
      if (box.end - offset < length) fail();
      const raw = length === 2 ? new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0) : bytes[offset];
      offset += length;
      const index = raw & (length === 2 ? 0x7fff : 0x7f);
      if (index === 0) continue;
      if (index > propertyList.length) fail();
      associated.push(propertyList[index - 1]);
    }
    if (!itemMap.has(itemId)) fail();
    if (itemMap.get(itemId).properties) fail();
    itemMap.get(itemId).properties = associated;
  }
  if (offset !== box.end) fail();
}

function parseHeifParts(bytes, top, topCount) {
  const budget = { count: MAX_BOXES - topCount };
  if (budget.count < 0) fail();
  const ftyps = top.filter((box) => box.type === 'ftyp');
  const metas = top.filter((box) => box.type === 'meta');
  if (ftyps.length > 1 || metas.length > 1) fail();
  const ftyp = ftyps[0];
  if (!ftyp || ftyp.end - ftyp.payload < 8) return null;
  if (ftyp.size > MAX_HEADER_BYTES) fail();
  if ((ftyp.end - ftyp.payload - 8) % 4 !== 0) fail();
  const major = text(bytes, ftyp.payload, ftyp.payload + 4);
  const compatible = [];
  for (let offset = ftyp.payload + 8; offset + 4 <= ftyp.end; offset += 4) compatible.push(text(bytes, offset, offset + 4));
  const brands = [major, ...compatible];
  const format = brands.some((brand) => AVIF_BRANDS.has(brand)) ? 'avif' : brands.some((brand) => HEIC_BRANDS.has(brand)) ? (['heic', 'heix', 'hevc', 'hevx'].includes(major) ? 'heic' : 'heif') : null;
  if (!format) return null;
  const meta = metas[0];
  if (!meta) fail();
  const metaInfo = fullBoxVersion(bytes, meta);
  if (metaInfo.version !== 0) fail();
  const children = boxes(bytes, metaInfo.cursor, meta.end, budget);
  const one = (type) => {
    const matches = children.filter((box) => box.type === type);
    if (matches.length !== 1) fail();
    return matches[0];
  };
  const primaryBox = one('pitm');
  const infoBox = one('iinf');
  const propertiesBox = one('iprp');
  const primaryId = readPitm(bytes, primaryBox);
  const itemTypes = parseItemInfo(bytes, infoBox, budget);
  if (!itemTypes.has(primaryId)) fail();
  const propertyChildren = boxes(bytes, propertiesBox.payload, propertiesBox.end, budget);
  const propertyContainers = propertyChildren.filter((box) => box.type === 'ipco');
  const propertyContainer = propertyContainers.length === 1 ? propertyContainers[0] : null;
  const associations = propertyChildren.filter((box) => box.type === 'ipma');
  if (!propertyContainer || !associations.length) fail();
  const propertyBoxes = boxes(bytes, propertyContainer.payload, propertyContainer.end, budget);
  const propertyList = propertyBoxes.map((box) => parseProperty(bytes, box));
  const itemMap = new Map([...itemTypes].map(([id, type]) => [id, { type, properties: null }]));
  for (const association of associations) parseAssociations(bytes, association, propertyList, itemMap);
  const imageItemTypes = new Set(['av01', 'hvc1', 'hev1', 'grid', 'iden', 'jpeg', 'unci']);
  for (const item of itemMap.values()) {
    if (!imageItemTypes.has(item.type)) continue;
    const dimensions = item.properties?.filter((property) => property.type === 'ispe') ?? [];
    if (dimensions.length !== 1) fail();
    // libheif decodes the declared primary image. Conservatively validate every
    // coded item so an unusually ordered secondary image cannot hide its bounds.
    assertDimensions(dimensions[0].width, dimensions[0].height);
  }
  const primaryProperties = itemMap.get(primaryId).properties;
  if (!primaryProperties) fail();
  const spatial = primaryProperties.filter((property) => property.type === 'ispe');
  const rotations = primaryProperties.filter((property) => property.type === 'irot');
  const mirrors = primaryProperties.filter((property) => property.type === 'imir');
  const crops = primaryProperties.filter((property) => property.type === 'clap');
  if (spatial.length !== 1 || rotations.length > 1 || mirrors.length > 1 || crops.length > 1) fail();
  const quarterTurns = rotations.length ? rotations[0].value & 0x03 : 0;
  const mirrorAxis = mirrors.length ? mirrors[0].value & 1 : null;
  const codedWidth = spatial[0].width; const codedHeight = spatial[0].height;
  const cropWidth = crops[0]?.width ?? codedWidth; const cropHeight = crops[0]?.height ?? codedHeight;
  if (cropWidth > codedWidth || cropHeight > codedHeight) fail();
  const width = quarterTurns % 2 ? cropHeight : cropWidth;
  const height = quarterTurns % 2 ? cropWidth : cropHeight;
  return { format, width, height, codedWidth, codedHeight, orientation: { quarterTurns, mirrorAxis, cleanAperture: Boolean(crops.length), primaryItemType: itemMap.get(primaryId).type } };
}

function parseHeif(bytes) {
  const budget = { count: MAX_BOXES };
  const top = [];
  let cursor = 0;
  while (cursor < bytes.length && budget.count > 0) {
    if (bytes.length - cursor < 8) fail();
    budget.count -= 1;
    let size = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.length - cursor).getUint32(0);
    const type = text(bytes, cursor + 4, cursor + 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.length - cursor < 16) fail();
      const large = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8).getBigUint64(0);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      size = Number(large); headerSize = 16;
    } else if (size === 0) size = bytes.length - cursor;
    if (size < headerSize) fail();
    if (size > bytes.length - cursor) fail();
    top.push({ type, start: cursor, payload: cursor + headerSize, end: cursor + size, size, headerSize });
    cursor += size;
  }
  if (cursor !== bytes.length || budget.count < 0) fail();
  return parseHeifParts(bytes, top, MAX_BOXES - budget.count);
}

async function readBox(file, offset, size) {
  const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
  if (bytes.length !== size) fail();
  return bytes;
}

async function parseHeifFile(file) {
  let cursor = 0; let count = 0; let ftypBytes; let metaBytes;
  const records = [];
  while (cursor < file.size) {
    if (file.size - cursor < 8 || ++count > MAX_BOXES) fail();
    const header = await readBox(file, cursor, 8);
    let size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
    const type = text(header, 4, 8); let headerSize = 8;
    if (size === 1) {
      if (file.size - cursor < 16) fail();
      const extended = await readBox(file, cursor + 8, 8);
      const large = new DataView(extended.buffer, extended.byteOffset, 8).getBigUint64(0);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      size = Number(large); headerSize = 16;
    } else if (size === 0) size = file.size - cursor;
    if (size < headerSize || size > file.size - cursor) fail();
    const record = { type, start: cursor, payload: cursor + headerSize, end: cursor + size, size, headerSize };
    if (type === 'ftyp') {
      if (ftypBytes || size > MAX_HEADER_BYTES) fail();
      ftypBytes = await readBox(file, cursor, size);
      records.push({ ...record, start: 0, payload: headerSize, end: size });
    } else if (type === 'meta') {
      if (metaBytes || size > MAX_HEADER_BYTES) fail();
      metaBytes = await readBox(file, cursor, size);
      records.push(record);
    }
    cursor += size;
  }
  if (cursor !== file.size || !ftypBytes) return null;
  const metaRecord = records.find((box) => box.type === 'meta');
  if (!metaRecord || !metaBytes) return parseHeifParts(ftypBytes, records.filter((box) => box.type === 'ftyp'), count);
  const bytes = new Uint8Array(ftypBytes.length + metaBytes.length);
  bytes.set(ftypBytes); bytes.set(metaBytes, ftypBytes.length);
  const localized = [
    { ...records.find((box) => box.type === 'ftyp'), start: 0, payload: records.find((box) => box.type === 'ftyp').headerSize, end: ftypBytes.length },
    { ...metaRecord, start: ftypBytes.length, payload: ftypBytes.length + metaRecord.headerSize, end: bytes.length },
  ];
  return parseHeifParts(bytes, localized, count);
}

function jpegHeader(bytes) {
  let cursor = 2; let dimensions = null; let orientation = 1;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor] !== 0xff) { cursor += 1; continue; }
    while (bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor++];
    if (marker === 0xd9 || marker === 0xda) break;
    if ([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) continue;
    if (cursor + 2 > bytes.length) break;
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) break;
    const payload = cursor + 2; const payloadEnd = cursor + length;
    if (marker === 0xe1 && text(bytes, payload, Math.min(payload + 6, payloadEnd)) === 'Exif\0\0') orientation = exifOrientation(bytes, payload + 6, payloadEnd);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && payloadEnd - payload >= 5) {
      dimensions = { height: (bytes[payload + 1] << 8) | bytes[payload + 2], width: (bytes[payload + 3] << 8) | bytes[payload + 4] };
    }
    cursor += length;
  }
  if (!dimensions) return null;
  const swap = orientation >= 5 && orientation <= 8;
  return { width: swap ? dimensions.height : dimensions.width, height: swap ? dimensions.width : dimensions.height, orientation: { exif: orientation } };
}

function exifOrientation(bytes, start, end) {
  if (end - start < 8) return 1;
  const little = text(bytes, start, start + 2) === 'II';
  if (!little && text(bytes, start, start + 2) !== 'MM') return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16at = (offset) => view.getUint16(offset, little);
  const u32at = (offset) => view.getUint32(offset, little);
  if (u16at(start + 2) !== 42) return 1;
  const ifd = start + u32at(start + 4);
  if (ifd + 2 > end) return 1;
  const count = Math.min(u16at(ifd), 256);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16at(entry) === 0x0112 && u16at(entry + 2) === 3 && u32at(entry + 4) === 1) {
      const value = u16at(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

export function parseImageHeader(bytes) {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? jpegHeader(bytes) : null;
  if (jpeg) return { format: 'jpeg', ...jpeg };
  if (bytes.length >= 24 && bytes[0] === 137 && text(bytes, 1, 4) === 'PNG' && text(bytes, 12, 16) === 'IHDR') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 30 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 12) === 'WEBP') {
    const kind = text(bytes, 12, 16);
    if (kind === 'VP8X') return { format: 'webp', width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (kind === 'VP8 ' && bytes.length >= 30) return { format: 'webp', width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    if (kind === 'VP8L' && bytes.length >= 25) return { format: 'webp', width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10) };
  }
  if (bytes.length >= 16 && text(bytes, 4, 8) === 'ftyp') return parseHeif(bytes);
  return null;
}

export async function validateInputImage(file) {
  if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw new MediaPipelineError('Escolha um ficheiro de imagem válido.');
  if (file.size > MAX_INPUT_BYTES) throw new MediaPipelineError('O ficheiro excede o limite de 30 MiB.');
  const prefix = await readBox(file, 0, Math.min(file.size, 16));
  const isIsoBmff = prefix.length >= 8 && text(prefix, 4, 8) === 'ftyp';
  const parsed = isIsoBmff
    ? await parseHeifFile(file)
    : parseImageHeader(new Uint8Array(await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer()));
  if (!parsed) throw new MediaPipelineError('Formato de imagem não suportado ou ficheiro inválido.');
  const { width, height } = assertDimensions(parsed.width, parsed.height);
  return { ...parsed, width, height, size: file.size };
}
