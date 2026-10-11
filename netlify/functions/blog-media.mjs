import { BlogAuthError, requireAdmin } from '../../server/blog/auth.mjs';
import { CsrfError } from '../../server/blog/csrf.mjs';
import { completeMedia, BlogMediaError, readPrivateVariant, uploadVariant } from '../../server/blog/media.mjs';
import { readBlogConfig } from '../../server/blog/config.mjs';

export const config = { path: '/api/admin/media/*', method: ['GET', 'POST'] };

const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function publicError(error) {
  if (error instanceof BlogAuthError || error instanceof CsrfError || error instanceof BlogMediaError) {
    return json(error.status, { error: { code: error.code ?? 'BLOG_MEDIA_UNAVAILABLE', message: error.message } });
  }
  return json(503, { error: { code: 'BLOG_SERVICE_UNAVAILABLE', message: 'The admin service is temporarily unavailable.' } });
}

async function readBytes(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new BlogMediaError(413, 'BLOG_BODY_TOO_LARGE', 'The image upload is larger than one MiB.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BlogMediaError(400, 'BLOG_MEDIA_INVALID', 'The image upload is invalid.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new BlogMediaError(413, 'BLOG_BODY_TOO_LARGE', 'The image upload is larger than one MiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const bytes = await readBytes(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-json');
    return value;
  } catch { throw new BlogMediaError(400, 'BLOG_MEDIA_INVALID', 'The media request is invalid.'); }
}

function positiveInteger(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export default async function blogMedia(request) {
  try {
    const config = readBlogConfig();
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/admin/media/preview') {
      const auth = await requireAdmin(request, {}, { config });
      const image = await readPrivateVariant(auth, url.searchParams.get('mediaId'), positiveInteger(url.searchParams.get('width')));
      return new Response(image.body, { status: image.status, headers: { ...HEADERS, ...Object.fromEntries(image.headers) } });
    }
    if (request.method !== 'POST') return json(405, { error: { code: 'BLOG_METHOD_NOT_ALLOWED', message: 'The media method is not supported.' } }, { allow: 'GET, POST' });
    if (url.pathname === '/api/admin/media/upload') {
      const auth = await requireAdmin(request, {
        mutation: true,
        mutationContentType: 'image/webp',
        csrfToken: request.headers.get('x-csrf-token'),
      }, { config });
      if (request.headers.get('content-type') !== 'image/webp') throw new BlogMediaError(400, 'BLOG_MEDIA_INVALID', 'The image must be uploaded as WebP.');
      const mediaId = url.searchParams.get('mediaId');
      const width = positiveInteger(url.searchParams.get('width'));
      const height = positiveInteger(url.searchParams.get('height'));
      const bytes = await readBytes(request, MAX_UPLOAD_BYTES);
      const variant = await uploadVariant(auth, mediaId, { width, height }, bytes, { contentType: request.headers.get('content-type') });
      return json(200, { variant });
    }
    if (url.pathname === '/api/admin/media/complete') {
      const auth = await requireAdmin(request, { mutation: true, csrfToken: request.headers.get('x-csrf-token') }, { config });
      const body = await readJson(request);
      const group = await completeMedia(auth, body.mediaId);
      return json(200, { media: group });
    }
    return json(404, { error: { code: 'BLOG_NOT_FOUND', message: 'The media route was not found.' } });
  } catch (error) { return publicError(error); }
}
