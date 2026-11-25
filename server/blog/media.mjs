import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

import { isStaticUploadWebp } from '../../src/blog/webp-upload.js';

const PRIVATE_BUCKET = 'blog-drafts';
const PUBLIC_BUCKET = 'blog-public';
const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 1600;
const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_PATTERN = ID_PATTERN;
const PUBLIC_ORIGIN_PATH = '/storage/v1/object/public/blog-public/';

export class BlogMediaError extends Error {
  constructor(status, code, message = 'The media operation could not be completed.') {
    super(message);
    this.name = 'BlogMediaError';
    this.status = status;
    this.code = code;
  }
}

function invalidMedia() { return new BlogMediaError(400, 'BLOG_MEDIA_INVALID', 'The image must be a valid static WebP variant.'); }
function mediaConflict() { return new BlogMediaError(409, 'BLOG_MEDIA_CONFLICT', 'This media variant is immutable and already has different bytes.'); }
function storageUnavailable() { return new BlogMediaError(503, 'BLOG_MEDIA_UNAVAILABLE'); }

function assertMediaId(mediaId) {
  if (typeof mediaId !== 'string' || !ID_PATTERN.test(mediaId)) throw invalidMedia();
  return mediaId.toLowerCase();
}

function assertAuth(auth) {
  if (!auth || !auth.userSdk || !auth.serviceClient || !UUID_PATTERN.test(auth.userId ?? '')
      || !UUID_PATTERN.test(auth.sessionId ?? '') || !Number.isSafeInteger(auth.generation) || auth.generation < 1) {
    throw new BlogMediaError(401, 'BLOG_AUTH_REQUIRED', 'Sign in to continue.');
  }
  return auth;
}

export async function validateWebpVariant(bytes, { width: claimedWidth, height: claimedHeight, contentType } = {}) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength < 20 || bytes.byteLength > MAX_BYTES
      || (contentType !== undefined && contentType !== 'image/webp')) throw invalidMedia();
  const original = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isStaticUploadWebp(original)) throw invalidMedia();
  let metadata;
  try {
    metadata = await sharp(original, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true }).metadata();
  } catch { throw invalidMedia(); }
  if (metadata.format !== 'webp' || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
      || metadata.width < 1 || metadata.height < 1 || Math.max(metadata.width, metadata.height) > MAX_SIDE
      || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1
      || metadata.exif || metadata.xmp || metadata.iptc || metadata.icc
      || (claimedWidth !== undefined && claimedWidth !== metadata.width)
      || (claimedHeight !== undefined && claimedHeight !== metadata.height)) throw invalidMedia();
  try {
    await sharp(original, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true }).stats();
  } catch { throw invalidMedia(); }
  const sha256 = createHash('sha256').update(original).digest('hex');
  return Object.freeze({
    width: metadata.width,
    height: metadata.height,
    mime: 'image/webp',
    byteLength: original.byteLength,
    sha256,
    bytes: Buffer.from(original),
  });
}

function privateKey(ownerId, mediaId, width) { return `draft/${ownerId}/${mediaId}/${width}.webp`; }
function publicKey(mediaId, width, sha256) { return `public/${mediaId}/${width}-${sha256}.webp`; }

function expectedWidths(variants) {
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 3) throw invalidMedia();
  const max = variants.at(-1)?.width;
  if (!Number.isInteger(max) || max < 1 || max > MAX_SIDE) throw invalidMedia();
  return [...new Set([Math.min(480, max), Math.min(960, max), max])].sort((a, b) => a - b);
}

function assertCompleteVariants(variants) {
  const widths = expectedWidths(variants);
  const actual = variants.map((variant) => variant.width);
  if (new Set(actual).size !== actual.length || actual.some((width, index) => width !== widths[index])) throw invalidMedia();
  const widest = variants.at(-1);
  for (const variant of variants) {
    const expectedHeight = Math.max(1, Math.round(widest.height * variant.width / widest.width));
    if (variant.height !== expectedHeight) throw invalidMedia();
  }
  return variants;
}

function serviceMutation(auth, name, parameters) {
  return auth.serviceClient.rpc(name, {
    p_user_id: auth.userId,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
    ...parameters,
  });
}

function mapRpcError(error) {
  if (error?.code === '42501') return new BlogMediaError(403, 'BLOG_FORBIDDEN', 'The media operation is not authorized.');
  if (error?.code === '23505' || error?.code === '40001') return mediaConflict();
  if (error?.code === '22023' || error?.code === '23514') return invalidMedia();
  return storageUnavailable();
}

async function storageDownload(client, bucket, key) {
  const { data, error } = await client.storage.from(bucket).download(key);
  if (error) throw storageUnavailable();
  return Buffer.from(await data.arrayBuffer());
}

