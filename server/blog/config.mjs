import { createClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_32_PATTERN = /^[a-f0-9]{64}$/iu;

export class BlogConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlogConfigError';
    this.status = 503;
  }
}

export function createBoundedFetch(timeoutMs, fetchImpl = fetch, parentSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof fetchImpl !== 'function') {
    throw new TypeError('A bounded fetch requires a positive timeout and fetch implementation.');
  }
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout];
    if (parentSignal) signals.push(parentSignal);
    if (init.signal) signals.push(init.signal);
    const signal = signals.length === 1 ? timeout : AbortSignal.any(signals);
    return fetchImpl(input, { ...init, signal });
  };
}

export function readBlogConfig(env = process.env) {
  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const ownerId = env.BLOG_ADMIN_USER_ID;
  const encryptionKey = env.BLOG_SESSION_ENCRYPTION_KEY;
  const appOrigin = env.BLOG_PUBLIC_ORIGIN;

  let parsedSupabaseUrl;
  let parsedOrigin;
  try { parsedSupabaseUrl = new URL(supabaseUrl); } catch { throw new BlogConfigError('Blog server configuration is unavailable.'); }
  try { parsedOrigin = new URL(appOrigin); } catch { throw new BlogConfigError('Blog server configuration is unavailable.'); }
  if (!['http:', 'https:'].includes(parsedSupabaseUrl.protocol)
      || !['', '/'].includes(parsedSupabaseUrl.pathname)
      || parsedSupabaseUrl.username || parsedSupabaseUrl.password || parsedSupabaseUrl.search || parsedSupabaseUrl.hash
      || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== appOrigin
      || typeof anonKey !== 'string' || anonKey.length < 20
      || typeof serviceRoleKey !== 'string' || serviceRoleKey.length < 20
      || !UUID_PATTERN.test(ownerId ?? '')
      || !HEX_32_PATTERN.test(encryptionKey ?? '')) {
    throw new BlogConfigError('Blog server configuration is unavailable.');
  }
  return Object.freeze({
    supabaseUrl: parsedSupabaseUrl.origin,
    anonKey,
    serviceRoleKey,
    ownerId: ownerId.toLowerCase(),
    encryptionKey: Buffer.from(encryptionKey, 'hex'),
    appOrigin,
    cookieName: '__Host-jt_admin',
    sessionLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    refreshBeforeSeconds: 120,
  });
}

export function readNetlifyConfig(env = process.env) {
  const siteId = env.BLOG_NETLIFY_SITE_ID;
  const apiToken = env.BLOG_NETLIFY_API_TOKEN;
  const appOrigin = env.BLOG_PUBLIC_ORIGIN;
  let parsedOrigin;
  try { parsedOrigin = new URL(appOrigin); } catch { throw new BlogConfigError('Netlify configuration is unavailable.'); }
  if (typeof siteId !== 'string' || !/^[A-Za-z0-9._-]{3,128}$/u.test(siteId)
      || typeof apiToken !== 'string' || apiToken.trim().length < 8
      || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== appOrigin) {
    throw new BlogConfigError('Netlify configuration is unavailable.');
  }
  return Object.freeze({ siteId, apiToken, publicOrigin: appOrigin });
}

export function createServerClient(config, { signal, fetchImpl = fetch } = {}) {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createBoundedFetch(6_000, fetchImpl, signal) },
  });
}

export function createAuthClient(config, accessToken, fetchImpl) {
  return createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  });
}
