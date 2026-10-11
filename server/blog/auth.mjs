import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  createAuthClient,
  createBoundedFetch,
  createServerClient,
  readBlogConfig,
} from './config.mjs';
import { createCsrfToken } from './csrf.mjs';
import {
  claimAdminRefresh,
  completeAdminRefresh,
  createAdminSession,
  failAdminRefresh,
  findAdminSession,
  revokeAdminSession,
  revokeAbandonedAdminRefresh,
} from './session-store.mjs';

const COOKIE_NAME = '__Host-jt_admin';
const COOKIE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AUTH_SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTH_URL_PATH = '/auth/v1/token?grant_type=refresh_token';
const TOKEN_KEYS = new Set(['access_token', 'refresh_token', 'expires_at']);

export class BlogAuthError extends Error {
  constructor(status, code = 'BLOG_AUTH_REQUIRED', message = 'A valid admin session is required.') {
    super(message);
    this.name = 'BlogAuthError';
    this.status = status;
    this.code = code;
  }
}

function validateKey(key) {
  const result = Buffer.isBuffer(key) ? Buffer.from(key) : (typeof key === 'string' && /^[a-f0-9]{64}$/iu.test(key) ? Buffer.from(key, 'hex') : null);
  if (!result || result.length !== 32) throw new TypeError('Session encryption key is invalid');
  return result;
}

export function encryptTokens(tokens, key) {
  const secret = validateKey(key);
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)
      || Object.keys(tokens).some((field) => !TOKEN_KEYS.has(field))
      || typeof tokens.access_token !== 'string' || !tokens.access_token
      || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
      || !Number.isSafeInteger(tokens.expires_at) || tokens.expires_at <= 0) {
    throw new TypeError('Session credentials are invalid');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptTokens(envelope, key) {
  try {
    const [version, ivText, tagText, payloadText, extra] = String(envelope).split('.');
    if (version !== 'v1' || !ivText || !tagText || !payloadText || extra !== undefined) throw new Error('invalid envelope');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    const ciphertext = Buffer.from(payloadText, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 16_384) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', validateKey(key), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const tokens = JSON.parse(plaintext);
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)
        || Object.keys(tokens).length !== 3 || Object.keys(tokens).some((field) => !TOKEN_KEYS.has(field))
        || typeof tokens.access_token !== 'string' || !tokens.access_token
        || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
        || !Number.isSafeInteger(tokens.expires_at) || tokens.expires_at <= 0) throw new Error('invalid payload');
    return tokens;
  } catch {
    throw new BlogAuthError(401, 'BLOG_AUTH_REQUIRED', 'The admin session credentials are unavailable.');
  }
}