async function uploadImmutable(client, bucket, key, bytes) {
  const { error } = await client.storage.from(bucket).upload(key, bytes, { contentType: 'image/webp', upsert: false });
  if (!error) return;
  try {
    const existing = await storageDownload(client, bucket, key);
    if (existing.length !== bytes.length || !existing.equals(bytes)) throw mediaConflict();
  } catch (downloadError) {
    if (downloadError instanceof BlogMediaError && downloadError.code === 'BLOG_MEDIA_CONFLICT') throw downloadError;
    throw storageUnavailable();
  }
}

export async function uploadVariant(auth, mediaId, variant, bytes, options = {}) {
  assertAuth(auth);
  const id = assertMediaId(mediaId);
  const validated = await validateWebpVariant(bytes, {
    width: variant?.width,
    height: variant?.height,
    contentType: options.contentType,
  });
  const privateObjectKey = privateKey(auth.userId, id, validated.width);
  const manifest = {
    width: validated.width,
    height: validated.height,
    mime: validated.mime,
    byteLength: validated.byteLength,
    sha256: validated.sha256,
    objectKey: publicKey(id, validated.width, validated.sha256),
  };
  try {
    await uploadImmutable(auth.userSdk, PRIVATE_BUCKET, privateObjectKey, validated.bytes);
    const { data, error } = await serviceMutation(auth, 'blog_media_record_variant', {
      p_media_id: id,
      p_variant: manifest,
    });
    if (error || data !== true) throw mapRpcError(error);
  } catch (error) {
    if (error instanceof BlogMediaError) throw error;
    throw storageUnavailable();
  }
  return Object.freeze({ id, ...manifest });
}

export async function completeMedia(auth, mediaId) {
  assertAuth(auth);
  const id = assertMediaId(mediaId);
  const { data, error } = await serviceMutation(auth, 'blog_media_complete', { p_media_id: id });
  if (error || !data || data.id !== id || data.state !== 'complete' || !Array.isArray(data.variants)) throw mapRpcError(error);
  assertCompleteVariants(data.variants);
  return data;
}

export async function readPrivateVariant(auth, mediaId, width) {
  assertAuth(auth);
  const id = assertMediaId(mediaId);
  if (!Number.isInteger(width) || width < 1 || width > MAX_SIDE) throw invalidMedia();
  const { data, error } = await auth.userSdk.from('blog_media').select('state,variants').eq('id', id).maybeSingle();
  if (error || data?.state !== 'complete' || !Array.isArray(data.variants)) throw new BlogMediaError(404, 'BLOG_MEDIA_NOT_FOUND', 'The private image was not found.');
  const variant = data.variants.find((candidate) => candidate?.width === width);
  if (!variant) throw new BlogMediaError(404, 'BLOG_MEDIA_NOT_FOUND', 'The private image was not found.');
  const bytes = await storageDownload(auth.userSdk, PRIVATE_BUCKET, privateKey(auth.userId, id, width));
  const validated = await validateWebpVariant(bytes, { width: variant.width, height: variant.height, contentType: variant.mime });
  if (validated.sha256 !== variant.sha256 || validated.byteLength !== variant.byteLength) throw storageUnavailable();
  const { data: revalidated, error: revalidationError } = await auth.serviceClient.rpc('blog_media_revalidate_session', {
    p_user_id: auth.userId,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  });
  if (revalidationError || revalidated !== true) throw mapRpcError(revalidationError ?? { code: '42501' });
  return new Response(validated.bytes, { status: 200, headers: {
    'content-type': 'image/webp',
    'content-length': String(validated.byteLength),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  } });
}

function publicObjectUrl(auth, key) {
  const url = new URL(PUBLIC_ORIGIN_PATH, auth.config.supabaseUrl);
  url.pathname += key.split('/').map(encodeURIComponent).join('/');
  return url.toString();
}

