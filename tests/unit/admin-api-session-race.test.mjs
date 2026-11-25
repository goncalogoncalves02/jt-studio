import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApiError, adminFetch } from '../../src/admin/api.js';
import { clearSession, getSessionState, sessionEpoch, setSession, subscribeSession } from '../../src/admin/session.js';

test('adminFetch never sends a mutation under a session that replaced its captured epoch while loading CSRF', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  globalThis.BroadcastChannel = class { addEventListener() {} postMessage() {} };
  const initialEpoch = sessionEpoch();
  clearSession(initialEpoch);
  const capturedEpoch = sessionEpoch();
  let releaseGet;
  let markGetStarted;
  const getStarted = new Promise(resolve => { markGetStarted = resolve; });
  const getResult = new Promise(resolve => { releaseGet = resolve; });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers });
    if ((options.method ?? 'GET') === 'GET') {
      markGetStarted();
      return getResult;
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const pending = adminFetch('/api/admin/posts', { method: 'POST', body: { title: 'draft' } }, { epoch: capturedEpoch });
    await getStarted;
    clearSession(capturedEpoch);
    const replacementEpoch = sessionEpoch();
    assert.equal(setSession({ user: { id: 'replacement-user' }, csrfToken: 'replacement-csrf', expiresAt: 'later' }, replacementEpoch), true);
    releaseGet(new Response(JSON.stringify({ user: { id: 'old-user' }, csrfToken: 'old-csrf', expiresAt: 'later' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
    assert.equal(getSessionState().csrfToken, 'replacement-csrf');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.BroadcastChannel = originalBroadcastChannel;
    clearSession(sessionEpoch());
  }
});


test('adminFetch rejects a response body that resolves after the captured session epoch changed', async () => {
  const originalFetch = globalThis.fetch;
  const initialEpoch = sessionEpoch();
  clearSession(initialEpoch);
  let capturedEpoch = sessionEpoch();
  setSession({ user: { id: 'original-user' }, csrfToken: 'original-csrf', expiresAt: 'later' }, capturedEpoch);
  capturedEpoch = sessionEpoch();
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  const body = new Promise(resolve => { releaseBody = resolve; });
  globalThis.fetch = async () => ({
    status: 200, ok: true,
    json: async () => { markBodyStarted(); return body; },
  });
  try {
    const pending = adminFetch('/api/admin/posts', {}, { epoch: capturedEpoch });
    await bodyStarted;
    clearSession(capturedEpoch);
    const replacementEpoch = sessionEpoch();
    setSession({ user: { id: 'replacement-user' }, csrfToken: 'replacement-csrf', expiresAt: 'later' }, replacementEpoch);
    releaseBody({ privateResult: 'old-session-data' });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(getSessionState().user.id, 'replacement-user');
  } finally {
    globalThis.fetch = originalFetch;
    clearSession(sessionEpoch());
  }
});

test('a current-session 401 clears that session and preserves its API error status and code', async () => {
  const originalFetch = globalThis.fetch;
  const initialEpoch = sessionEpoch();
  clearSession(initialEpoch);
  const capturedEpoch = sessionEpoch();
  setSession({ user: { id: 'current-user' }, csrfToken: 'current-csrf', expiresAt: 'later' }, capturedEpoch);
  const requestEpoch = sessionEpoch();
  const events = [];
  const unsubscribe = subscribeSession(event => events.push(event));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'BLOG_AUTH_REQUIRED', message: 'Sign in to continue.' } }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(adminFetch('/api/admin/posts', {}, { epoch: requestEpoch }), error =>
      error instanceof AdminApiError && error.status === 401 && error.code === 'BLOG_AUTH_REQUIRED');
    assert.equal(getSessionState(), null);
    assert.deepEqual(events.map(event => event.reason), ['reauth-required']);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
    clearSession(sessionEpoch());
  }
});


test('session invalidation emits a closed reason without publishing session credentials', () => {
  const events = [];
  const unsubscribe = subscribeSession(event => events.push(event));
  const priorEpoch = sessionEpoch();
  clearSession(priorEpoch, 'reauth-required');
  assert.equal(events.at(-1).reason, 'reauth-required');
  assert.deepEqual(Object.keys(events.at(-1)).sort(), ['epoch', 'reason', 'type']);
  assert.throws(() => clearSession(sessionEpoch(), 'raw-token-value'), /reason is invalid/u);
  unsubscribe();
});
