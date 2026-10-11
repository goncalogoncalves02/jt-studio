import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  clearSessionCookie,
  createSessionCookie,
  decryptTokens,
  encryptTokens,
  parseSessionCookie,
} from '../../server/blog/auth.mjs';
import { assertCsrfRequest } from '../../server/blog/csrf.mjs';

const key = randomBytes(32);
const tokens = { access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_at: 1_900_000_000 };

test('opaque session cookie is 32 random bytes and is Secure, HttpOnly, host-only, and persistent', () => {
  const first = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  const second = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  assert.notEqual(first.value, second.value);
  assert.equal(Buffer.from(first.value, 'base64url').length, 32);
  assert.equal(first.digest, createHash('sha256').update(first.value).digest('hex'));
  assert.match(first.header, /HttpOnly/u);
  assert.match(first.header, /Secure/u);
  assert.match(first.header, /SameSite=Lax/u);
  assert.match(first.header, /Path=\//u);
  assert.doesNotMatch(first.header, /Domain=/iu);
  assert.match(first.header, /Max-Age=2592000/u);
});

test('cookie parser rejects malformed or duplicate opaque session cookies', () => {
  assert.equal(parseSessionCookie('__Host-jt_admin=%%%'), null);
  assert.equal(parseSessionCookie('__Host-jt_admin=abc; __Host-jt_admin=def'), null);
  const value = Buffer.alloc(32, 3).toString('base64url');
  assert.equal(parseSessionCookie(`other=x; __Host-jt_admin=${value}`), value);
});

test('private Auth tokens round-trip with AES-256-GCM and reject tampering or a wrong key', () => {
  const encrypted = encryptTokens(tokens, key);
  assert.notEqual(encrypted, JSON.stringify(tokens));
  assert.deepEqual(decryptTokens(encrypted, key), tokens);
  assert.throws(() => decryptTokens(encrypted, randomBytes(32)), /session credentials are unavailable/u);
  const tampered = `${encrypted.slice(0, -2)}aa`;
  assert.throws(() => decryptTokens(tampered, key), /session credentials are unavailable/u);
});

test('logout cookie expires the same host-only Secure cookie without exposing credentials', () => {
  const header = clearSessionCookie();
  assert.match(header, /^__Host-jt_admin=;/u);
  assert.match(header, /Max-Age=0/u);
  assert.match(header, /HttpOnly/u);
  assert.match(header, /Secure/u);
  assert.match(header, /SameSite=Lax/u);
  assert.doesNotMatch(header, /Domain=/iu);
});

test('admin mutation requires the exact configured Origin and a matching CSRF token', () => {
  const validToken = Buffer.alloc(32, 9).toString('base64url');
  const request = (origin, token = validToken, type = 'application/json') => ({
    method: 'POST',
    headers: new Headers({ origin, 'x-csrf-token': token, 'content-type': type }),
  });
  assert.doesNotThrow(() => assertCsrfRequest(request('https://editor.example.test'), 'https://editor.example.test', validToken));
  assert.throws(() => assertCsrfRequest(request('https://evil.example.test'), 'https://editor.example.test', validToken));
  assert.throws(() => assertCsrfRequest(request('https://editor.example.test', 'wrong'), 'https://editor.example.test', validToken));
  assert.throws(() => assertCsrfRequest(request('https://editor.example.test', validToken, 'text/plain'), 'https://editor.example.test', validToken));
});

test('raw WebP mutations are allowed only on the exact server-owned upload route', async () => {
  const { requireAdmin } = await import('../../server/blog/auth.mjs');
  const config = { supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key,
    appOrigin: 'https://editor.example.test', ownerId: '3010b4ba-15c6-4826-a0df-e7f10fc3ca76', refreshBeforeSeconds: 120 };
  const makeRequest = (path, origin, contentType, token = 'csrf-token-fixture') => new Request(`https://editor.example.test${path}`, {
    method: 'POST', headers: { origin, 'content-type': contentType, 'x-csrf-token': token }, body: Buffer.from('webp'),
  });
  const expectedAuthorizationFailure = error => error.status === 401;
  await assert.rejects(requireAdmin(makeRequest('/api/admin/media/upload', config.appOrigin, 'image/webp'),
    { mutation: true, csrfToken: 'csrf-token-fixture', mutationContentType: 'image/webp' }, { config }), expectedAuthorizationFailure);
  await assert.rejects(requireAdmin(makeRequest('/api/admin/media/upload', 'https://evil.example.test', 'image/webp'),
    { mutation: true, csrfToken: 'csrf-token-fixture', mutationContentType: 'image/webp' }, { config }), error => error.status === 403);
  await assert.rejects(requireAdmin(makeRequest('/api/admin/session', config.appOrigin, 'image/webp'),
    { mutation: true, csrfToken: 'csrf-token-fixture', mutationContentType: 'image/webp' }, { config }), error => error.status === 403);
  await assert.rejects(requireAdmin(makeRequest('/api/admin/media/upload', config.appOrigin, 'image/webp'),
    { mutation: true, csrfToken: 'csrf-token-fixture' }, { config }), error => error.status === 403);
});

test('logout revokes the app session before attempting remote Auth signout and ignores Auth failure', async () => {
  const { createCsrfToken } = await import('../../server/blog/csrf.mjs');
  const { requireAdmin, logout } = await import('../../server/blog/auth.mjs');
  const sessionId = '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7';
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const authSessionId = 'c74277a8-32af-4556-8c53-e46c596abdc9';
  const config = {
    supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test',
    encryptionKey: key, appOrigin: 'https://editor.example.test', ownerId: '3010b4ba-15c6-4826-a0df-e7f10fc3ca76', refreshBeforeSeconds: 120,
  };
  const cookie = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  const stored = {
    session_id: sessionId, user_id: userId, auth_session_id: authSessionId,
    generation: 1, expires_at: '2026-11-10T12:00:00.000Z',
    token_ciphertext: encryptTokens(tokens, key), refresh_claim_id: null,
  };
  const events = [];
  const serviceClient = { rpc: async (name, args) => {
    events.push(name);
    if (name === 'blog_admin_session_lookup') return { data: stored, error: null };
    if (name === 'blog_admin_session_revoke') {
      assert.deepEqual(args, { p_session_id: sessionId, p_user_id: userId });
      return { data: true, error: null };
    }
    throw new Error('Unexpected session RPC');
  } };
  const csrfToken = createCsrfToken(key, sessionId);
  const request = new Request('https://editor.example.test/api/admin/session', {
    method: 'POST',
    headers: {
      cookie: `__Host-jt_admin=${cookie.value}`,
      origin: config.appOrigin,
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: '{}',
  });
  const auth = await requireAdmin(request, { mutation: true, csrfToken, forLogout: true }, { config, serviceClient, now: new Date('2026-10-11T12:00:00.000Z') });
  assert.deepEqual(events, ['blog_admin_session_lookup']);
  await logout(auth, { fetchImpl: async (url, init) => {
    events.push('auth-signout');
    assert.equal(new URL(url).pathname, '/auth/v1/logout');
    assert.equal(new URL(url).search, '?scope=local');
    assert.equal(init.method, 'POST');
    throw new TypeError('controlled Auth transport failure');
  } });
  assert.deepEqual(events, ['blog_admin_session_lookup', 'blog_admin_session_revoke', 'auth-signout']);
});

test('logout can revoke a session while refresh is claimed without contacting Auth', async () => {
  const { createCsrfToken } = await import('../../server/blog/csrf.mjs');
  const { requireAdmin, logout } = await import('../../server/blog/auth.mjs');
  const sessionId = '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7';
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const cookie = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  const config = { supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key, appOrigin: 'https://editor.example.test', ownerId: '3010b4ba-15c6-4826-a0df-e7f10fc3ca76', refreshBeforeSeconds: 120 };
  const stored = { session_id: sessionId, user_id: userId, auth_session_id: 'c74277a8-32af-4556-8c53-e46c596abdc9', generation: 1, expires_at: '2026-11-10T12:00:00.000Z', token_ciphertext: encryptTokens(tokens, key), refresh_claim_id: 'd5145b2f-0d98-4fb0-8902-38a143b5f541' };
  const events = [];
  const serviceClient = { rpc: async name => {
    events.push(name);
    if (name === 'blog_admin_session_lookup') return { data: stored, error: null };
    if (name === 'blog_admin_session_revoke') return { data: true, error: null };
    throw new Error('Unexpected session RPC');
  } };
  const csrfToken = createCsrfToken(key, sessionId);
  const request = new Request('https://editor.example.test/api/admin/session/logout', { method: 'POST', headers: { cookie: `__Host-jt_admin=${cookie.value}`, origin: config.appOrigin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{}' });
  const auth = await requireAdmin(request, { mutation: true, csrfToken, forLogout: true }, { config, serviceClient, now: new Date('2026-10-11T12:00:00.000Z') });
  assert.equal(auth.sessionId, sessionId);
  await logout(auth, { fetchImpl: async () => { events.push('auth-signout'); throw new TypeError('controlled Auth transport failure'); } });
  assert.deepEqual(events, ['blog_admin_session_lookup', 'blog_admin_session_revoke', 'auth-signout']);
  const badOrigin = new Request(request.url, { method: 'POST', headers: { cookie: `__Host-jt_admin=${cookie.value}`, origin: 'https://evil.example.test', 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{}' });
  await assert.rejects(requireAdmin(badOrigin, { mutation: true, csrfToken, forLogout: true }, { config, serviceClient, now: new Date('2026-10-11T12:00:00.000Z') }), error => error.status === 403);
});


test('configured owner mismatch fails login before creating an app session or cookie', async () => {
  const { login } = await import('../../server/blog/auth.mjs');
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const authSessionId = 'c74277a8-32af-4556-8c53-e46c596abdc9';
  const expiresAt = 1_900_000_000;
  const accessToken = `header.${Buffer.from(JSON.stringify({ sub: userId, session_id: authSessionId, exp: expiresAt })).toString('base64url')}.signature`;
  let sessionCreated = false;
  const authClient = { auth: {
    signInWithPassword: async () => ({ data: { user: { id: userId }, session: { access_token: accessToken, refresh_token: 'refresh-fixture', expires_at: expiresAt } }, error: null }),
    getUser: async () => ({ data: { user: { id: userId } }, error: null }),
  } };
  const config = { supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key, appOrigin: 'https://editor.example.test', ownerId: 'c83d65ad-a68e-4532-a7d8-6517607acbea', refreshBeforeSeconds: 120 };
  await assert.rejects(login({ email: 'admin@example.test', password: 'controlled-fixture-password' }, new Request('https://editor.example.test/api/admin/session'), {
    config, authClient, now: new Date('2026-10-11T12:00:00.000Z'),
    serviceClient: { rpc: async () => { sessionCreated = true; return { data: true, error: null }; } },
  }), error => error.status === 403 && error.code === 'BLOG_LOGIN_FAILED');
  assert.equal(sessionCreated, false);
});

test('configured owner mismatch fails closed before accepting a stored session for logout', async () => {
  const { requireAdmin } = await import('../../server/blog/auth.mjs');
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const cookie = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  const config = { supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key, appOrigin: 'https://editor.example.test', ownerId: 'c83d65ad-a68e-4532-a7d8-6517607acbea', refreshBeforeSeconds: 120 };
  const serviceClient = { rpc: async name => {
    assert.equal(name, 'blog_admin_session_lookup');
    return { data: { session_id: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7', user_id: userId, auth_session_id: 'c74277a8-32af-4556-8c53-e46c596abdc9', generation: 1, expires_at: '2026-11-10T12:00:00.000Z', token_ciphertext: encryptTokens(tokens, key), refresh_claim_id: null }, error: null };
  } };
  const request = new Request('https://editor.example.test/api/admin/session', { method: 'POST', headers: { cookie: `__Host-jt_admin=${cookie.value}`, origin: config.appOrigin, 'content-type': 'application/json' }, body: '{"action":"logout"}' });
  await assert.rejects(requireAdmin(request, { mutation: true, forLogout: true }, { config, serviceClient, now: new Date('2026-10-11T12:00:00.000Z') }), error => error.status === 401);
});


test('logout can revoke an app session when encrypted Auth credentials cannot be decoded', async () => {
  const { createCsrfToken } = await import('../../server/blog/csrf.mjs');
  const { requireAdmin, logout } = await import('../../server/blog/auth.mjs');
  const sessionId = '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7';
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const cookie = createSessionCookie(new Date('2026-10-11T12:00:00.000Z'));
  const config = { supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key, appOrigin: 'https://editor.example.test', ownerId: userId, refreshBeforeSeconds: 120 };
  const events = [];
  const serviceClient = { rpc: async name => {
    events.push(name);
    if (name === 'blog_admin_session_lookup') return { data: { session_id: sessionId, user_id: userId, auth_session_id: 'c74277a8-32af-4556-8c53-e46c596abdc9', generation: 1, expires_at: '2026-11-10T12:00:00.000Z', token_ciphertext: 'v1.invalid.authenticated-ciphertext', refresh_claim_id: null }, error: null };
    if (name === 'blog_admin_session_revoke') return { data: true, error: null };
    throw new Error('Unexpected session RPC');
  } };
  const csrfToken = createCsrfToken(key, sessionId);
  const request = new Request('https://editor.example.test/api/admin/session', { method: 'POST', headers: { cookie: `__Host-jt_admin=${cookie.value}`, origin: config.appOrigin, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{"action":"logout"}' });
  const auth = await requireAdmin(request, { mutation: true, csrfToken, forLogout: true }, { config, serviceClient, now: new Date('2026-10-11T12:00:00.000Z') });
  await logout(auth, { fetchImpl: async () => { events.push('auth-signout'); throw new Error('Auth must be skipped for invalid ciphertext'); } });
  assert.deepEqual(events, ['blog_admin_session_lookup', 'blog_admin_session_revoke']);
});

test('requireAdmin rejects a verification response after the app session expires', async () => {
  const { requireAdmin } = await import('../../server/blog/auth.mjs');
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const authSessionId = 'c74277a8-32af-4556-8c53-e46c596abdc9';
  const now = Date.now();
  const authExpiresAt = Math.floor(now / 1000) + 3600;
  const accessToken = `header.${Buffer.from(JSON.stringify({ sub: userId, session_id: authSessionId, exp: authExpiresAt })).toString('base64url')}.signature`;
  const cookie = createSessionCookie(new Date(now));
  const stored = {
    session_id: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7',
    user_id: userId,
    auth_session_id: authSessionId,
    generation: 3,
    expires_at: new Date(now + 250).toISOString(),
    token_ciphertext: encryptTokens({ access_token: accessToken, refresh_token: 'refresh-fixture', expires_at: authExpiresAt }, key),
    refresh_claim_id: null,
  };
  const config = {
    supabaseUrl: 'http://127.0.0.1:54341', anonKey: 'anon-key-for-test', encryptionKey: key,
    appOrigin: 'https://editor.example.test', ownerId: userId, refreshBeforeSeconds: 120,
  };
  let lookupCount = 0;
  const serviceClient = { rpc: async name => {
    assert.equal(name, 'blog_admin_session_lookup');
    lookupCount += 1;
    return { data: Date.parse(stored.expires_at) > Date.now() ? { ...stored } : null, error: null };
  } };
  const originalFetch = globalThis.fetch;
  let releaseVerification;
  let markVerificationStarted;
  const verificationStarted = new Promise(resolve => { markVerificationStarted = resolve; });
  const heldVerification = new Promise(resolve => { releaseVerification = resolve; });
  globalThis.fetch = async input => {
    assert.equal(new URL(input).pathname, '/auth/v1/user');
    markVerificationStarted();
    return heldVerification;
  };
  const request = new Request('https://editor.example.test/api/admin/session', {
    headers: { cookie: `__Host-jt_admin=${cookie.value}` },
  });
  try {
    const pending = requireAdmin(request, {}, { config, serviceClient });
    await verificationStarted;
    while (Date.now() <= Date.parse(stored.expires_at)) await new Promise(resolve => setTimeout(resolve, 10));
    releaseVerification(new Response(JSON.stringify({ id: userId, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: new Date(now).toISOString() }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(pending, error => error.status === 401 && error.code === 'BLOG_AUTH_REQUIRED');
    assert.equal(lookupCount, 2, 'the original cookie digest is looked up again after Auth verification');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
