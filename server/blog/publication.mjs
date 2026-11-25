import { randomUUID } from 'node:crypto';
import { promotePublicationVariant } from './media.mjs';
import { verifyDeployEvidence } from './netlify-api.mjs';
import { isBuildReleaseId } from './release-id.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const HOOK_PATH_PATTERN = /^\/build_hooks\/[A-Za-z0-9_-]{8,128}$/u;
const DEPLOY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const DEFAULT_HOOK_TIMEOUT_MS = 12_000;

export class BlogPublicationError extends Error {
  constructor(status, code, message = 'The publication request could not be completed.') {
    super(message);
    this.name = 'BlogPublicationError';
    this.status = status;
    this.code = code;
  }
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
  }
  return value.toLowerCase();
}

function assertPublicationAuth(auth) {
  if (!auth || !auth.serviceClient || !auth.userSdk || !UUID_PATTERN.test(auth.userId ?? '')
      || !UUID_PATTERN.test(auth.sessionId ?? '') || !UUID_PATTERN.test(auth.authSessionId ?? '')
      || !Number.isSafeInteger(auth.generation) || auth.generation < 1) {
    throw new BlogPublicationError(401, 'BLOG_AUTH_REQUIRED');
  }
  return auth;
}

function rpcData(result) {
  if (!result || !result.error) return result?.data;
  if (typeof result.error.code === 'string' && /^[0-9A-Z]{5}$/u.test(result.error.code)) {
    process.stderr.write(`task7-rpc-sqlstate-${result.error.code}\n`);
  }
  if (result.error.code === '42501') throw new BlogPublicationError(403, 'BLOG_FORBIDDEN');
  if (result.error.code === '40001' || result.error.code === '23505') throw new BlogPublicationError(409, 'BLOG_PUBLICATION_CONFLICT');
  if (result.error.code === '22023' || result.error.code === '23514') throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
  throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
}

function safeStatus(value) {
  const allowed = new Set(['confirmed', 'promoting', 'queued', 'building', 'live', 'failed', 'unknown']);
  if (!value || typeof value !== 'object' || !UUID_PATTERN.test(value.requestId ?? '')
      || !UUID_PATTERN.test(value.releaseId ?? '') || !allowed.has(value.state)) {
    throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
  }
  return Object.freeze({
    requestId: value.requestId.toLowerCase(),
    releaseId: value.releaseId.toLowerCase(),
    state: value.state,
    ...(UUID_PATTERN.test(value.attemptId ?? '') ? { attemptId: value.attemptId.toLowerCase() } : {}),
    ...(typeof value.deployId === 'string' && DEPLOY_ID_PATTERN.test(value.deployId) ? { deployId: value.deployId } : {}),
  });
}

function validateSummary(summary) {
  if (!summary || typeof summary !== 'object' || !DIGEST_PATTERN.test(summary.digest ?? '')
      || !Array.isArray(summary.changes)
      || !isBuildReleaseId(summary.baseReleaseId)) {
    throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
  }
  const changes = summary.changes.map((change) => {
    if (!change || !UUID_PATTERN.test(change.postId ?? '') || !Number.isSafeInteger(change.revision)
        || change.revision < 1 || !['upsert', 'remove'].includes(change.action)) {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }
    return Object.freeze({ postId: change.postId.toLowerCase(), revision: change.revision, action: change.action });
  });
  return Object.freeze({ baseReleaseId: summary.baseReleaseId.toLowerCase(), changes: Object.freeze(changes), digest: summary.digest });
}

export function parsePublicationHookUrl(value) {
  if (typeof value !== 'string' || value.length > 512) throw new TypeError('Publication hook configuration is invalid.');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Publication hook configuration is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.netlify.com' || url.port !== ''
      || url.username || url.password || url.search || url.hash || !HOOK_PATH_PATTERN.test(url.pathname)
      || url.origin !== 'https://api.netlify.com' || url.toString() !== value) {
    throw new TypeError('Publication hook configuration is invalid.');
  }
  return url.toString();
}