export async function promoteMedia(auth, mediaIds) {
  assertAuth(auth);
  if (!Array.isArray(mediaIds) || mediaIds.length < 1 || mediaIds.length > 100
      || mediaIds.some((id) => !ID_PATTERN.test(id)) || new Set(mediaIds).size !== mediaIds.length) throw invalidMedia();
  const ids = mediaIds.map((id) => id.toLowerCase());
  const { data, error } = await serviceMutation(auth, 'blog_media_promotion_manifest', { p_media_ids: ids });
  if (error || !Array.isArray(data)) throw mapRpcError(error);
  const byId = new Map(ids.map((id) => [id, []]));
  for (const entry of data) {
    if (!byId.has(entry?.id) || entry.owner_id !== auth.userId || entry.state !== 'complete' || !Array.isArray(entry.variants)) throw storageUnavailable();
    assertCompleteVariants(entry.variants);
    for (const variant of entry.variants) {
      const privateObjectKey = privateKey(auth.userId, entry.id, variant.width);
      const bytes = await storageDownload(auth.serviceClient, PRIVATE_BUCKET, privateObjectKey);
      const validated = await validateWebpVariant(bytes, { width: variant.width, height: variant.height, contentType: variant.mime });
      if (validated.sha256 !== variant.sha256 || validated.byteLength !== variant.byteLength
          || variant.objectKey !== publicKey(entry.id, variant.width, variant.sha256)) throw storageUnavailable();
      await uploadImmutable(auth.serviceClient, PUBLIC_BUCKET, variant.objectKey, validated.bytes);
      byId.get(entry.id).push({ ...variant, url: publicObjectUrl(auth, variant.objectKey) });
    }
  }
  if (byId.size !== data.length) throw new BlogMediaError(403, 'BLOG_MEDIA_NOT_CONFIRMED', 'Only images included in a confirmed release can be promoted.');
  return Object.fromEntries([...byId].map(([id, variants]) => [id, variants.sort((a, b) => a.width - b.width)]));
}

export function newMediaId() { return randomUUID(); }

export async function promotePublicationVariant(auth, { requestId, mediaId, width } = {}) {
  assertAuth(auth);
  if (!UUID_PATTERN.test(auth.authSessionId ?? '')) throw new BlogMediaError(401, 'BLOG_AUTH_REQUIRED');
  const publicationMutation = (name, parameters) => auth.serviceClient.rpc(name, {
    p_user_id: auth.userId, p_session_id: auth.sessionId, p_auth_session_id: auth.authSessionId,
    p_generation: auth.generation, ...parameters,
  });
  const request = assertMediaId(requestId);
  const id = assertMediaId(mediaId);
  if (!Number.isInteger(width) || width < 1 || width > MAX_SIDE) throw invalidMedia();
  const assertWithinDeadline = () => {
    if (auth.deadlineSignal?.aborted) throw auth.deadlineSignal.reason ?? new DOMException('Publication request deadline elapsed', 'TimeoutError');
  };

  assertWithinDeadline();
  const manifestResult = await publicationMutation('blog_publication_variant_manifest', {
    p_request_id: request,
    p_media_id: id,
    p_width: width,
  });
  const manifest = manifestResult?.data;
  if (manifestResult?.error || !manifest || manifest.requestId !== request || manifest.mediaId !== id
      || manifest.ownerId !== auth.userId || !UUID_PATTERN.test(manifest.releaseId ?? '') || manifest.width !== width || manifest.mime !== 'image/webp'
      || !Number.isInteger(manifest.height) || !Number.isSafeInteger(manifest.byteLength)
      || manifest.byteLength < 1 || manifest.byteLength > MAX_BYTES
      || !/^[a-f0-9]{64}$/u.test(manifest.sha256 ?? '')
      || manifest.objectKey !== publicKey(id, width, manifest.sha256)) throw mapRpcError(manifestResult?.error);
  assertWithinDeadline();

  const sourceKey = privateKey(auth.userId, id, width);
  const bytes = await storageDownload(auth.serviceClient, PRIVATE_BUCKET, sourceKey);
  assertWithinDeadline();
  const validated = await validateWebpVariant(bytes, {
    width: manifest.width,
    height: manifest.height,
    contentType: manifest.mime,
  });
  if (validated.sha256 !== manifest.sha256 || validated.byteLength !== manifest.byteLength) throw storageUnavailable();

  // Revalidate the captured session, active request, and immutable manifest after the download and before Storage writes.
  const beforeUpload = await publicationMutation('blog_publication_variant_manifest', {
    p_request_id: request,
    p_media_id: id,
    p_width: width,
  });
  if (beforeUpload?.error || JSON.stringify(beforeUpload?.data) !== JSON.stringify(manifest)) {
    throw mapRpcError(beforeUpload?.error ?? { code: '42501' });
  }
  assertWithinDeadline();
  await uploadImmutable(auth.serviceClient, PUBLIC_BUCKET, manifest.objectKey, validated.bytes);
  assertWithinDeadline();

  const recorded = await publicationMutation('blog_publication_record_variant', {
    p_request_id: request,
    p_media_id: id,
    p_width: width,
    p_object_key: manifest.objectKey,
    p_sha256: validated.sha256,
    p_byte_length: validated.byteLength,
  });
  if (recorded?.error || !recorded?.data || recorded.data.requestId !== request
      || recorded.data.releaseId !== manifest.releaseId || recorded.data.state !== 'promoting') {
    throw mapRpcError(recorded?.error ?? { code: '42501' });
  }
  assertWithinDeadline();
  return Object.freeze({
    mediaId: id,
    width,
    url: publicObjectUrl(auth, manifest.objectKey),
  });
}
