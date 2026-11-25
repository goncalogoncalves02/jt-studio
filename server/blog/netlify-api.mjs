import { isBuildReleaseId } from './release-id.mjs';

const NETLIFY_API_ORIGIN = 'https://api.netlify.com';
const SITE_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/u;
const DEPLOY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TERMINAL_FAILED_DEPLOY_STATES = new Set(['error', 'rejected', 'canceled', 'cancelled']);

export class NetlifyApiError extends Error {
  constructor(status, code, message = 'The Netlify provider request could not be completed.') {
    super(message);
    this.name = 'NetlifyApiError';
    this.status = status;
    this.code = code;
  }
}

function assertPublicOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Fixed public origin is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('Fixed public origin must be an exact HTTPS origin.');
  }
  return parsed.origin;
}

function createSignal(timeoutMs, deadlineSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return deadlineSignal ? AbortSignal.any([deadlineSignal, timeout]) : timeout;
}

async function readJsonResponse(response) {
  if (!response || response.status < 200 || response.status >= 300) {
    await response?.body?.cancel().catch(() => {});
    throw new NetlifyApiError(response?.status || 503, 'NETLIFY_PROVIDER_UNAVAILABLE');
  }
  try {
    return await response.json();
  } catch {
    throw new NetlifyApiError(502, 'NETLIFY_INVALID_RESPONSE');
  }
}

export function createNetlifyClient({
  siteId,
  apiToken,
  publicOrigin,
  fetchImpl = fetch,
  timeoutMs = 8_000,
  deadlineSignal,
} = {}) {
  if (typeof siteId !== 'string' || !SITE_ID_PATTERN.test(siteId)
      || typeof apiToken !== 'string' || apiToken.trim().length < 8
      || typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
    throw new TypeError('Netlify client configuration is invalid.');
  }
  const fixedPublicOrigin = assertPublicOrigin(publicOrigin);
  const authHeaders = Object.freeze({
    authorization: `Bearer ${apiToken}`,
    accept: 'application/json',
  });

  async function getDeploy(deployId) {
    if (typeof deployId !== 'string' || !DEPLOY_ID_PATTERN.test(deployId)) {
      throw new NetlifyApiError(400, 'NETLIFY_INVALID_DEPLOY_ID');
    }
    const url = `${NETLIFY_API_ORIGIN}/api/v1/deploys/${encodeURIComponent(deployId)}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: authHeaders,
      redirect: 'error',
      signal: createSignal(timeoutMs, deadlineSignal),
    });
    const data = await readJsonResponse(response);
    if (!data || typeof data !== 'object' || data.id !== deployId
        || typeof data.site_id !== 'string' || typeof data.context !== 'string'
        || typeof data.branch !== 'string' || typeof data.state !== 'string') {
      throw new NetlifyApiError(502, 'NETLIFY_INVALID_RESPONSE');
    }
    return Object.freeze({
      deployId: data.id,
      siteId: data.site_id,
      context: data.context,
      branch: data.branch,
      state: data.state,
    });
  }

  async function getSitePublishedDeploy() {
    const url = `${NETLIFY_API_ORIGIN}/api/v1/sites/${encodeURIComponent(siteId)}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: authHeaders,
      redirect: 'error',
      signal: createSignal(timeoutMs, deadlineSignal),
    });
    const data = await readJsonResponse(response);
    if (!data || typeof data !== 'object' || data.id !== siteId) {
      throw new NetlifyApiError(502, 'NETLIFY_INVALID_RESPONSE');
    }
    const publishedId = typeof data.published_deploy?.id === 'string' && DEPLOY_ID_PATTERN.test(data.published_deploy.id)
      ? data.published_deploy.id
      : null;
    return Object.freeze({
      siteId: data.id,
      publishedDeployId: publishedId,
    });
  }

  async function getPublicReleaseManifest() {
    const url = `${fixedPublicOrigin}/blog-release.json`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: createSignal(timeoutMs, deadlineSignal),
    });
    const data = await readJsonResponse(response);
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !isBuildReleaseId(data.releaseId)
        || typeof data.deployId !== 'string' || !DEPLOY_ID_PATTERN.test(data.deployId)
        || typeof data.digest !== 'string' || !SHA256_PATTERN.test(data.digest)
        || data.schema !== 1) {
      throw new NetlifyApiError(502, 'NETLIFY_INVALID_MANIFEST');
    }
    return Object.freeze({
      releaseId: data.releaseId.toLowerCase(),
      deployId: data.deployId,
      digest: data.digest,
      schema: 1,
    });
  }

  return Object.freeze({
    siteId,
    publicOrigin: fixedPublicOrigin,
    getDeploy,
    getSitePublishedDeploy,
    getPublicReleaseManifest,
  });
}

export async function verifyDeployEvidence({
  netlifyClient,
  deployId,
  releaseId,
  expectedDigest,
  deadlineSignal,
} = {}) {
  if (!netlifyClient || typeof deployId !== 'string' || !DEPLOY_ID_PATTERN.test(deployId)
      || !isBuildReleaseId(releaseId) || !SHA256_PATTERN.test(expectedDigest ?? '')) {
    return Object.freeze({ outcome: 'pending', publishedDeployId: null });
  }
  let deploy;
  let site;
  try {
    [deploy, site] = await Promise.all([
      netlifyClient.getDeploy(deployId),
      netlifyClient.getSitePublishedDeploy(),
    ]);
    if (deadlineSignal?.aborted) throw deadlineSignal.reason ?? new DOMException('Request deadline elapsed', 'TimeoutError');
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.code === 'NETLIFY_PROVIDER_UNAVAILABLE'
        || error?.code === 'NETLIFY_INVALID_RESPONSE' || error?.code === 'NETLIFY_INVALID_DEPLOY_ID'
        || error?.status >= 400) {
      return Object.freeze({ outcome: 'pending', publishedDeployId: null });
    }
    throw error;
  }

  if (deploy.siteId !== netlifyClient.siteId || deploy.context !== 'production' || deploy.branch !== 'main') {
    return Object.freeze({ outcome: 'pending', publishedDeployId: null });
  }

  const publishedDeployId = typeof site?.publishedDeployId === 'string' && DEPLOY_ID_PATTERN.test(site.publishedDeployId)
    ? site.publishedDeployId
    : null;
  if (!publishedDeployId) {
    return Object.freeze({ outcome: 'pending', publishedDeployId: null });
  }

  if (TERMINAL_FAILED_DEPLOY_STATES.has(deploy.state) && publishedDeployId !== deployId) {
    return Object.freeze({ outcome: 'failed', publishedDeployId });
  }

  if (deploy.state === 'ready' && publishedDeployId === deployId) {
    try {
      const manifest = await netlifyClient.getPublicReleaseManifest();
      if (deadlineSignal?.aborted) throw deadlineSignal.reason ?? new DOMException('Request deadline elapsed', 'TimeoutError');
      if (manifest.deployId === deployId
          && manifest.releaseId === releaseId.toLowerCase()
          && manifest.digest === expectedDigest
          && manifest.schema === 1) {
        return Object.freeze({ outcome: 'live', publishedDeployId });
      }
    } catch {
      return Object.freeze({ outcome: 'pending', publishedDeployId });
    }
  }

  return Object.freeze({ outcome: 'pending', publishedDeployId });
}
