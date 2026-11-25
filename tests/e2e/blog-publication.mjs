import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { createServerClient, createAuthClient, readBlogConfig } from '../../server/blog/config.mjs';
import { createNetlifyClient } from '../../server/blog/netlify-api.mjs';
import { createPublicationService } from '../../server/blog/publication.mjs';
import { buildBlog } from '../../scripts/build-blog.mjs';
import { acquireBuild, assertBuildCurrent } from '../../scripts/production-release.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const projectId = 'jt-studio-blog-tests';
const apiPort = 54341;
const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');

function dockerContextSocket() {
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) throw new Error('docker-local-socket');
  return endpoint.slice('unix://'.length);
}

export async function runPublicationProof() {
  let phase = 'setup';
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: dockerContextSocket(),
    allowedNames: new Set([
      `supabase_db_${projectId}`,
      `supabase_auth_${projectId}`,
      `supabase_rest_${projectId}`,
      `supabase_kong_${projectId}`,
    ]),
  });

  const runId = randomUUID().slice(0, 8);
  const codeDeployId = `e2e-code-${runId}`;
  const edDeploy1 = `e2e-ed1-${runId}`;
  const edDeploy2 = `e2e-ed2-${runId}`;
  const runDeployIds = [codeDeployId, edDeploy1, edDeploy2];

  const hookRequests = [];
  const droppedHookBodies = [];
  let hookShouldFailTransport = false;
  let providerDeploy = null;
  let providerDeployStatus = 200;
  let providerPublishedDeployId = `e2e-base-${runId}`;
  let publicManifest = null;
  let publicManifestStatus = 404;

  const mockProvider = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname.startsWith('/build_hooks/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (hookShouldFailTransport) {
        droppedHookBodies.push(parsed);
        req.socket.destroy();
        return;
      }
      hookRequests.push(parsed);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/deploys/')) {
      if (providerDeployStatus !== 200 || !providerDeploy || url.pathname !== `/api/v1/deploys/${providerDeploy.id}`) {
        res.writeHead(providerDeployStatus === 200 ? 404 : providerDeployStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(providerDeploy));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/sites/site-local-test') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'site-local-test',
        published_deploy: providerPublishedDeployId ? { id: providerPublishedDeployId } : null,
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/blog-release.json') {
      res.writeHead(publicManifestStatus, { 'content-type': 'application/json' });
      res.end(publicManifest ? JSON.stringify(publicManifest) : '');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolveListen) => mockProvider.listen(0, '127.0.0.1', resolveListen));
  const { port: providerPort } = mockProvider.address();
  const providerOrigin = `http://127.0.0.1:${providerPort}`;
  const tempRoot = await mkdtemp(join(tmpdir(), 'jt-task8-e2e-'));
  let db;
  let db2;
  let status;
  let fixtureUserId;
  let authSessionId;
  let appSessionId;
  let ownerSet = false;
  let initialSlot;
  let reqId;
  let releaseId;
  let savedPostId;
  const cleanupFailures = [];
  let primaryFailure = null;

  try {
    const socketPath = await proxy.listen();
    const environment = createSupabaseCliEnvironment(process.env, socketPath);
    const statusResult = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env: environment });
    status = JSON.parse(statusResult.stdout);
    validateLocalDatabaseTarget(status, projectId, 54342);
    assert.equal(status.API_URL, `http://127.0.0.1:${apiPort}`, 'API_URL must be exact local loopback');
    assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY && status.DB_URL);

    db = new pg.Client({ connectionString: status.DB_URL });
    db2 = new pg.Client({ connectionString: status.DB_URL });
    await db.connect();
    await db2.connect();

    phase = 'baseline-verify';
    const baseline = await db.query(`
      select
        (select authorized_owner_id from blog_private.settings where singleton) as owner_id,
        (select count(*)::int from blog_private.admin_sessions where revoked_at is null) as active_sessions_count,
        (select to_jsonb(b) from blog_private.build_slot b where b.singleton) as slot
    `);
    const baseRow = baseline.rows[0];
    assert.equal(baseRow.owner_id, null, 'requires owner NULL baseline');
    assert.equal(baseRow.active_sessions_count, 0, 'requires zero active admin sessions');
    initialSlot = baseRow.slot;
    assert.equal(initialSlot.active_request_id, null, 'requires clean active_request_id');
    assert.equal(initialSlot.active_deploy_id, null, 'requires clean active_deploy_id');
    assert.equal(initialSlot.active_build_kind, null, 'requires clean active_build_kind');
    assert.equal(initialSlot.active_build_release_id, null, 'requires clean active_build_release_id');
    assert.equal(initialSlot.active_build_generation, null, 'requires clean active_build_generation');
    assert.equal(initialSlot.active_attempt_id, null, 'requires clean active_attempt_id');
    process.stdout.write('PASS baseline-verify\n');

    phase = 'auth-setup';
    const ownerEmail = `task8-${randomUUID()}@example.invalid`;
    const ownerPassword = `Task8-${randomUUID()}-Pw!`;
    const createdUser = await fetch(new URL('/auth/v1/admin/users', status.API_URL), {
      method: 'POST',
      headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, email_confirm: true }),
    }).then((r) => r.json());
    fixtureUserId = createdUser.id;
    assert.ok(fixtureUserId);

    const ownPostCount = await db.query('select count(*)::int as c from public.blog_posts where owner_id = $1', [fixtureUserId]);
    assert.equal(ownPostCount.rows[0].c, 0, 'unique fixture owner must have no initial rows');

    const signIn = await fetch(new URL('/auth/v1/token?grant_type=password', status.API_URL), {
      method: 'POST',
      headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    }).then((r) => r.json());
    assert.ok(signIn.access_token);
    const jwtPayload = JSON.parse(Buffer.from(signIn.access_token.split('.')[1], 'base64url').toString('utf8'));
    authSessionId = jwtPayload.session_id;
    appSessionId = randomUUID();

    const ownerClaim = await db.query(
      'update blog_private.settings set authorized_owner_id = $1 where singleton and authorized_owner_id is null',
      [fixtureUserId],
    );
    assert.equal(ownerClaim.rowCount, 1, 'owner CAS claim failed');
    ownerSet = true;

    await db.query(
      `insert into blog_private.admin_sessions(session_id, user_id, auth_session_id, generation, cookie_digest, expires_at, auth_expires_at, token_ciphertext)
       values($1, $2, $3, 1, extensions.digest($1::uuid::text, 'sha256'), clock_timestamp() + interval '10 minutes', clock_timestamp() + interval '10 minutes', 'v1.a.a.a')`,
      [appSessionId, fixtureUserId, authSessionId],
    );

    const config = readBlogConfig({
      SUPABASE_URL: status.API_URL,
      SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      BLOG_ADMIN_USER_ID: fixtureUserId,
      BLOG_SESSION_ENCRYPTION_KEY: 'a'.repeat(64),
      BLOG_PUBLIC_ORIGIN: 'https://jt-task8.example.invalid',
    });
    const serviceClient = createServerClient(config);
    const userSdk = createAuthClient(config, signIn.access_token);
    const auth = { userId: fixtureUserId, sessionId: appSessionId, authSessionId, generation: 1, userSdk, serviceClient };

    const localApiOrigin = new URL(status.API_URL).origin;
    const localFetch = (url, init) => {
      const parsed = new URL(typeof url === 'string' ? url : url.url);
      if (parsed.hostname === 'api.netlify.com' || parsed.origin === 'https://jt-task8.example.invalid') {
        const mapped = new URL(parsed.pathname + parsed.search, providerOrigin);
        return fetch(mapped, { ...init, redirect: 'error' });
      }
      if (parsed.origin === localApiOrigin) {
        return fetch(url, init);
      }
      throw new TypeError(`Blocked unrecognized external origin in Task 8 E2E: ${parsed.origin}`);
    };

    const netlifyClient = createNetlifyClient({
      siteId: 'site-local-test',
      apiToken: 'local-test-token',
      publicOrigin: 'https://jt-task8.example.invalid',
      fetchImpl: localFetch,
    });
    const pubService = createPublicationService({
      rpc: (name, args) => serviceClient.rpc(name, args),
      hookUrl: 'https://api.netlify.com/build_hooks/localtest123',
      fetchImpl: localFetch,
      netlifyClient,
    });

    phase = 'code-build-and-contention';
    const saved = await userSdk.rpc('blog_save_post', {
      p_input: {
        title: `Task 8 E2E Post ${runId}`,
        slug: `task8-e2e-${runId}`,
        excerpt: 'Task 8 E2E excerpt',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task 8 E2E body' }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: 0,
      p_session_id: appSessionId,
      p_generation: 1,
    });
    assert.ok(saved.data?.id);
    savedPostId = saved.data.id;
    await userSdk.rpc('blog_mark_prepared', { p_post_id: savedPostId, p_expected_revision: 1, p_action: 'upsert', p_session_id: appSessionId, p_generation: 1 });
    const summary = await pubService.preparePublication(auth);
    assert.deepEqual(summary.changes.map((c) => c.postId), [savedPostId], 'summary changes must contain only newly saved own post');

    const codeEnv = {
      SUPABASE_URL: status.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      DEPLOY_ID: codeDeployId,
      CONTEXT: 'production',
      BRANCH: 'main',
      SITE_ID: 'site-local-test',
      BLOG_NETLIFY_SITE_ID: 'site-local-test',
      BLOG_NETLIFY_API_TOKEN: 'local-test-token',
      BLOG_PUBLIC_ORIGIN: 'https://jt-task8.example.invalid',
      BLOG_PUBLIC_STORAGE_ORIGIN: 'https://project.supabase.co',
    };
    const acquiredCode = await acquireBuild({ env: codeEnv, fetchImpl: localFetch, netlifyClient });
    assert.equal(acquiredCode.buildKind, 'code');

    // Physical contention: hold build_slot lock on db, start actual blog_build_acquire RPC in contender, observe pg_blocking_pids, then release lock and confirm contender fails (40001).
    await db.query('begin');
    await db.query('select 1 from blog_private.build_slot where singleton for update');
    const blockerPid = (await db.query('select pg_backend_pid() as pid')).rows[0].pid;
    await db2.query('begin');
    await db2.query('set local role service_role');
    await db2.query("select set_config('request.jwt.claim.role', 'service_role', true)");
    const contenderPromise = db2.query('select public.blog_build_acquire($1, null)', [`e2e-contend-${runId}`])
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, code: err.code }));
    let observedBlock = false;
    for (let i = 0; i < 20; i += 1) {
      const waitCheck = await db.query('select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [blockerPid]);
      if (waitCheck.rowCount > 0) {
        observedBlock = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(observedBlock, true, 'must observe physical pg_blocking_pids contention on build_slot');
    await db.query('rollback');
    const contenderOutcome = await contenderPromise;
    await db2.query('rollback').catch(() => {});
    assert.equal(contenderOutcome.ok, false);
    assert.equal(contenderOutcome.code, '40001');
    process.stdout.write('PASS code-build-and-physical-contention\n');

    reqId = randomUUID();
    providerDeploy = { id: codeDeployId, site_id: 'site-local-test', context: 'production', branch: 'main', state: 'building' };
    await assert.rejects(pubService.confirmPublication(auth, { requestId: reqId, expectedDigest: summary.digest }), (e) => e.status === 409);

    providerDeploy = { id: codeDeployId, site_id: 'site-local-test', context: 'production', branch: 'main', state: 'ready' };
    providerPublishedDeployId = codeDeployId;
    publicManifestStatus = 200;
    publicManifest = { releaseId: acquiredCode.releaseId, deployId: codeDeployId, digest: acquiredCode.digest, schema: 1 };

    const confirmed = await pubService.confirmPublication(auth, { requestId: reqId, expectedDigest: summary.digest });
    assert.equal(confirmed.state, 'confirmed');
    releaseId = confirmed.releaseId;
    process.stdout.write('PASS code-slot-released-and-editorial-confirmed\n');

    phase = 'dispatch-lost-response';
    hookShouldFailTransport = true;
    const unknownStatus = await pubService.advancePublication(auth, { requestId: reqId });
    assert.equal(unknownStatus.state, 'unknown');
    assert.equal(droppedHookBodies.length, 1);
    const duplicateUnknown = await pubService.advancePublication(auth, { requestId: reqId });
    assert.equal(duplicateUnknown.state, 'unknown');
    assert.equal(droppedHookBodies.length, 1, 'unknown duplicate must never trigger a second hook POST');
    await assert.rejects(pubService.retryPublication(auth, { requestId: reqId, retryId: randomUUID() }), (e) => e.status === 409);
    process.stdout.write('PASS dispatch-lost-response-unknown-no-retry\n');

    phase = 'editorial-build-1-and-provider-gates';
    const badDist = join(tempRoot, 'bad-dist');
    await assert.rejects(buildBlog({ mode: 'production', outDir: badDist, env: { ...codeEnv, DEPLOY_ID: `e2e-bad-${runId}` }, fetchImpl: localFetch, netlifyClient }));
    assert.equal(existsSync(badDist), false);

    const edDist1 = join(tempRoot, 'ed-dist-1');
    const built1 = await buildBlog({
      mode: 'production',
      outDir: edDist1,
      env: {
        ...codeEnv,
        DEPLOY_ID: edDeploy1,
        INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(droppedHookBodies[0])),
      },
      fetchImpl: localFetch,
      netlifyClient,
    });
    assert.equal(built1.releaseId, releaseId);

    // Lease expiry must not free the slot without terminal provider evidence.
    const expiredUpdate = await db.query(
      'update blog_private.build_slot set lease_expires_at = clock_timestamp() - interval \'1 hour\' where singleton and active_request_id = $1 and active_deploy_id = $2',
      [reqId, edDeploy1],
    );
    assert.equal(expiredUpdate.rowCount, 1);
    await assert.rejects(
      acquireBuild({ env: { ...codeEnv, DEPLOY_ID: `e2e-after-exp-${runId}` }, fetchImpl: localFetch, netlifyClient }),
      /acquire/i,
    );

    // Wrong site, preview, ready-unpublished, 404, and manifest mismatch keep slot blocked.
    providerDeploy = { id: edDeploy1, site_id: 'wrong-site', context: 'production', branch: 'main', state: 'ready' };
    providerPublishedDeployId = edDeploy1;
    assert.equal((await pubService.reconcilePublication(auth, { requestId: reqId })).state, 'building');

    providerDeploy = { id: edDeploy1, site_id: 'site-local-test', context: 'deploy-preview', branch: 'main', state: 'ready' };
    assert.equal((await pubService.reconcilePublication(auth, { requestId: reqId })).state, 'building');

    providerDeploy = { id: edDeploy1, site_id: 'site-local-test', context: 'production', branch: 'main', state: 'ready' };
    providerPublishedDeployId = codeDeployId;
    assert.equal((await pubService.reconcilePublication(auth, { requestId: reqId })).state, 'building');

    providerDeployStatus = 404;
    assert.equal((await pubService.reconcilePublication(auth, { requestId: reqId })).state, 'building');
    providerDeployStatus = 200;

    providerPublishedDeployId = edDeploy1;
    publicManifest = { releaseId, deployId: edDeploy1, digest: '0'.repeat(64), schema: 1 };
    assert.equal((await pubService.reconcilePublication(auth, { requestId: reqId })).state, 'building');

    providerDeploy = { id: edDeploy1, site_id: 'site-local-test', context: 'production', branch: 'main', state: 'error' };
    providerPublishedDeployId = codeDeployId;
    const failed = await pubService.reconcilePublication(auth, { requestId: reqId });
    assert.equal(failed.state, 'failed');
    process.stdout.write('PASS provider-gates-and-terminal-failure\n');

    phase = 'retry-build-2-and-live';
    const retried = await pubService.retryPublication(auth, { requestId: reqId, retryId: randomUUID() });
    assert.equal(retried.state, 'confirmed');
    assert.equal(retried.releaseId, releaseId);

    hookShouldFailTransport = false;
    const queued = await pubService.advancePublication(auth, { requestId: reqId });
    assert.equal(queued.state, 'queued');
    assert.equal(hookRequests.length, 1);

    const edDist2 = join(tempRoot, 'ed-dist-2');
    const ed2Env = {
      ...codeEnv,
      DEPLOY_ID: edDeploy2,
      INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hookRequests[0])),
    };
    const built2 = await buildBlog({ mode: 'production', outDir: edDist2, env: ed2Env, fetchImpl: localFetch, netlifyClient });
    assert.equal(built2.releaseId, releaseId);
    const actualManifest2 = JSON.parse(await readFile(join(edDist2, 'blog-release.json'), 'utf8'));
    assert.equal(actualManifest2.deployId, edDeploy2);
    assert.equal(actualManifest2.releaseId, releaseId);

    const activeBuild = await db.query(
      'select active_build_generation from blog_private.build_slot where singleton and active_request_id = $1 and active_deploy_id = $2',
      [reqId, edDeploy2],
    );
    assert.equal(activeBuild.rowCount, 1);
    const activeGeneration = Number(activeBuild.rows[0].active_build_generation);
    await assertBuildCurrent({ deployId: edDeploy2, releaseId, generation: activeGeneration, env: ed2Env, fetchImpl: localFetch });
    const stale = await serviceClient.rpc('blog_publication_reconcile_commit', {
      p_user_id: fixtureUserId,
      p_session_id: appSessionId,
      p_auth_session_id: authSessionId,
      p_generation: 1,
      p_request_id: reqId,
      p_publication_generation: activeGeneration,
      p_deploy_id: edDeploy1,
      p_outcome: 'live',
      p_published_deploy_id: edDeploy1,
    });
    assert.equal(stale.error?.code, '40001', 'earlier deploy must not mark the current attempt live');

    providerDeploy = { id: edDeploy2, site_id: 'site-local-test', context: 'production', branch: 'main', state: 'ready' };
    providerPublishedDeployId = edDeploy2;
    publicManifestStatus = 200;
    publicManifest = actualManifest2;
    const live = await pubService.reconcilePublication(auth, { requestId: reqId });
    assert.equal(live.state, 'live');
    assert.equal('evidence' in live, false);
    process.stdout.write('PASS retry-build-and-live\n');

    await assert.rejects(
      serviceClient.rpc('blog_publication_reconcile_commit', {
        p_user_id: fixtureUserId,
        p_session_id: appSessionId,
        p_auth_session_id: authSessionId,
        p_generation: 1,
        p_request_id: reqId,
        p_publication_generation: 1,
        p_deploy_id: edDeploy2,
        p_outcome: 'failed',
        p_published_deploy_id: codeDeployId,
      }).then((r) => { if (r.error) throw r.error; }),
    );
    process.stdout.write('PASS stale-callback-rejected\n');
  } catch (error) {
    primaryFailure = error;
  } finally {
    await db?.query('rollback').catch(() => {});
    await db2?.query('rollback').catch(() => {});

    if (db && initialSlot) {
      try {
        await db.query('begin');
        const currentRes = await db.query('select to_jsonb(b) as row from blog_private.build_slot b where b.singleton for update');
        const current = currentRes.rows[0]?.row;
        const identical = JSON.stringify(current) === JSON.stringify(initialSlot);
        if (!identical) {
          const genOk = Number.isInteger(current?.generation)
            && current.generation >= initialSlot.generation
            && current.generation <= initialSlot.generation + 4;
          const latestOk = current?.latest_confirmed_release_id === initialSlot.latest_confirmed_release_id
            || (releaseId && current?.latest_confirmed_release_id === releaseId);
          const activeReqOk = current?.active_request_id === null || (reqId && current?.active_request_id === reqId);
          const activeDeployOk = current?.active_deploy_id === null || runDeployIds.includes(current?.active_deploy_id);
          let receiptOk = true;
          if (current?.active_request_id === null && current?.active_deploy_id === null
              && current?.last_published_deploy_id && current.last_published_deploy_id !== initialSlot.last_published_deploy_id) {
            const rec = await db.query(
              'select 1 from blog_private.reconciled_deploys where deploy_id = $1 and deploy_id = any($2::text[])',
              [current.last_published_deploy_id, runDeployIds],
            );
            receiptOk = rec.rowCount === 1;
          }
          if (!ownerSet || !genOk || !latestOk || !activeReqOk || !activeDeployOk || !receiptOk) {
            cleanupFailures.push('build-slot-cas-guard');
            await db.query('rollback');
          } else {
            const restoredSlot = await db.query(
              `update blog_private.build_slot
               set latest_confirmed_release_id = $1,
                   last_published_release_id = $2,
                   last_published_deploy_id = $3,
                   active_request_id = null,
                   active_deploy_id = null,
                   active_build_kind = null,
                   active_build_release_id = null,
                   active_build_generation = null,
                   active_attempt_id = null,
                   lease_expires_at = null,
                   generation = $4,
                   updated_at = $5
               where singleton and to_jsonb(build_slot) = $6::jsonb
                 and exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = $7)`,
              [
                initialSlot.latest_confirmed_release_id,
                initialSlot.last_published_release_id,
                initialSlot.last_published_deploy_id,
                initialSlot.generation,
                initialSlot.updated_at,
                JSON.stringify(current),
                fixtureUserId,
              ],
            );
            if (restoredSlot.rowCount !== 1) {
              cleanupFailures.push('build-slot-cas-mismatch');
              await db.query('rollback');
            } else {
              await db.query('commit');
            }
          }
        } else {
          await db.query('commit');
        }
      } catch {
        await db.query('rollback').catch(() => {});
        cleanupFailures.push('build-slot-restore');
      }
    }

    if (db && fixtureUserId) {
      try {
        await db.query(
          'update blog_private.admin_sessions set revoked_at = coalesce(revoked_at, clock_timestamp()) where session_id = $1 and user_id = $2',
          [appSessionId, fixtureUserId],
        );
      } catch {
        cleanupFailures.push('fixture-session-revoke');
      }
      if (authSessionId) {
        try {
          await db.query(
            `update auth.sessions set not_after = least(coalesce(not_after, clock_timestamp()), clock_timestamp() - interval '1 second'),
                 updated_at = clock_timestamp() where id = $1 and user_id = $2`,
            [authSessionId, fixtureUserId],
          );
        } catch {
          cleanupFailures.push('fixture-auth-session-revoke');
        }
      }
      if (ownerSet) {
        try {
          const restoredOwner = await db.query(
            'update blog_private.settings set authorized_owner_id = null where singleton and authorized_owner_id = $1',
            [fixtureUserId],
          );
          if (restoredOwner.rowCount !== 1) cleanupFailures.push('owner-setting-restore');
        } catch {
          cleanupFailures.push('owner-setting-restore');
        }
      }
      try {
        const finalCheck = await db.query(
          `select
             (select authorized_owner_id is null from blog_private.settings where singleton) as owner_null,
             (select count(*)::int from blog_private.admin_sessions where revoked_at is null) as active_admin_sessions,
             (select count(*)::int from auth.sessions where user_id = $1 and (not_after is null or not_after > clock_timestamp())) as own_auth_sessions`,
          [fixtureUserId],
        );
        const row = finalCheck.rows[0];
        if (!row?.owner_null || row.active_admin_sessions !== 0 || row.own_auth_sessions !== 0) {
          cleanupFailures.push('fixture-baseline-verify');
        }
      } catch {
        cleanupFailures.push('fixture-baseline-verify');
      }
    }

    await db?.end().catch(() => cleanupFailures.push('database-close'));
    await db2?.end().catch(() => cleanupFailures.push('database2-close'));
    mockProvider.close();
    await proxy.close().catch(() => cleanupFailures.push('proxy-close'));
    await rm(tempRoot, { recursive: true, force: true }).catch(() => cleanupFailures.push('temp-cleanup'));
  }

  if (cleanupFailures.length > 0) {
    process.stderr.write(`Task 8 E2E cleanup failed: ${cleanupFailures.join(', ')}.\n`);
  }
  if (primaryFailure) {
    const code = primaryFailure?.code && /^[0-9A-Z]{5}$/u.test(primaryFailure.code) ? `-${primaryFailure.code}` : '';
    process.stderr.write(`Task 8 E2E failed during ${phase}${code}.\n`);
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    const error = new Error(`Task 8 E2E cleanup failed: ${cleanupFailures.join(', ')}`);
    error.stage = cleanupFailures[0];
    throw error;
  }
  process.stdout.write('PASS task8-e2e-complete-with-exact-cas-cleanup\n');
}
