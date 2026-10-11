import { clearSession, getSessionState, initializeSessionCoordination, login, logout, sessionEpoch, setSession, subscribeSession } from './session.js';

export class AdminApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

async function responseData(response, expectedEpoch) {
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch()) {
    throw new DOMException('The admin session changed during this request.', 'AbortError');
  }
  if (!response.ok) {
    const failure = body?.error;
    throw new AdminApiError(response.status, failure?.code ?? 'BLOG_SERVICE_UNAVAILABLE', failure?.message ?? 'The admin service is temporarily unavailable.');
  }
  return body;
}

export async function adminFetch(path, options = {}, { epoch = sessionEpoch(), signal } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/admin/') || path.startsWith('//')) {
    throw new TypeError('Admin API path is invalid');
  }
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  const body = options.body;
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    const state = getSessionState();
    if (!state?.csrfToken) {
      await getSession({ signal });
      if (epoch !== sessionEpoch()) throw new DOMException('The admin session changed during this request.', 'AbortError');
    }
    if (epoch !== sessionEpoch()) throw new DOMException('The admin session changed during this request.', 'AbortError');
    const current = getSessionState();
    if (!current?.csrfToken) throw new AdminApiError(401, 'BLOG_AUTH_REQUIRED', 'Sign in to continue.');
    headers.set('x-csrf-token', current.csrfToken);
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ?? options.signal,
  });
  if (epoch !== sessionEpoch()) throw new DOMException('The admin session changed during this request.', 'AbortError');
  if (response.status === 401) clearSession(epoch, 'reauth-required');
  return responseData(response, epoch);
}

export async function getSession(options = {}) {
  initializeSessionCoordination();
  const epoch = sessionEpoch();
  const response = await fetch('/api/admin/session', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal,
    headers: { accept: 'application/json' },
  });
  if (epoch !== sessionEpoch()) return null;
  if (response.status === 401) {
    clearSession(epoch, 'reauth-required');
    return null;
  }
  const body = await responseData(response);
  if (epoch !== sessionEpoch() || !setSession({ user: body.user, csrfToken: body.csrfToken, expiresAt: body.expiresAt }, epoch)) return null;
  return getSessionState();
}

export { login, logout, subscribeSession };
