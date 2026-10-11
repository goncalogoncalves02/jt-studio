import { createHash } from 'node:crypto';
import { validateDraft } from '../../src/blog/content-validate.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class BlogRepositoryError extends Error {
  constructor(status, message, code = 'BLOG_REPOSITORY_ERROR') {
    super(message);
    this.name = 'BlogRepositoryError';
    this.status = status;
    this.code = code;
  }
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BlogRepositoryError(400, `${label} is invalid`, 'BLOG_INVALID_INPUT');
  }
}

function assertAuth(auth) {
  if (!auth || !auth.client || typeof auth.client.rpc !== 'function') {
    throw new BlogRepositoryError(401, 'An authenticated database client is required', 'BLOG_AUTH_REQUIRED');
  }
  if (typeof auth.sessionId !== 'string' || !UUID_PATTERN.test(auth.sessionId)
      || !Number.isSafeInteger(auth.generation) || auth.generation < 1) {
    throw new BlogRepositoryError(401, 'An active editor session is required', 'BLOG_AUTH_REQUIRED');
  }
}

function mapRpcError(error) {
  switch (error?.code) {
    case '40001':
      return new BlogRepositoryError(409, 'The editorial state changed; reload the current revision.', 'BLOG_STALE_REVISION');
    case '23505':
      return new BlogRepositoryError(409, 'This editorial slug is already in use.', 'BLOG_SLUG_CONFLICT');
    case '42501':
      return new BlogRepositoryError(403, 'The editorial operation is not authorized.', 'BLOG_FORBIDDEN');
    case '23514':
    case '22023':
      return new BlogRepositoryError(400, 'The editorial input is incomplete or invalid.', 'BLOG_INVALID_INPUT');
    default:
      return new BlogRepositoryError(503, 'The editorial service is temporarily unavailable.', 'BLOG_SERVICE_UNAVAILABLE');
  }
}

async function rpc(auth, name, args) {
  assertAuth(auth);
  const { data, error } = await auth.client.rpc(name, args);
  if (error) throw mapRpcError(error);
  return data;
}

export async function savePost(auth, input, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new BlogRepositoryError(400, 'Expected revision is invalid', 'BLOG_INVALID_INPUT');
  }
  const { id, ...draftInput } = input ?? {};
  if (id !== undefined) assertUuid(id, 'Post id');
  const draft = validateDraft(draftInput);
  const p_input = id === undefined ? draft : { ...draft, id };
  return rpc(auth, 'blog_save_post', {
    p_input,
    p_expected_revision: expectedRevision,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  });
}

export async function markPrepared(auth, postId, expectedRevision, action) {
  assertUuid(postId, 'Post id');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new BlogRepositoryError(400, 'Expected revision is invalid', 'BLOG_INVALID_INPUT');
  }
  if (!['upsert', 'remove'].includes(action)) {
    throw new BlogRepositoryError(400, 'Prepared action is invalid', 'BLOG_INVALID_INPUT');
  }
  return rpc(auth, 'blog_mark_prepared', {
    p_post_id: postId,
    p_expected_revision: expectedRevision,
    p_action: action,
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  });
}

export async function getPublicationSummary(auth) {
  return rpc(auth, 'blog_publication_summary', {
    p_session_id: auth.sessionId,
    p_generation: auth.generation,
  });
}

export async function freezeRelease(auth, requestId, expectedDigest) {
  assertUuid(requestId, 'Request id');
  if (typeof expectedDigest !== 'string' || !SHA256_PATTERN.test(expectedDigest)) {
    throw new BlogRepositoryError(400, 'Publication summary digest is invalid', 'BLOG_INVALID_INPUT');
  }
  const release = await rpc(auth, 'blog_freeze_release', {
    p_request_id: requestId,
    p_generation: auth.generation,
    p_session_id: auth.sessionId,
    p_expected_digest: expectedDigest,
  });
  if (!release || typeof release !== 'object'
    || typeof release.releaseId !== 'string'
    || typeof release.payload !== 'string'
    || typeof release.digest !== 'string' || !SHA256_PATTERN.test(release.digest)) {
    throw new BlogRepositoryError(503, 'The confirmed release response is invalid.', 'BLOG_INVALID_RELEASE');
  }
  const digest = createHash('sha256').update(release.payload, 'utf8').digest('hex');
  if (digest !== release.digest) {
    throw new BlogRepositoryError(503, 'The confirmed release digest does not match its payload.', 'BLOG_INVALID_RELEASE');
  }
  let payload;
  try { payload = JSON.parse(release.payload); } catch {
    throw new BlogRepositoryError(503, 'The confirmed release payload is invalid.', 'BLOG_INVALID_RELEASE');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.releaseId !== release.releaseId || payload.schemaVersion !== 1
    || !Array.isArray(payload.posts)) {
    throw new BlogRepositoryError(503, 'The confirmed release payload does not match its envelope.', 'BLOG_INVALID_RELEASE');
  }
  return { releaseId: release.releaseId, payload: release.payload, digest: release.digest };
}
