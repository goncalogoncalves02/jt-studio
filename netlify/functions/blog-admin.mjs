import { BlogAuthError, clearSessionCookie, login, logout, requireAdmin } from '../../server/blog/auth.mjs';
import { assertLoginRequest, CsrfError } from '../../server/blog/csrf.mjs';
import { readBlogConfig } from '../../server/blog/config.mjs';

export const config = { path: '/api/admin/session', method: ['GET', 'POST'] };

const MAX_LOGIN_BODY_BYTES = 16 * 1024;
const COMMON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...COMMON_HEADERS, ...headers } });
}

function publicError(error) {
  if (error instanceof BlogAuthError || error instanceof CsrfError) {
    return reply(error.status, { error: { code: error.code ?? (error.status === 403 ? 'BLOG_FORBIDDEN' : 'BLOG_AUTH_REQUIRED'), message: error.message } });
  }
  return reply(503, { error: { code: 'BLOG_SERVICE_UNAVAILABLE', message: 'The admin service is temporarily unavailable.' } });
}

async function readBoundedJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) {
    const error = new BlogAuthError(413, 'BLOG_BODY_TOO_LARGE', 'The request body is too large.');
    throw error;
  }
  if (!request.body) throw new BlogAuthError(400, 'BLOG_INVALID_INPUT', 'The request body is invalid.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BlogAuthError(413, 'BLOG_BODY_TOO_LARGE', 'The request body is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid json object');
    return result;
  } catch {
    throw new BlogAuthError(400, 'BLOG_INVALID_INPUT', 'The request body is invalid.');
  }
}

export default async function blogAdmin(request) {
  try {
    const config = readBlogConfig();
    const url = new URL(request.url);
    if (url.pathname !== '/api/admin/session') {
      return reply(404, { error: { code: 'BLOG_NOT_FOUND', message: 'The admin route was not found.' } });
    }

    if (request.method === 'GET') {
      const auth = await requireAdmin(request);
      return reply(200, {
        authenticated: true,
        user: { id: auth.userId },
        csrfToken: auth.csrfToken,
        expiresAt: auth.expiresAt,
      });
    }

    if (request.method === 'POST') {
      assertLoginRequest(request, config.appOrigin);
      const body = await readBoundedJson(request, MAX_LOGIN_BODY_BYTES);
      if (body.action === 'logout') {
        const auth = await requireAdmin(request, {
          mutation: true,
          csrfToken: request.headers.get('x-csrf-token'),
          forLogout: true,
        }, { config });
        await logout(auth);
        return reply(200, { authenticated: false }, { 'set-cookie': clearSessionCookie() });
      }
      if (body.action !== 'login') {
        throw new BlogAuthError(400, 'BLOG_INVALID_INPUT', 'The request body is invalid.');
      }
      const result = await login({ email: body.email, password: body.password }, request, { config });
      return result.response;
    }

    return reply(405, { error: { code: 'BLOG_METHOD_NOT_ALLOWED', message: 'The request method is not supported.' } }, { allow: 'GET, POST' });
  } catch (error) {
    return publicError(error);
  }
}
