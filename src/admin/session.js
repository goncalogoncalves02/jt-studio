let epoch = 0;
let currentSession = null;
const subscribers = new Set();
const CHANNEL_NAME = 'jt-admin-session-v1';
const LOCK_NAME = 'jt-admin-session-transport-v1';
const SESSION_REASONS = new Set(['login', 'logout', 'reauth-required', 'invalidated']);
let channel;

function publish(type, reason, broadcast = true) {
  if (broadcast) channel?.postMessage({ type, reason });
  for (const subscriber of subscribers) subscriber({ type, reason, epoch });
}

function ensureChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel !== 'function') {
    throw new Error('This browser cannot safely coordinate admin sessions across tabs.');
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event) => {
      if (event.data?.type !== 'session-changed') return;
      const reason = SESSION_REASONS.has(event.data.reason) ? event.data.reason : 'reauth-required';
      epoch += 1;
      currentSession = null;
      publish('session-changed', reason, false);
    });
  }
  return channel;
}

async function withSessionTransport(operation) {
  ensureChannel();
  if (!navigator?.locks || typeof navigator.locks.request !== 'function') {
    throw new Error('This browser cannot safely coordinate admin sessions across tabs.');
  }
  return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, operation);
}

export function initializeSessionCoordination() { return ensureChannel(); }

export function sessionEpoch() { return epoch; }
export function getSessionState() { return currentSession; }

export function setSession(session, expectedEpoch = epoch) {
  if (typeof window !== 'undefined') ensureChannel();
  if (expectedEpoch !== epoch) return false;
  currentSession = session;
  return true;
}

export function clearSession(expectedEpoch = epoch, reason = 'reauth-required') {
  if (expectedEpoch !== epoch) return false;
  if (!SESSION_REASONS.has(reason)) throw new TypeError('Session invalidation reason is invalid');
  epoch += 1;
  currentSession = null;
  publish('session-changed', reason);
  return true;
}

export function subscribeSession(listener) {
  if (typeof window !== 'undefined') ensureChannel();
  if (typeof listener !== 'function') throw new TypeError('Session listener is invalid');
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export async function login({ email, password }) {
  return withSessionTransport(async () => {
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password }),
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? 'Sign in failed.');
      error.status = response.status;
      error.code = body?.error?.code ?? 'BLOG_LOGIN_FAILED';
      throw error;
    }
    epoch += 1;
    setSession({ user: body.user, csrfToken: body.csrfToken, expiresAt: body.expiresAt }, epoch);
    publish('session-changed', 'login');
    return currentSession;
  });
}

export async function logout() {
  return withSessionTransport(async () => {
    const state = currentSession;
    if (!state?.csrfToken) throw new Error('The admin session must be loaded before logout.');
    const response = await fetch('/api/admin/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': state.csrfToken },
      body: JSON.stringify({ action: 'logout' }),
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? 'Sign out failed.');
      error.status = response.status;
      error.code = body?.error?.code ?? 'BLOG_SERVICE_UNAVAILABLE';
      throw error;
    }
    epoch += 1;
    currentSession = null;
    publish('session-changed', 'logout');
    return true;
  });
}
