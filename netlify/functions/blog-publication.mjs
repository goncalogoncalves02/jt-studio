import { BlogAuthError, requireAdmin } from '../../server/blog/auth.mjs';
import { BlogPublicationError, createPublicationService } from '../../server/blog/publication.mjs';
import { createBoundedFetch, readBlogConfig } from '../../server/blog/config.mjs';

export const config = { path: '/api/admin/publication/*', method: ['GET', 'POST'] };

const MAX_BODY_BYTES = 4096;
const REQUEST_DEADLINE_MS = 48_000;
const HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function safeError(error) {
  if (error instanceof BlogAuthError || error instanceof BlogPublicationError) {
    return json(error.status, { error: { code: error.code ?? 'BLOG_AUTH_REQUIRED', message: error.message } });
  }
  return json(503, { error: { code: 'BLOG_SERVICE_UNAVAILABLE', message: 'The publication service is temporarily unavailable.' } });
}

function createRequestDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Publication request deadline elapsed', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function readJson(request, signal) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new BlogPublicationError(413, 'BLOG_BODY_TOO_LARGE', 'The publication request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
  const chunks = [];
  let size = 0;
  const cancelOnAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  if (signal?.aborted) cancelOnAbort();
  else signal?.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BlogPublicationError(413, 'BLOG_BODY_TOO_LARGE', 'The publication request is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Publication request deadline elapsed', 'TimeoutError');
  try {
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-body');
    return body;
  } catch { throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT'); }
}

function exactKeys(value, expected) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export default async function blogPublication(request) {
  const deadline = createRequestDeadline(REQUEST_DEADLINE_MS);
  try {
    const config = readBlogConfig();
    const url = new URL(request.url);
    const auth = await requireAdmin(request, request.method === 'POST' ? {
      mutation: true,
      csrfToken: request.headers.get('x-csrf-token'),
    } : {}, { config, deadlineSignal: deadline.signal });
    const service = createPublicationService({
      rpc: (name, args) => auth.serviceClient.rpc(name, args),
      hookUrl: process.env.BLOG_PUBLICATION_HOOK_URL,
      fetchImpl: createBoundedFetch(12_000, fetch, deadline.signal),
      deadlineSignal: deadline.signal,
    });
    const route = url.pathname;

    if (request.method === 'GET' && route === '/api/admin/publication/summary') {
      return json(200, await service.preparePublication(auth));
    }
    if (request.method === 'GET' && route === '/api/admin/publication/status') {
      return json(200, await service.statusPublication(auth, { requestId: url.searchParams.get('requestId') }));
    }
    if (request.method !== 'POST') return json(405, { error: { code: 'BLOG_METHOD_NOT_ALLOWED', message: 'The publication method is not supported.' } }, { allow: 'GET, POST' });

    const body = await readJson(request, deadline.signal);
    if (route === '/api/admin/publication/confirm') {
      if (!exactKeys(body, ['requestId', 'expectedDigest'])) throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
      return json(200, await service.confirmPublication(auth, body));
    }
    if (route === '/api/admin/publication/progress') {
      if (!exactKeys(body, ['requestId'])) throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
      return json(200, await service.advancePublication(auth, body));
    }
    if (route === '/api/admin/publication/retry') {
      if (!exactKeys(body, ['requestId', 'retryId'])) throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
      return json(200, await service.retryPublication(auth, body));
    }
    return json(404, { error: { code: 'BLOG_NOT_FOUND', message: 'The publication route was not found.' } });
  } catch (error) { return safeError(error); }
  finally { deadline.clear(); }
}
