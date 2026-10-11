import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { freezeRelease, getPublicationSummary, markPrepared, savePost } from '../../server/blog/repositories.mjs';

const auth = { userSdk: { rpc: async () => ({ data: null, error: null }) }, sessionId: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7', generation: 1 };
const draft = {
  title: '  Título  ', slug: 'titulo', excerpt: ' Excerto ', serviceId: 1,
  coverMediaId: null, document: { type: 'doc', content: [] },
};

test('savePost sends only a normalized strict draft and maps a stale revision to 409', async () => {
  let call;
  const client = { rpc: async (...args) => { call = args; return { data: { id: 'post', revision: 3 }, error: null }; } };
  const result = await savePost({ ...auth, userSdk: client }, draft, 2);
  assert.deepEqual(result, { id: 'post', revision: 3 });
  assert.equal(call[0], 'blog_save_post');
  assert.deepEqual(call[1].p_input, { ...draft, title: 'Título', excerpt: 'Excerto' });
  assert.equal(call[1].p_expected_revision, 2);
  assert.equal(call[1].p_session_id, auth.sessionId);
  assert.equal(call[1].p_generation, 1);

  const stale = { ...auth, userSdk: { rpc: async () => ({ error: { code: '40001' } }) } };
  await assert.rejects(savePost(stale, draft, 2), (error) => error.status === 409);
});

test('markPrepared and summary call their narrowly scoped RPCs with the synthetic session tuple', async () => {
  const calls = [];
  const client = { rpc: async (...args) => { calls.push(args); return { data: { preparedAction: 'upsert' }, error: null }; } };
  await markPrepared({ ...auth, userSdk: client }, 'b73b0180-b835-461f-8ca7-ced83d919bdd', 4, 'upsert');
  await getPublicationSummary({ ...auth, userSdk: client });
  assert.deepEqual(calls.map(([name]) => name), ['blog_mark_prepared', 'blog_publication_summary']);
  assert.equal(calls[0][1].p_expected_revision, 4);
  assert.equal(calls[0][1].p_action, 'upsert');
  assert.equal(calls[0][1].p_session_id, auth.sessionId);
  assert.equal(calls[1][1].p_generation, 1);
});

test('maps RPC validation, authority, conflict, and availability to the approved HTTP status matrix', async () => {
  const cases = [
    ['23514', 400],
    ['22023', 400],
    ['42501', 403],
    ['40001', 409],
    ['23505', 409],
    ['XX000', 503],
  ];
  for (const [code, status] of cases) {
    const invalid = { ...auth, userSdk: { rpc: async () => ({ error: { code } }) } };
    await assert.rejects(savePost(invalid, draft, 0), (error) => error.status === status);
  }
  const unauthenticated = { userSdk: { rpc: async () => ({ data: null, error: null }) } };
  await assert.rejects(getPublicationSummary(unauthenticated), (error) => error.status === 401);
});

test('freezeRelease returns the exact payload only when its stored digest matches the bytes', async () => {
  const payload = '{"schemaVersion":1,"releaseId":"00000000-0000-0000-0000-000000000001","posts":[]}';
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  const client = { rpc: async (name, args) => {
    assert.equal(name, 'blog_freeze_release');
    assert.equal(args.p_expected_digest, 'a'.repeat(64));
    return { data: { releaseId: '00000000-0000-0000-0000-000000000001', payload, digest }, error: null };
  } };
  const release = await freezeRelease({ ...auth, userSdk: client }, 'fc51b514-a294-4e4e-9e8c-3206df78f986', 'a'.repeat(64));
  assert.equal(release.payload, payload);
  assert.equal(release.digest, digest);
  assert.equal(release.releaseId, '00000000-0000-0000-0000-000000000001');

  const corrupted = { ...auth, userSdk: { rpc: async () => ({ data: { releaseId: 'x', payload, digest: '0'.repeat(64) } }) } };
  await assert.rejects(freezeRelease(corrupted, 'fc51b514-a294-4e4e-9e8c-3206df78f986', 'a'.repeat(64)), /digest/i);
});

test('freezeRelease preserves valid releases above the unrelated 100-post test fixture size', async () => {
  const releaseId = '00000000-0000-0000-0000-000000000001';
  const payload = JSON.stringify({ schemaVersion: 1, releaseId, posts: Array.from({ length: 101 }, (_, index) => ({ slug: `post-${index}` })) });
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  const client = { rpc: async () => ({ data: { releaseId, payload, digest }, error: null }) };
  const release = await freezeRelease({ ...auth, userSdk: client }, 'fc51b514-a294-4e4e-9e8c-3206df78f986', 'a'.repeat(64));
  assert.equal(JSON.parse(release.payload).posts.length, 101);
});
