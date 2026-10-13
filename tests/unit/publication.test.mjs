import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationService, parsePublicationHookUrl } from '../../server/blog/publication.mjs';

const requestId = '5117c4e2-1f8d-41b4-b630-9c99e9958605';
const attemptId = '720cf4d0-8061-45d0-bf30-831ceecbf89b';
const hook = 'https://api.netlify.com/build_hooks/abc12345';
const releaseId = 'a8ff489b-89d0-4426-961a-58ac0c99115d';
const digest = 'a'.repeat(64);

function harness({ fetchImpl = async () => new Response(null, { status: 204 }) } = {}) {
  const calls = [];
  let claimed = false;
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'blog_publication_dispatch_claim') {
      if (claimed) return { data: { requestId, releaseId, attemptId, state: 'unknown' }, error: null };
      claimed = true;
      return { data: { claimed: true, requestId, releaseId, attemptId, generation: 7 }, error: null };
    }
    if (name === 'blog_publication_dispatch_result') return { data: { requestId, releaseId, attemptId, state: args.p_state }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  return { service: createPublicationService({ rpc, hookUrl: hook, fetchImpl, timeoutMs: 100 }), calls };
}

test('accepts only an exact Netlify build hook URL and rejects credentials, query, fragment, alternate ports and paths', () => {
  assert.equal(parsePublicationHookUrl(hook), hook);
  for (const value of [
    'http://api.netlify.com/build_hooks/abc12345',
    'https://user:password@api.netlify.com/build_hooks/abc12345',
    'https://api.netlify.com:444/build_hooks/abc12345',
    'https://api.netlify.com/build_hooks/abc12345?branch=evil',
    'https://api.netlify.com/build_hooks/abc12345#fragment',
    'https://api.netlify.com/other/abc12345',
    'https://evil.example/build_hooks/abc12345',
  ]) assert.throws(() => parsePublicationHookUrl(value));
});

test('lost or non-success hook response is durably unknown and never retried by the dispatcher', async () => {
  let requests = 0;
  const { service, calls } = harness({ fetchImpl: async () => { requests += 1; throw new Error('connection lost'); } });
  const auth = sessionAuth();
  const first = await service.dispatchPublication(auth, requestId, attemptId);
  const second = await service.dispatchPublication(auth, requestId, attemptId);
  assert.equal(first.state, 'unknown');
  assert.equal(second.state, 'unknown');
  assert.equal(requests, 1);
  assert.equal(calls.filter((call) => call.name === 'blog_publication_dispatch_claim').length, 2);
  assert.equal(calls.filter((call) => call.name === 'blog_publication_dispatch_result').length, 1);
  assert.equal(calls.find((call) => call.name === 'blog_publication_dispatch_result').args.p_state, 'unknown');
});

test('publication deadline waits for the hook transport to abort and leaves the durable claim unknown', async () => {
  const calls = [];
  let hookSettled = false;
  const deadline = new AbortController();
  const auth = sessionAuth();
  const service = createPublicationService({
    hookUrl: hook,
    deadlineSignal: deadline.signal,
    rpc: async (name, args) => {
      calls.push(name);
      if (name === 'blog_publication_dispatch_claim') return { data: { claimed: true, requestId, releaseId, attemptId: args.p_attempt_id, generation: 7 }, error: null };
      if (name === 'blog_publication_dispatch_result') return { data: { requestId, releaseId, attemptId: args.p_attempt_id, state: args.p_state }, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { hookSettled = true; reject(init.signal.reason); }, { once: true });
    }),
  });
  const pending = service.dispatchPublication(auth, requestId, attemptId);
  setTimeout(() => deadline.abort(new DOMException('request deadline elapsed', 'TimeoutError')), 10);
  const result = await pending;
  assert.equal(hookSettled, true);
  assert.equal(result.state, 'unknown');
  assert.equal(calls.filter(name => name === 'blog_publication_dispatch_claim').length, 1);
  assert.equal(calls.includes('blog_publication_dispatch_result'), false);
});

test('successful hook POST reports queued and sends only the frozen identifiers on the fixed main branch', async () => {
  let outgoing;
  const { service } = harness({ fetchImpl: async (url, options) => {
    outgoing = { url, options };
    return new Response(null, { status: 204 });
  } });
  const status = await service.dispatchPublication(sessionAuth(), requestId, attemptId);
  assert.equal(status.state, 'queued');
  assert.equal(outgoing.url, `${hook}?trigger_branch=main`);
  assert.equal(outgoing.options.method, 'POST');
  assert.equal(outgoing.options.redirect, 'error');
  assert.deepEqual(JSON.parse(outgoing.options.body), { requestId, releaseId, attemptId });
  assert.equal(outgoing.options.headers['content-type'], 'application/json');
});

test('a revoked captured authority after dispatch claim prevents the hook POST', async () => {
  let hookRequests = 0;
  let resultWrites = 0;
  const auth = sessionAuth({ serviceRpc: async (name) => name === 'blog_publication_status'
    ? ({ data: null, error: { code: '42501' } })
    : ({ data: null, error: null }) });
  const service = createPublicationService({ hookUrl: hook,
    rpc: async (name) => {
      if (name === 'blog_publication_dispatch_claim') return { data: { claimed: true, requestId, releaseId, attemptId, generation: 7 }, error: null };
      if (name === 'blog_publication_dispatch_result') { resultWrites += 1; return { data: null, error: null }; }
      throw new Error(`unexpected rpc ${name}`);
    }, fetchImpl: async () => { hookRequests += 1; return new Response(null, { status: 204 }); },
  });
  const outcome = await service.dispatchPublication(auth, requestId, attemptId).catch((error) => error);
  assert.equal(hookRequests, 0, `revoked authority allowed ${hookRequests} hook POST(s)`);
  assert.equal(outcome?.status, 403);
  assert.equal(resultWrites, 0);
});