export function createPublicationService({ rpc, hookUrl, fetchImpl = fetch, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS, promoteVariant = promotePublicationVariant, netlifyClient, deadlineSignal } = {}) {
  if (typeof rpc !== 'function' || typeof fetchImpl !== 'function' || typeof promoteVariant !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
    throw new TypeError('Publication service dependencies are invalid.');
  }
  const getHookUrl = () => parsePublicationHookUrl(hookUrl);
  const assertWithinDeadline = () => {
    if (deadlineSignal?.aborted) throw deadlineSignal.reason ?? new DOMException('Request deadline elapsed', 'TimeoutError');
  };

  async function dispatchPublication(auth, requestId, attemptId) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    const attempt = assertUuid(attemptId);
    const authority = { p_user_id: session.userId, p_session_id: session.sessionId,
      p_auth_session_id: session.authSessionId, p_generation: session.generation };
    let endpoint;
    try { endpoint = getHookUrl(); }
    catch {
      try {
        await session.serviceClient.rpc('blog_publication_mark_pre_dispatch_failed', { ...authority, p_request_id: id });
      } catch { /* Missing configuration remains unavailable; no network claim was made. */ }
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }
    const claim = rpcData(await rpc('blog_publication_dispatch_claim', { ...authority, p_request_id: id, p_attempt_id: attempt }));
    assertWithinDeadline();
    if (claim?.claimed !== true) {
      if (process.env.JT_TASK7_DIAGNOSTICS === '1') process.stderr.write('task7-dispatch-claim-not-owned\n');
      return safeStatus(claim?.status ?? claim);
    }
    if (process.env.JT_TASK7_DIAGNOSTICS === '1') process.stderr.write('task7-dispatch-claim-owned\n');
    const releaseId = assertUuid(claim.releaseId);
    const storedAttemptId = assertUuid(claim.attemptId);
    if (claim.requestId?.toLowerCase() !== id || storedAttemptId !== attempt
        || !Number.isSafeInteger(claim.generation) || claim.generation < 1) {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }

    const beforeDispatch = safeStatus(rpcData(await session.serviceClient.rpc('blog_publication_status', {
      ...authority,
      p_request_id: id,
    })));
    assertWithinDeadline();
    if (beforeDispatch.requestId !== id || beforeDispatch.releaseId !== releaseId
        || beforeDispatch.attemptId !== storedAttemptId || beforeDispatch.state !== 'unknown') {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }

    const body = JSON.stringify({ requestId: id, releaseId, attemptId: storedAttemptId });
    let resultState = 'unknown';
    try {
      const response = await fetchImpl(`${endpoint}?trigger_branch=main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: deadlineSignal ? AbortSignal.any([deadlineSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (process.env.JT_TASK7_DIAGNOSTICS === '1') process.stderr.write(`task7-dispatch-http-${response.status}\n`);
      resultState = response.status >= 200 && response.status < 300 ? 'queued' : 'unknown';
      await response.body?.cancel().catch(() => {});
    } catch {
      resultState = 'unknown';
    }

    if (deadlineSignal?.aborted) return safeStatus({ requestId: id, releaseId, attemptId: storedAttemptId, state: 'unknown' });

    try {
      const stored = rpcData(await rpc('blog_publication_dispatch_result', {
        ...authority,
        p_request_id: id,
        p_attempt_id: storedAttemptId,
        p_state: resultState,
      }));
      return safeStatus(stored);
    } catch {
      // A lost result write leaves a durable claim; reads project that as unknown.
      return safeStatus({ requestId: id, releaseId, attemptId: storedAttemptId, state: 'unknown' });
    }
  }

  async function preparePublication(auth) {
    const session = assertPublicationAuth(auth);
    const result = await session.userSdk.rpc('blog_publication_summary', {
      p_session_id: session.sessionId,
      p_generation: session.generation,
    });
    assertWithinDeadline();
    return validateSummary(rpcData(result));
  }

  async function reconcileActiveCodeSlot() {
    if (!netlifyClient) return;
    const activeCode = rpcData(await rpc('blog_build_active_code_slot'));
    assertWithinDeadline();
    if (!activeCode?.active || !activeCode.deployId || !Number.isSafeInteger(activeCode.generation)) return;
    const verification = await verifyDeployEvidence({
      netlifyClient,
      deployId: activeCode.deployId,
      releaseId: activeCode.releaseId,
      expectedDigest: activeCode.expectedDigest,
      deadlineSignal,
    });
    if (verification.outcome === 'live' || verification.outcome === 'failed') {
      rpcData(await rpc('blog_build_release_code_slot', {
        p_deploy_id: activeCode.deployId,
        p_generation: activeCode.generation,
        p_outcome: verification.outcome === 'live' ? 'ready' : 'failed',
        p_published_deploy_id: verification.publishedDeployId,
      }));
      assertWithinDeadline();
    }
  }

  async function confirmPublication(auth, { requestId, expectedDigest } = {}) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    if (!DIGEST_PATTERN.test(expectedDigest ?? '')) throw new BlogPublicationError(400, 'BLOG_INVALID_INPUT');
    if (netlifyClient) {
      await reconcileActiveCodeSlot().catch((error) => {
        if (error instanceof BlogPublicationError && error.status === 409) return;
        throw error;
      });
    }
    const data = rpcData(await session.userSdk.rpc('blog_freeze_release', {
      p_generation: session.generation,
      p_session_id: session.sessionId,
      p_request_id: id,
      p_expected_digest: expectedDigest,
    }));
    assertWithinDeadline();
    if (!UUID_PATTERN.test(data?.releaseId ?? '')) throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    return statusPublication(session, { requestId: id });
  }

  async function advancePublication(auth, { requestId } = {}) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    const data = rpcData(await session.serviceClient.rpc('blog_publication_next_variant', {
      p_user_id: session.userId,
      p_session_id: session.sessionId,
      p_auth_session_id: session.authSessionId,
      p_generation: session.generation,
      p_request_id: id,
    }));
    assertWithinDeadline();
    if (data?.complete === true) {
      const status = safeStatus(data.status);
      if (status.state !== 'confirmed') return status;
      return dispatchPublication(session, id, randomUUID());
    }
    if (!data || data.requestId?.toLowerCase() !== id || !UUID_PATTERN.test(data.releaseId ?? '')
        || typeof data.mediaId !== 'string' || !Number.isInteger(data.width)) {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }
    const variant = Object.freeze({ requestId: id, mediaId: data.mediaId, width: data.width });
    await promoteVariant(session, variant);
    assertWithinDeadline();
    const persisted = await statusPublication(session, { requestId: id });
    if (persisted.state !== 'promoting') return persisted;
    return Object.freeze({ requestId: id, releaseId: data.releaseId.toLowerCase(), state: 'promoting',
      completedVariant: Object.freeze({ mediaId: data.mediaId, width: data.width }) });
  }

  async function retryPublication(auth, { requestId, retryId } = {}) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    const retry = assertUuid(retryId);
    const data = rpcData(await session.serviceClient.rpc('blog_publication_retry', {
      p_user_id: session.userId,
      p_session_id: session.sessionId,
      p_auth_session_id: session.authSessionId,
      p_generation: session.generation,
      p_request_id: id,
      p_retry_id: retry,
    }));
    assertWithinDeadline();
    return safeStatus(data);
  }

  async function statusPublication(auth, { requestId } = {}) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    const data = rpcData(await session.serviceClient.rpc('blog_publication_status', {
      p_user_id: session.userId,
      p_session_id: session.sessionId,
      p_auth_session_id: session.authSessionId,
      p_generation: session.generation,
      p_request_id: id,
    }));
    assertWithinDeadline();
    return safeStatus(data);
  }

  async function reconcilePublication(auth, { requestId } = {}) {
    const session = assertPublicationAuth(auth);
    const id = assertUuid(requestId);
    if (!netlifyClient) {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }
    const authority = {
      p_user_id: session.userId,
      p_session_id: session.sessionId,
      p_auth_session_id: session.authSessionId,
      p_generation: session.generation,
    };
    const ctx = rpcData(await rpc('blog_publication_reconcile_read', { ...authority, p_request_id: id }));
    assertWithinDeadline();
    if (!ctx || typeof ctx !== 'object' || !UUID_PATTERN.test(ctx.releaseId ?? '')) {
      throw new BlogPublicationError(503, 'BLOG_PUBLICATION_UNAVAILABLE');
    }
    if (ctx.state === 'live' || ctx.state === 'failed' || ctx.activeRequestId !== id) {
      return safeStatus({ requestId: id, releaseId: ctx.releaseId, state: ctx.state, attemptId: ctx.attemptId, deployId: ctx.reconciledDeployId ?? null });
    }
    if (!ctx.activeDeployId || !Number.isSafeInteger(ctx.publicationGeneration)) {
      return safeStatus({ requestId: id, releaseId: ctx.releaseId, state: ctx.state, attemptId: ctx.attemptId });
    }

    const deployId = ctx.activeDeployId;
    const verification = await verifyDeployEvidence({
      netlifyClient,
      deployId,
      releaseId: ctx.releaseId,
      expectedDigest: ctx.expectedDigest,
      deadlineSignal,
    });
    assertWithinDeadline();

    if (verification.outcome === 'pending') {
      return safeStatus({ requestId: id, releaseId: ctx.releaseId, state: ctx.state, attemptId: ctx.attemptId, deployId });
    }

    const committed = safeStatus(rpcData(await rpc('blog_publication_reconcile_commit', {
      ...authority,
      p_request_id: id,
      p_publication_generation: ctx.publicationGeneration,
      p_deploy_id: deployId,
      p_outcome: verification.outcome,
      p_published_deploy_id: verification.publishedDeployId,
    })));
    return committed;
  }

  return Object.freeze({ preparePublication, confirmPublication, advancePublication, retryPublication, statusPublication, reconcilePublication, dispatchPublication });
}

export async function dispatchPublication(auth, requestId, attemptId, dependencies) {
  return createPublicationService(dependencies).dispatchPublication(auth, requestId, attemptId);
}
