import { createHash } from 'node:crypto';
import { validateDraft } from '../../src/blog/content-validate.js';
import { executeSessionMutation } from './auth.mjs';

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
  if (!auth || !auth.userSdk || typeof auth.userSdk.rpc !== 'function') {
    throw new BlogRepositoryError(401, 'An authenticated database client is required', 'BLOG_AUTH_REQUIRED');
  }
  if (typeof auth.sessionId !== 'string' || !UUID_PATTERN.test(auth.sessionId)
      || !Number.isSafeInteger(auth.generation) || auth.generation < 1) {
    throw new BlogRepositoryError(401, 'An active editor session is required', 'BLOG_AUTH_REQUIRED');
  }
}

async function rpc(auth, operation, input = {}) {
  assertAuth(auth);
  try { return await executeSessionMutation(auth, { operation, input }); }
  catch (error) {
    if (error instanceof BlogRepositoryError) throw error;
    if (error?.code === 'BLOG_STALE_REVISION') throw new BlogRepositoryError(409, 'The editorial state changed; reload the current revision.', 'BLOG_STALE_REVISION');
    if (error?.code === 'BLOG_SLUG_CONFLICT') throw new BlogRepositoryError(409, 'This editorial slug is already in use.', 'BLOG_SLUG_CONFLICT');
    if (error?.status === 403) throw new BlogRepositoryError(403, 'The editorial operation is not authorized.', 'BLOG_FORBIDDEN');
    if (error?.status === 400) throw new BlogRepositoryError(400, 'The editorial input is incomplete or invalid.', 'BLOG_INVALID_INPUT');
    if (error?.status === 401) throw new BlogRepositoryError(401, 'An active editor session is required.', 'BLOG_AUTH_REQUIRED');
    throw new BlogRepositoryError(503, 'The editorial service is temporarily unavailable.', 'BLOG_SERVICE_UNAVAILABLE');
  }
}

export async function savePost(auth, input, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new BlogRepositoryError(400, 'Expected revision is invalid', 'BLOG_INVALID_INPUT');
  }
  const { id, ...draftInput } = input ?? {};
  if (id !== undefined) assertUuid(id, 'Post id');
  const draft = validateDraft(draftInput);
  const p_input = id === undefined ? draft : { ...draft, id };
  return rpc(auth, 'savePost', { post: p_input, expectedRevision });
}

export async function markPrepared(auth, postId, expectedRevision, action) {
  assertUuid(postId, 'Post id');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new BlogRepositoryError(400, 'Expected revision is invalid', 'BLOG_INVALID_INPUT');
  }
  if (!['upsert', 'remove'].includes(action)) {
    throw new BlogRepositoryError(400, 'Prepared action is invalid', 'BLOG_INVALID_INPUT');
  }
  return rpc(auth, 'markPrepared', { postId, expectedRevision, action });
}

export async function getPublicationSummary(auth) {
  return rpc(auth, 'publicationSummary');
}

export async function freezeRelease(auth, requestId, expectedDigest) {
  assertUuid(requestId, 'Request id');
  if (typeof expectedDigest !== 'string' || !SHA256_PATTERN.test(expectedDigest)) {
    throw new BlogRepositoryError(400, 'Publication summary digest is invalid', 'BLOG_INVALID_INPUT');
  }
  const release = await rpc(auth, 'freezeRelease', { requestId, expectedDigest });
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