function sessionAuth({ userRpc, serviceRpc } = {}) {
  return {
    userId: '5117c4e2-1f8d-41b4-b630-9c99e9958605',
    sessionId: '720cf4d0-8061-45d0-bf30-831ceecbf89b',
    authSessionId: 'a8ff489b-89d0-4426-961a-58ac0c99115d',
    generation: 7,
    userSdk: { rpc: userRpc ?? (async () => ({ data: null, error: null })) },
    serviceClient: { rpc: serviceRpc ?? (async (name) => name === 'blog_publication_status'
      ? ({ data: { requestId, releaseId, attemptId, state: 'unknown' }, error: null })
      : ({ data: null, error: null })) },
  };
}

test('prepares the summary through the captured user session and exposes only the reviewed changes and digest', async () => {
  const calls = [];
  const summary = { baseReleaseId: releaseId, changes: [{ postId: requestId, revision: 3, action: 'upsert' }], digest };
  const auth = sessionAuth({ userRpc: async (...args) => { calls.push(args); return { data: summary, error: null }; } });
  const result = await createPublicationService({ rpc: async () => ({ data: null }), hookUrl: hook }).preparePublication(auth);
  assert.deepEqual(calls, [['blog_publication_summary', { p_session_id: auth.sessionId, p_generation: auth.generation }]]);
  assert.deepEqual(result, summary);
  assert.equal(Object.hasOwn(result, 'payload'), false);
});

test('confirmation uses the captured user SDK and original app session for the reservation RPC', async () => {
  const calls = [];
  const auth = sessionAuth({
    userRpc: async (...args) => {
    calls.push(args);
    return { data: { releaseId, digest, payload: '{}' }, error: null };
    },
    serviceRpc: async () => ({ data: { requestId, releaseId, state: 'confirmed' }, error: null }),
  });
  const result = await createPublicationService({ rpc: async () => ({ data: null }), hookUrl: hook })
    .confirmPublication(auth, { requestId, expectedDigest: digest });
  assert.deepEqual(calls, [['blog_freeze_release', {
    p_generation: auth.generation,
    p_session_id: auth.sessionId,
    p_request_id: requestId,
    p_expected_digest: digest,
  }]]);
  assert.deepEqual(result, { requestId, releaseId, state: 'confirmed' });
});

test('progress requests one immutable object at a time and returns only its public identity', async () => {
  const calls = [];
  const promoted = [];
  const auth = sessionAuth({ serviceRpc: async (...args) => {
    if (args[0] === 'blog_publication_status') return { data: { requestId, releaseId, state: 'promoting' }, error: null };
    calls.push(args);
    // The scheduling RPC returns only the immutable identity. The promoter
    // fetches the manifest itself after the slot and authority checks.
    return { data: { requestId, releaseId, mediaId: '00000000-0000-4000-8000-000000000305', width: 480 }, error: null };
  } });
  const result = await createPublicationService({ rpc: async () => ({ data: null }), hookUrl: hook,
    promoteVariant: async (context, variant) => { promoted.push([context, variant]); } })
    .advancePublication(auth, { requestId });
  assert.equal(calls.length, 1);
  assert.equal(promoted.length, 1);
  assert.deepEqual(promoted[0][1], { requestId, mediaId: '00000000-0000-4000-8000-000000000305', width: 480 });
  assert.equal(calls[0][0], 'blog_publication_next_variant');
  assert.deepEqual(result, { requestId, releaseId, state: 'promoting', completedVariant: { mediaId: '00000000-0000-4000-8000-000000000305', width: 480 } });
  assert.equal(JSON.stringify(result).includes('objectKey'), false);
});


test('last promotion step claims and dispatches once, while a repeated progress call reuses the durable status', async () => {
  let hookRequests = 0;
  let storedAttempt;
  const auth = sessionAuth({ serviceRpc: async (name) => {
    if (name === 'blog_publication_next_variant') return { data: { complete: true, status: { requestId, releaseId, state: 'confirmed' } }, error: null };
    if (name === 'blog_publication_status') return { data: { requestId, releaseId, attemptId: storedAttempt, state: 'unknown' }, error: null };
    return { data: null, error: null };
  } });
  const service = createPublicationService({ hookUrl: hook,
    rpc: async (name, args) => {
      if (name === 'blog_publication_dispatch_claim') {
        if (storedAttempt) return { data: { claimed: false, status: { requestId, releaseId, attemptId: storedAttempt, state: 'queued' } }, error: null };
        storedAttempt = args.p_attempt_id;
        return { data: { claimed: true, requestId, releaseId, attemptId: storedAttempt, generation: 7 }, error: null };
      }
      if (name === 'blog_publication_dispatch_result') return { data: { requestId, releaseId, attemptId: storedAttempt, state: args.p_state }, error: null };
      throw new Error(`unexpected RPC ${name}`);
    }, fetchImpl: async () => { hookRequests += 1; return new Response(null, { status: 204 }); },
  });
  const first = await service.advancePublication(auth, { requestId });
  const second = await service.advancePublication(auth, { requestId });
  assert.equal(first.state, 'queued');
  assert.equal(second.state, 'queued');
  assert.equal(hookRequests, 1);
});