export function createSessionCookie(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('Session time is invalid');
  const value = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.valueOf() + COOKIE_SECONDS * 1000);
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  const header = `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_SECONDS}; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
  return { value, digest, expiresAt: expiresAt.toISOString(), header };
}

export function parseSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) return null;
  const matches = cookieHeader.split(';').map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE_NAME.length + 1);
  if (!COOKIE_VALUE_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value ? value : null;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

function cookieDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenClaims(token) {
  try {
    const pieces = token.split('.');
    if (pieces.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}

function assertSessionIdentity(user, tokens, expectedUserId, expectedAuthSessionId) {
  const claims = tokenClaims(tokens.access_token);
  if (!user || typeof user.id !== 'string' || user.id !== expectedUserId
      || !claims || claims.sub !== expectedUserId || !AUTH_SESSION_PATTERN.test(claims.session_id ?? '')
      || claims.session_id !== expectedAuthSessionId || !Number.isSafeInteger(claims.exp)) {
    throw new BlogAuthError(401);
  }
  return claims;
}

function normalizedTokens(session) {
  const accessToken = session?.access_token;
  const refreshToken = session?.refresh_token;
  const expiresAt = session?.expires_at;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken
      || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED', 'Email or password is incorrect.');
  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
}

function expirationSeconds(tokens) { return tokens.expires_at; }

async function verifiedAuthUser(config, tokens, suppliedClient) {
  const authClient = suppliedClient ?? createAuthClient(config, undefined, createBoundedFetch(8_000));
  const { data, error } = await authClient.auth.getUser(tokens.access_token);
  if (error || !data?.user?.id) throw new BlogAuthError(401);
  return data.user;
}

async function refreshTokens(config, serviceClient, session) {
  const claimId = randomUUID();
  const claimed = await claimAdminRefresh(serviceClient, {
    sessionId: session.session_id,
    generation: Number(session.generation),
    claimId,
  });
  if (!claimed || claimed.claim_id !== claimId) {
    throw new BlogAuthError(503, 'BLOG_SESSION_REFRESH_PENDING', 'Session renewal is being reconciled. Keep this page open and try again shortly.');
  }

  const oldTokens = decryptTokens(session.token_ciphertext, config.encryptionKey);
  let response;
  let refreshed;
  try {
    response = await fetch(new URL(AUTH_URL_PATH, config.supabaseUrl), {
      method: 'POST',
      headers: { apikey: config.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: oldTokens.refresh_token }),
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('refresh response was not accepted');
    const payload = await response.json();
    refreshed = normalizedTokens(payload);
  } catch {
    await failAdminRefresh(serviceClient, {
      sessionId: session.session_id,
      generation: Number(session.generation),
      claimId,
    }).catch(() => {});
    throw new BlogAuthError(401);
  }

  let refreshedUser;
  try {
    refreshedUser = await verifiedAuthUser(config, refreshed);
    assertSessionIdentity(refreshedUser, refreshed, session.user_id, session.auth_session_id);
  } catch {
    await failAdminRefresh(serviceClient, {
      sessionId: session.session_id,
      generation: Number(session.generation),
      claimId,
    }).catch(() => {});
    throw new BlogAuthError(401);
  }
  const completed = await completeAdminRefresh(serviceClient, {
    sessionId: session.session_id,
    generation: Number(session.generation),
    claimId,
    authExpiresAt: new Date(expirationSeconds(refreshed) * 1000).toISOString(),
    tokenCiphertext: encryptTokens(refreshed, config.encryptionKey),
  });
  const completedGeneration = Number(completed);
  if (!Number.isSafeInteger(completedGeneration) || completedGeneration !== Number(session.generation) + 1) throw new BlogAuthError(401);
  return { tokens: refreshed, generation: completedGeneration, user: refreshedUser };
}

export async function login({ email, password }, request, options = {}) {
  const config = options.config ?? readBlogConfig();
  if (typeof email !== 'string' || email.length > 320 || typeof password !== 'string' || password.length < 1 || password.length > 1024) {
    throw new BlogAuthError(400, 'BLOG_INVALID_INPUT', 'Email and password are required.');
  }
  const authClient = options.authClient ?? createAuthClient(config);
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data?.session || !data?.user?.id) {
    throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED', 'Email or password is incorrect.');
  }
  const tokens = normalizedTokens(data.session);
  let user;
  try {
    user = await verifiedAuthUser(config, tokens, authClient);
    const claims = assertSessionIdentity(user, tokens, data.user.id, tokenClaims(tokens.access_token)?.session_id);
    if (user.id !== config.ownerId) throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED');
    if (claims.exp !== tokens.expires_at) throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED');
  } catch {
    throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED', 'Email or password is incorrect.');
  }

  const now = options.now ?? new Date();
  const cookie = createSessionCookie(now);
  const appSession = {
    sessionId: randomUUID(),
    userId: user.id,
    authSessionId: tokenClaims(tokens.access_token).session_id,
    generation: 1,
    cookieDigest: cookie.digest,
    expiresAt: cookie.expiresAt,
    authExpiresAt: new Date(tokens.expires_at * 1000).toISOString(),
    tokenCiphertext: encryptTokens(tokens, config.encryptionKey),
  };
  const serviceClient = options.serviceClient ?? createServerClient(config);
  try {
    const created = await createAdminSession(serviceClient, appSession);
    if (created !== true && created?.created !== true) throw new Error('session not created');
  } catch {
    throw new BlogAuthError(403, 'BLOG_LOGIN_FAILED', 'Email or password is incorrect.');
  }

  const csrfToken = createCsrfToken(config.encryptionKey, appSession.sessionId);
  const response = Response.json({ authenticated: true, user: { id: user.id }, csrfToken, expiresAt: cookie.expiresAt }, {
    status: 200,
    headers: { 'cache-control': 'no-store', 'set-cookie': cookie.header },
  });
  return { response, session: { userId: user.id, sessionId: appSession.sessionId, generation: 1, expiresAt: cookie.expiresAt } };
}

export async function requireAdmin(request, { mutation = false, csrfToken, forLogout = false, mutationContentType } = {}, options = {}) {
  const config = options.config ?? readBlogConfig();
  const requestedContentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let expectedContentType = 'application/json';
  if (mutationContentType === 'image/webp') {
    let isExactUploadRoute = false;
    try { isExactUploadRoute = request.method === 'POST' && new URL(request.url).pathname === '/api/admin/media/upload'; } catch { /* invalid requests fail closed */ }
    if (!isExactUploadRoute) throw new BlogAuthError(403, 'BLOG_FORBIDDEN', 'The request is not authorized.');
    expectedContentType = 'image/webp';
  } else if (mutationContentType !== undefined && mutationContentType !== 'application/json') {
    throw new BlogAuthError(403, 'BLOG_FORBIDDEN', 'The request is not authorized.');
  }
  if (mutation && (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      || request.headers.get('origin') !== config.appOrigin
      || requestedContentType !== expectedContentType)) {
    throw new BlogAuthError(403, 'BLOG_FORBIDDEN', 'The request is not authorized.');
  }
  const cookieValue = parseSessionCookie(request.headers.get('cookie'));
  if (!cookieValue) throw new BlogAuthError(401);
  const serviceClient = options.serviceClient ?? createServerClient(config);
  const session = await findAdminSession(serviceClient, cookieDigest(cookieValue));
  if (!session || typeof config.ownerId !== 'string' || session.user_id !== config.ownerId) throw new BlogAuthError(401);

  const nowMs = (options.now ?? new Date()).valueOf();
  if (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= nowMs
      || Number(session.generation) < 1 || !AUTH_SESSION_PATTERN.test(session.auth_session_id ?? '')
      || !session.session_id || !session.user_id || !session.token_ciphertext) throw new BlogAuthError(401);
  if (session.refresh_claim_id && !forLogout) {
    let abandoned = false;
    try {
      abandoned = await revokeAbandonedAdminRefresh(serviceClient, {
        sessionId: session.session_id,
        generation: Number(session.generation),
        claimId: session.refresh_claim_id,
      }) === true;
    } catch { /* A failed reconciliation remains pending and never repeats Auth refresh. */ }
    if (abandoned) throw new BlogAuthError(401);
    throw new BlogAuthError(503, 'BLOG_SESSION_REFRESH_PENDING', 'Session renewal is being reconciled. Keep this page open and try again shortly.');
  }
  if (mutation) {
    const expected = createCsrfToken(config.encryptionKey, session.session_id);
    const left = Buffer.from(String(csrfToken ?? ''), 'utf8');
    const right = Buffer.from(expected, 'utf8');
    if (left.length !== right.length || left.length < 32 || !timingSafeEqual(left, right)) throw new BlogAuthError(403, 'BLOG_FORBIDDEN', 'The request is not authorized.');
  }

  if (forLogout) {
    return {
      userId: session.user_id,
      authSessionId: session.auth_session_id,
      appSessionDigest: cookieDigest(cookieValue),
      generation: Number(session.generation),
      sessionId: session.session_id,
      expiresAt: session.expires_at,
      tokenCiphertext: session.token_ciphertext,
      serviceClient,
      config,
    };
  }
  let tokens = decryptTokens(session.token_ciphertext, config.encryptionKey);
  let generation = Number(session.generation);
  let user;
  if (tokens.expires_at - Math.floor(nowMs / 1000) < config.refreshBeforeSeconds) {
    const refreshed = await refreshTokens(config, serviceClient, session);
    tokens = refreshed.tokens;
    generation = refreshed.generation;
    user = refreshed.user;
  } else {
    user = await verifiedAuthUser(config, tokens);
    assertSessionIdentity(user, tokens, session.user_id, session.auth_session_id);
  }

  const expectedGeneration = generation;
  const currentSession = await findAdminSession(serviceClient, cookieDigest(cookieValue));
  const revalidatedAt = (typeof options.now === 'function' ? options.now() : new Date()).valueOf();
  const currentExpiry = Date.parse(currentSession?.expires_at);
  if (!currentSession
      || currentSession.session_id !== session.session_id
      || currentSession.user_id !== session.user_id
      || currentSession.user_id !== config.ownerId
      || currentSession.auth_session_id !== session.auth_session_id
      || Number(currentSession.generation) !== expectedGeneration
      || currentSession.refresh_claim_id
      || !Number.isFinite(currentExpiry) || currentExpiry <= revalidatedAt) {
    throw new BlogAuthError(401);
  }

  return {
    userId: session.user_id,
    authSessionId: session.auth_session_id,
    appSessionDigest: cookieDigest(cookieValue),
    generation,
    sessionId: session.session_id,
    expiresAt: session.expires_at,
    accessToken: tokens.access_token,
    serviceClient,
    userSdk: createAuthClient(config, tokens.access_token),
    config,
    user,
    csrfToken: createCsrfToken(config.encryptionKey, session.session_id),
  };
}

const SESSION_MUTATIONS = Object.freeze({
  savePost: async (client, auth, input) => client.rpc('blog_save_post', {
    p_input: input.post,
    p_expected_revision: input.expectedRevision,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  }),
  markPrepared: async (client, auth, input) => client.rpc('blog_mark_prepared', {
    p_post_id: input.postId,
    p_expected_revision: input.expectedRevision,
    p_action: input.action,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  }),
  publicationSummary: async (client, auth) => client.rpc('blog_publication_summary', {
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  }),
  freezeRelease: async (client, auth, input) => client.rpc('blog_freeze_release', {
    p_request_id: input.requestId,
    p_generation: auth.generation,
    p_session_id: auth.sessionId,
    p_expected_digest: input.expectedDigest,
  }),
});

export async function executeSessionMutation(auth, { operation, input = {} }) {
  if (!auth?.userSdk || typeof auth.userSdk.rpc !== 'function' || typeof auth.sessionId !== 'string'
      || !Number.isSafeInteger(auth.generation) || auth.generation < 1) throw new BlogAuthError(401);
  const execute = SESSION_MUTATIONS[operation];
  if (!execute || !input || typeof input !== 'object' || Array.isArray(input)) throw new BlogAuthError(400, 'BLOG_INVALID_INPUT', 'The requested editorial operation is invalid.');
  if (operation === 'savePost' && (!input.post || typeof input.post !== 'object' || !Number.isSafeInteger(input.expectedRevision))) throw new BlogAuthError(400, 'BLOG_INVALID_INPUT');
  if (operation === 'markPrepared' && (typeof input.postId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || !['upsert', 'remove'].includes(input.action))) throw new BlogAuthError(400, 'BLOG_INVALID_INPUT');
  if (operation === 'freezeRelease' && (typeof input.requestId !== 'string' || typeof input.expectedDigest !== 'string')) throw new BlogAuthError(400, 'BLOG_INVALID_INPUT');
  const { data, error } = await execute(auth.userSdk, auth, input);
  if (error) {
    const known = { '40001': [409, 'BLOG_STALE_REVISION'], '23505': [409, 'BLOG_SLUG_CONFLICT'], '42501': [403, 'BLOG_FORBIDDEN'], '23514': [400, 'BLOG_INVALID_INPUT'], '22023': [400, 'BLOG_INVALID_INPUT'] };
    const [status, code] = known[error.code] ?? [503, 'BLOG_SERVICE_UNAVAILABLE'];
    throw new BlogAuthError(status, code, status === 400 ? 'The editorial input is invalid.' : status === 403 ? 'The editorial operation is not authorized.' : status === 409 ? 'The editorial state changed; reload the current revision.' : 'The editorial service is temporarily unavailable.');
  }
  return data;
}

export async function logout(auth, options = {}) {
  if (!auth?.serviceClient || typeof auth.sessionId !== 'string' || !Number.isSafeInteger(auth.generation)) return;
  await revokeAdminSession(auth.serviceClient, { sessionId: auth.sessionId, userId: auth.userId });
  let accessToken = auth.accessToken;
  if (!accessToken && auth.tokenCiphertext && auth.config?.encryptionKey) {
    try { accessToken = decryptTokens(auth.tokenCiphertext, auth.config.encryptionKey).access_token; } catch { return; }
  }
  if (!accessToken || !auth.config?.supabaseUrl || !auth.config?.anonKey) return;
  try {
    const remoteFetch = options.fetchImpl ?? fetch;
    await remoteFetch(new URL('/auth/v1/logout?scope=local', auth.config.supabaseUrl), {
      method: 'POST',
      headers: { apikey: auth.config.anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4_000),
      redirect: 'error',
    });
  } catch { /* The app session is already revoked; Auth cleanup is best-effort. */ }
}

export function sessionCookieName() { return COOKIE_NAME; }
