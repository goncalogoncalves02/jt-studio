import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createBoundedFetch } from '../server/blog/config.mjs';
import { createNetlifyClient, verifyDeployEvidence } from '../server/blog/netlify-api.mjs';
import { isBuildReleaseId } from '../server/blog/release-id.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEPLOY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function assertHttpsOrigin(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} is invalid.`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
      || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must be an explicit non-loopback HTTPS origin.`);
  }
  return parsed.origin;
}

/**
 * Strictly decode Netlify INCOMING_HOOK_BODY (URL-encoded JSON string).
 * Distinguishes absent body (code build) from hook-without-body and malformed payloads.
 */
export function parseIncomingHookBody(env = process.env) {
  const raw = env.INCOMING_HOOK_BODY;
  if (raw === undefined) {
    if ((typeof env.INCOMING_HOOK_URL === 'string' && env.INCOMING_HOOK_URL.length > 0)
        || (typeof env.INCOMING_HOOK_TITLE === 'string' && env.INCOMING_HOOK_TITLE.length > 0)) {
      throw new Error('Production build was triggered by a hook without body.');
    }
    return null;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('INCOMING_HOOK_BODY is malformed.');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('INCOMING_HOOK_BODY is malformed.');
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('INCOMING_HOOK_BODY is malformed.');
  }
  if (!exactKeys(parsed, ['requestId', 'releaseId', 'attemptId'])
      || !UUID_PATTERN.test(parsed.requestId)
      || !UUID_PATTERN.test(parsed.releaseId)
      || !UUID_PATTERN.test(parsed.attemptId)) {
    throw new Error('INCOMING_HOOK_BODY is malformed.');
  }
  return Object.freeze({
    requestId: parsed.requestId.toLowerCase(),
    releaseId: parsed.releaseId.toLowerCase(),
    attemptId: parsed.attemptId.toLowerCase(),
  });
}

function readProductionBuildEnv(env = process.env) {
  if (env.CONTEXT !== 'production') {
    throw new Error('Production build requires CONTEXT=production.');
  }
  if (env.BRANCH !== 'main') {
    throw new Error('Production build requires BRANCH=main.');
  }
  if (typeof env.DEPLOY_ID !== 'string' || !DEPLOY_ID_PATTERN.test(env.DEPLOY_ID)) {
    throw new Error('Production build requires a valid DEPLOY_ID.');
  }
  if (typeof env.BLOG_NETLIFY_SITE_ID === 'string' && env.BLOG_NETLIFY_SITE_ID.length > 0
      && env.SITE_ID !== env.BLOG_NETLIFY_SITE_ID) {
    throw new Error('Production build SITE_ID does not match configured BLOG_NETLIFY_SITE_ID.');
  }
  const publicOrigin = assertHttpsOrigin(env.BLOG_PUBLIC_ORIGIN, 'BLOG_PUBLIC_ORIGIN');
  const publicStorageOrigin = assertHttpsOrigin(env.BLOG_PUBLIC_STORAGE_ORIGIN || env.SUPABASE_URL, 'Public Storage origin');
  return Object.freeze({
    deployId: env.DEPLOY_ID,
    publicOrigin,
    publicStorageOrigin,
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

function createBuildRpc(env, fetchImpl = fetch) {
  if (typeof env.SUPABASE_URL !== 'string' || typeof env.SUPABASE_SERVICE_ROLE_KEY !== 'string'
      || env.SUPABASE_SERVICE_ROLE_KEY.length < 20) {
    throw new Error('Production build requires Supabase server configuration.');
  }
  let parsedSupabase;
  try { parsedSupabase = new URL(env.SUPABASE_URL); } catch { throw new Error('SUPABASE_URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsedSupabase.protocol)) {
    throw new Error('SUPABASE_URL protocol is invalid.');
  }
  const boundedFetch = createBoundedFetch(8_000, (input, init = {}) => fetchImpl(input, { ...init, redirect: 'error' }));
  const client = createClient(parsedSupabase.origin, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  });
  return (name, args) => client.rpc(name, args);
}

export async function acquireBuild({ env = process.env, rpc, fetchImpl = fetch, netlifyClient } = {}) {
  const buildEnv = readProductionBuildEnv(env);
  const hookPayload = parseIncomingHookBody(env);
  const callRpc = rpc ?? createBuildRpc(env, fetchImpl);

  const activeCode = await callRpc('blog_build_active_code_slot');
  if (activeCode?.data?.active === true && activeCode.data.deployId !== buildEnv.deployId
      && Number.isSafeInteger(activeCode.data.generation)) {
    const client = netlifyClient ?? (
      typeof env.BLOG_NETLIFY_SITE_ID === 'string' && env.BLOG_NETLIFY_SITE_ID.length > 0
      && typeof env.BLOG_NETLIFY_API_TOKEN === 'string' && env.BLOG_NETLIFY_API_TOKEN.length >= 8
        ? createNetlifyClient({
            siteId: env.BLOG_NETLIFY_SITE_ID,
            apiToken: env.BLOG_NETLIFY_API_TOKEN,
            publicOrigin: buildEnv.publicOrigin,
            fetchImpl,
          })
        : null
    );
    if (client) {
      const verification = await verifyDeployEvidence({
        netlifyClient: client,
        deployId: activeCode.data.deployId,
        releaseId: activeCode.data.releaseId,
        expectedDigest: activeCode.data.expectedDigest,
      });
      if (verification.outcome === 'live' || verification.outcome === 'failed') {
        await callRpc('blog_build_release_code_slot', {
          p_deploy_id: activeCode.data.deployId,
          p_generation: activeCode.data.generation,
          p_outcome: verification.outcome === 'live' ? 'ready' : 'failed',
          p_published_deploy_id: verification.publishedDeployId,
        });
      }
    }
  }

  const result = await callRpc('blog_build_acquire', {
    p_deploy_id: buildEnv.deployId,
    p_hook_payload: hookPayload,
  });
  if (result?.error || !result?.data) {
    throw new Error(`Failed to acquire production build slot: ${result?.error?.code ?? 'unavailable'}`);
  }
  const data = result.data;
  if (!isBuildReleaseId(data.releaseId) || typeof data.payload !== 'string'
      || !SHA256_PATTERN.test(data.digest ?? '') || !Number.isSafeInteger(data.generation)) {
    throw new Error('Acquired release envelope is invalid.');
  }
  const actualDigest = createHash('sha256').update(data.payload, 'utf8').digest('hex');
  if (actualDigest !== data.digest) {
    throw new Error('Acquired release digest does not match payload.');
  }
  let parsedPayload;
  try { parsedPayload = JSON.parse(data.payload); } catch {
    throw new Error('Acquired release payload is not valid JSON.');
  }
  if (!parsedPayload || parsedPayload.releaseId !== data.releaseId || parsedPayload.schemaVersion !== 1) {
    throw new Error('Acquired release payload identity mismatch.');
  }
  return Object.freeze({
    releaseId: data.releaseId.toLowerCase(),
    payload: data.payload,
    digest: data.digest,
    generation: data.generation,
    deployId: buildEnv.deployId,
    buildKind: data.buildKind,
    publicOrigin: buildEnv.publicOrigin,
    publicStorageOrigin: buildEnv.publicStorageOrigin,
  });
}

export async function assertBuildCurrent({ deployId, releaseId, generation, env = process.env, rpc, fetchImpl = fetch } = {}) {
  if (typeof deployId !== 'string' || !DEPLOY_ID_PATTERN.test(deployId) || !isBuildReleaseId(releaseId)) {
    throw new Error('Build identity is invalid.');
  }
  const callRpc = rpc ?? createBuildRpc(env, fetchImpl);
  const result = await callRpc('blog_build_assert_current', {
    p_deploy_id: deployId,
    p_release_id: releaseId,
    p_generation: generation ?? null,
  });
  if (result?.error || result?.data?.ok !== true) {
    throw new Error(`Build slot assertion failed: ${result?.error?.code ?? 'stale'}`);
  }
  return result.data;
}
