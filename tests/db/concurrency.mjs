import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import {
  createSupabaseCliEnvironment,
  parseTaskProjectConfig,
  runCliCapture,
  validateLocalDatabaseTarget,
} from '../../scripts/supabase-local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectId = 'jt-studio-blog-tests';

function stop(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

function dockerSocket() {
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) stop('docker-socket');
  return endpoint.slice('unix://'.length);
}

async function openDatabase() {
  const config = parseTaskProjectConfig(await readFile(join(root, 'supabase/config.toml'), 'utf8'));
  if (config.projectId !== projectId || config.databasePort !== 54342) stop('project-config');
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: dockerSocket(),
    allowedNames: new Set([`supabase_db_${projectId}`, `supabase_auth_${projectId}`, `supabase_rest_${projectId}`, `supabase_kong_${projectId}`]),
  });
  const socketPath = await proxy.listen();
  const env = createSupabaseCliEnvironment(process.env, socketPath);
  const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
  const version = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env });
  if (version.status !== 0 || version.stdout.trim() !== '2.120.0') { await proxy.close(); stop('cli-version'); }
  const result = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env });
  if (result.status !== 0) { await proxy.close(); stop('local-status'); }
  let status;
  try { status = JSON.parse(result.stdout); } catch { await proxy.close(); stop('local-status-json'); }
  validateLocalDatabaseTarget(status, config.projectId, config.databasePort);
  const { Client } = await import('pg');
  const makeClient = () => new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 15000, application_name: 'jt-studio-task3-concurrency' });
  return { makeClient, close: () => proxy.close() };
}

async function waitForBlocking(observer, blockerPid, waiterPid, stage) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await observer.query('select $1::integer = any(pg_blocking_pids($2::integer)) as blocked', [blockerPid, waiterPid]);
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  stop(stage);
}

async function waitUntilExpired(observer, expiresAt, stage) {
  const before = await observer.query('select clock_timestamp() < $1::timestamptz as not_expired', [new Date(expiresAt)]);
  if (before.rows[0]?.not_expired !== true) stop(`${stage}-expired-before-block`);
  while (Date.now() < expiresAt + 100) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  const after = await observer.query('select clock_timestamp() >= $1::timestamptz as expired', [new Date(expiresAt)]);
  if (after.rows[0]?.expired !== true) stop(`${stage}-expiry-clock`);
}

async function setJwtSession(client, ownerId, authSessionId) {
  const claims = JSON.stringify({ sub: ownerId, session_id: authSessionId });
  await client.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)", [ownerId, claims]);
}

async function expectExpiredDenial(promise, stage) {
  try {
    const result = await promise;
    const id = result.rows?.[0]?.result?.id;
    if (id) return { id, denied: false };
    stop(`${stage}-unexpected-success`);
  } catch (error) {
    if (error.stage) throw error;
    if (error.code !== '42501') stop(`${stage}-sqlstate-${error.code ?? 'UNKNOWN'}`);
    return { denied: true };
  }
}

async function run() {
  const { makeClient, close } = await openDatabase();
  const ownerId = randomUUID();
  const sessionId = randomUUID();
  const postSessionId = randomUUID();
  const freezeSlotSessionId = randomUUID();
  const freezePostSessionId = randomUUID();
  const freshSessionId = randomUUID();
  const snapshotSessionId = randomUUID();
  const writerSessionId = randomUUID();
  const membershipSessionId = randomUUID();
  const slug = `task3-expiry-${randomUUID()}`;
  const blocker = makeClient();
  const requester = makeClient();
  const observer = makeClient();
  const monitor = makeClient();
  let ownerSetting = false;
  let previousOwnerId;
  let locked = false;
  let savedPostId;
  let preparedPostId;
  let snapshotReleaseId;
  let freezeTransactionOpen = false;
  let requestPromise;
  let membershipPreparePromise;
  let membershipFreezePromise;
  let membershipTableLocked = false;
  let membershipOuterOpen = false;
  const membershipPostIds = [];
  try {
    await Promise.all([blocker.connect(), requester.connect(), observer.connect(), monitor.connect()]);
    await requester.query('begin');
    await requester.query("select set_config('blog.task3_guc_lifecycle_probe','transaction-value',true)");
    await requester.query('commit');
    const gucLifecycle = await requester.query("select current_setting('blog.task3_guc_lifecycle_probe',true) as value");
    if (gucLifecycle.rows[0]?.value !== '') stop('task-local-guc-lifecycle');
    process.stdout.write('PASS PostgreSQL connection reuse leaves a transaction-local custom GUC as an empty string after commit\n');
    const dbIdentity = await observer.query("select current_database() as db, current_setting('server_version_num') as version");
    if (dbIdentity.rows[0]?.db !== 'postgres' || !dbIdentity.rows[0]?.version?.startsWith('17')) stop('database-identity');
    const setting = await observer.query('select authorized_owner_id from blog_private.settings where singleton for update');
    if (setting.rowCount !== 1 || setting.rows[0].authorized_owner_id !== null) stop('owner-setting-unset-baseline');
    previousOwnerId = setting.rows[0].authorized_owner_id;
    await observer.query('update blog_private.settings set authorized_owner_id=$1 where singleton', [ownerId]);
    ownerSetting = true;
    await observer.query(
      `insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,expires_at) values
       ($1,$2,$1,1,clock_timestamp()+interval '30 minutes'),
       ($3,$2,$3,1,clock_timestamp()+interval '30 minutes'),
       ($4,$2,$4,1,clock_timestamp()+interval '30 minutes'),
       ($5,$2,$5,1,clock_timestamp()+interval '30 minutes'),
       ($6,$2,$6,1,clock_timestamp()+interval '30 minutes'),
       ($7,$2,$7,1,clock_timestamp()+interval '30 minutes'),
       ($8,$2,$8,1,clock_timestamp()+interval '30 minutes'),
       ($9,$2,$9,1,clock_timestamp()+interval '30 minutes')`,
      [sessionId, ownerId, postSessionId, freezeSlotSessionId, freezePostSessionId, freshSessionId, snapshotSessionId, writerSessionId, membershipSessionId],
    );
    const inserted = await observer.query(
      "update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '6 seconds' where session_id=$1 returning expires_at",
      [sessionId],
    );
    const expiresAt = new Date(inserted.rows[0].expires_at).getTime();

    await blocker.query('begin');
    const lock = await blocker.query('select session_id from blog_private.admin_sessions where session_id=$1 for update', [sessionId]);
    if (lock.rowCount !== 1) stop('session-lock-acquire');
    locked = true;
    const blockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const requesterPid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    await setJwtSession(requester, ownerId, sessionId);
    requestPromise = requester.query(
      `select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result`,
      [JSON.stringify({ title: 'Expiry race fixture', slug, excerpt: '', document: { type: 'doc', content: [] } }), sessionId],
    );
    requestPromise.catch(() => {});

    await waitForBlocking(observer, blockerPid, requesterPid, 'session-lock-pg-blocking-pids');
    await waitUntilExpired(observer, expiresAt, 'session-lock');

    await blocker.query('commit');
    locked = false;
    const firstRace = await expectExpiredDenial(requestPromise, 'session-lock-expiry');
    if (!firstRace.denied) { savedPostId = firstRace.id; stop('expired-session-was-authorized'); }
    requestPromise = null;
    process.stdout.write('PASS session expiry revalidated after physical session-lock wait; pg_blocking_pids confirmed the wait\n');

    await setJwtSession(observer, ownerId, postSessionId);
    const draft = {
      title: 'Concurrency fixture', slug, excerpt: 'Prepared before the concurrency proofs',
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original snapshot text' }] }] },
      coverMediaId: null, serviceId: null,
    };
    const post = await observer.query('select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result', [JSON.stringify(draft), postSessionId]);
    preparedPostId = post.rows[0].result.id;
    await observer.query('select public.blog_mark_prepared($1::uuid,1,$2,$3::uuid,1)', [preparedPostId, 'upsert', postSessionId]);

    let expiryUpdate = await observer.query(
      "update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '6 seconds' where session_id=$1 returning expires_at",
      [postSessionId],
    );
    let postExpiresAt = new Date(expiryUpdate.rows[0].expires_at).getTime();
    await blocker.query('begin');
    await blocker.query('select id from public.blog_posts where id=$1 for update', [preparedPostId]);
    locked = true;
    const postBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const postRequesterPid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    await setJwtSession(requester, ownerId, postSessionId);
    requestPromise = requester.query(
      'select public.blog_save_post($1::jsonb,1,$2::uuid,1) as result',
      [JSON.stringify({ ...draft, id: preparedPostId, title: 'Expired save must not commit' }), postSessionId],
    );
    requestPromise.catch(() => {});
    await waitForBlocking(observer, postBlockerPid, postRequesterPid, 'post-lock-pg-blocking-pids');
    await waitUntilExpired(observer, postExpiresAt, 'post-lock');
    await blocker.query('commit');
    locked = false;
    const postRace = await expectExpiredDenial(requestPromise, 'post-lock-expiry');
    if (!postRace.denied) stop('expired-session-was-authorized-after-post-lock');
    requestPromise = null;
    process.stdout.write('PASS owner session expiry revalidated after save waited on a post row lock\n');

    await setJwtSession(observer, ownerId, freezeSlotSessionId);
    const summaryResult = await observer.query('select public.blog_publication_summary($1::uuid,1) as summary', [freezeSlotSessionId]);
    expiryUpdate = await observer.query(
      "update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '6 seconds' where session_id=$1 returning expires_at",
      [freezeSlotSessionId],
    );
    const slotExpiresAt = new Date(expiryUpdate.rows[0].expires_at).getTime();
    const slotRequestId = randomUUID();
    await blocker.query('begin');
    await blocker.query('select singleton from blog_private.build_slot where singleton for update');
    locked = true;
    const slotBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const slotRequesterPid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    await requester.query('begin');
    await setJwtSession(requester, ownerId, freezeSlotSessionId);
    requestPromise = requester.query(
      'select public.blog_freeze_release($1::uuid,1,$2::uuid,$3) as result',
      [slotRequestId, freezeSlotSessionId, summaryResult.rows[0].summary.digest],
    );
    requestPromise.catch(() => {});
    await waitForBlocking(observer, slotBlockerPid, slotRequesterPid, 'build-slot-pg-blocking-pids');
    await waitUntilExpired(observer, slotExpiresAt, 'build-slot');
    await blocker.query('commit');
    locked = false;
    const slotRace = await expectExpiredDenial(requestPromise, 'build-slot-expiry');
    await requester.query('rollback').catch(() => {});
    if (!slotRace.denied) stop('expired-session-was-authorized-after-build-slot');
    requestPromise = null;
    const noSlotRequest = await observer.query('select 1 from blog_private.publication_requests where request_id=$1', [slotRequestId]);
    if (noSlotRequest.rowCount !== 0) stop('expired-build-slot-request-persisted');
    process.stdout.write('PASS session expiry revalidated after freeze waited on the build slot\n');

    await setJwtSession(observer, ownerId, freezePostSessionId);
    const postSummaryResult = await observer.query('select public.blog_publication_summary($1::uuid,1) as summary', [freezePostSessionId]);
    expiryUpdate = await observer.query(
      "update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '6 seconds' where session_id=$1 returning expires_at",
      [freezePostSessionId],
    );
    postExpiresAt = new Date(expiryUpdate.rows[0].expires_at).getTime();
    const postRequestId = randomUUID();
    await blocker.query('begin');
    await blocker.query('select id from public.blog_posts where id=$1 for update', [preparedPostId]);
    locked = true;
    const freezePostBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const freezePostRequesterPid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    await requester.query('begin');
    await setJwtSession(requester, ownerId, freezePostSessionId);
    requestPromise = requester.query(
      'select public.blog_freeze_release($1::uuid,1,$2::uuid,$3) as result',
      [postRequestId, freezePostSessionId, postSummaryResult.rows[0].summary.digest],
    );
    requestPromise.catch(() => {});
    await waitForBlocking(observer, freezePostBlockerPid, freezePostRequesterPid, 'freeze-post-pg-blocking-pids');
    await waitUntilExpired(observer, postExpiresAt, 'freeze-post');
    await blocker.query('commit');
    locked = false;
    const freezePostRace = await expectExpiredDenial(requestPromise, 'freeze-post-expiry');
    await requester.query('rollback').catch(() => {});
    if (!freezePostRace.denied) stop('expired-session-was-authorized-after-freeze-post-lock');
    requestPromise = null;
    const noPostRequest = await observer.query('select 1 from blog_private.publication_requests where request_id=$1', [postRequestId]);
    if (noPostRequest.rowCount !== 0) stop('expired-freeze-post-request-persisted');
    process.stdout.write('PASS session expiry revalidated after freeze waited on prepared post rows\n');

    const fixtureId = randomUUID();
    await requester.query('begin');
    await requester.query(
      'insert into public.blog_posts(id,owner_id,title,slug,document) values($1,$2,$3,$4,$5::jsonb)',
      [fixtureId, ownerId, 'Trusted SQL fixture', `task3-trusted-${randomUUID()}`, JSON.stringify({ type: 'doc', content: [] })],
    );
    await requester.query('rollback');
    await requester.query('begin');
    await requester.query("select set_config('blog.editorial_session_id','invalid',true)");
    let partialDenied = false;
    try {
      await requester.query(
        'insert into public.blog_posts(id,owner_id,title,slug,document) values($1,$2,$3,$4,$5::jsonb)',
        [fixtureId, ownerId, 'Partial GUC fixture', `task3-partial-${randomUUID()}`, JSON.stringify({ type: 'doc', content: [] })],
      );
    } catch (error) { partialDenied = error.code === '42501'; }
    await requester.query('rollback').catch(() => {});
    if (!partialDenied) stop('partial-session-context-was-not-denied');
    process.stdout.write('PASS empty transaction-local GUCs behave as absent for trusted SQL fixtures; partial session context denies\n');

    await setJwtSession(requester, ownerId, freshSessionId);
    const freshSave = await requester.query(
      'select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result',
      [JSON.stringify({ ...draft, slug: `task3-fresh-${randomUUID()}` }), freshSessionId],
    );
    savedPostId = freshSave.rows[0].result.id;
    if (!savedPostId) stop('fresh-session-generation-not-recaptured');
    process.stdout.write('PASS a later authenticated RPC uses its explicit fresh session ID/generation after connection reuse\n');

    await setJwtSession(observer, ownerId, snapshotSessionId);
    const snapshotSummary = await observer.query('select public.blog_publication_summary($1::uuid,1) as summary', [snapshotSessionId]);
    const snapshotRequestId = randomUUID();
    await requester.query('begin');
    freezeTransactionOpen = true;
    await setJwtSession(requester, ownerId, snapshotSessionId);
    const frozen = await requester.query(
      'select public.blog_freeze_release($1::uuid,1,$2::uuid,$3) as result',
      [snapshotRequestId, snapshotSessionId, snapshotSummary.rows[0].summary.digest],
    );
    const frozenResult = frozen.rows[0].result;
    snapshotReleaseId = frozenResult.releaseId;
    if (typeof frozenResult.payload !== 'string' || createHash('sha256').update(frozenResult.payload, 'utf8').digest('hex') !== frozenResult.digest) stop('snapshot-exact-text-digest');
    const frozenPayload = JSON.parse(frozenResult.payload);
    const frozenPost = frozenPayload.posts.find((entry) => entry.id === preparedPostId);
    if (!frozenPost || frozenPost.title !== 'Concurrency fixture') stop('snapshot-initial-content');
    const immutableRow = await requester.query('select payload_text,digest from blog_private.releases where release_id=$1', [snapshotReleaseId]);
    if (immutableRow.rowCount !== 1 || immutableRow.rows[0].payload_text !== frozenResult.payload || immutableRow.rows[0].digest !== frozenResult.digest) stop('snapshot-stored-text-digest');

    const freezePid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    const writerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    await setJwtSession(blocker, ownerId, writerSessionId);
    const writerPromise = blocker.query(
      'select public.blog_save_post($1::jsonb,1,$2::uuid,1) as result',
      [JSON.stringify({ ...draft, id: preparedPostId, title: 'Edited after immutable snapshot', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New draft after freeze' }] }] } }), writerSessionId],
    );
    await waitForBlocking(observer, freezePid, writerPid, 'save-after-freeze-pg-blocking-pids');
    await requester.query('commit');
    freezeTransactionOpen = false;
    const writerResult = await writerPromise;
    if (writerResult.rows[0]?.result?.revision !== 2) stop('save-after-freeze-revision');
    const livePost = await observer.query('select title,revision,prepared_action from public.blog_posts where id=$1', [preparedPostId]);
    const storedRelease = await observer.query('select payload_text,digest from blog_private.releases where release_id=$1', [snapshotReleaseId]);
    const storedPayload = JSON.parse(storedRelease.rows[0].payload_text);
    const storedPost = storedPayload.posts.find((entry) => entry.id === preparedPostId);
    if (livePost.rows[0]?.title !== 'Edited after immutable snapshot' || livePost.rows[0]?.revision !== '2'
      || livePost.rows[0]?.prepared_action !== null || storedPost?.title !== 'Concurrency fixture'
      || storedRelease.rows[0].digest !== createHash('sha256').update(storedRelease.rows[0].payload_text, 'utf8').digest('hex')) {
      stop('freeze-save-snapshot-isolation');
    }
    process.stdout.write(`PASS freeze held prepared rows against a concurrent save; immutable snapshot stayed fixed (post=${preparedPostId}, release=${snapshotReleaseId})\n`);

    await setJwtSession(observer, ownerId, membershipSessionId);
    const membershipA = await observer.query('select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result', [
      JSON.stringify({ title: 'Freeze membership A', slug: `task3-membership-a-${randomUUID()}`, excerpt: 'Prepared before summary', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }, coverMediaId: null, serviceId: null }),
      membershipSessionId,
    ]);
    const membershipAId = membershipA.rows[0].result.id;
    membershipPostIds.push(membershipAId);
    const membershipB = await observer.query('select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result', [
      JSON.stringify({ title: 'Freeze membership B', slug: `task3-membership-b-${randomUUID()}`, excerpt: 'Prepared after summary', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] }, coverMediaId: null, serviceId: null }),
      membershipSessionId,
    ]);
    const membershipBId = membershipB.rows[0].result.id;
    membershipPostIds.push(membershipBId);
    await observer.query('select public.blog_mark_prepared($1::uuid,1,$2,$3::uuid,1)', [membershipAId, 'upsert', membershipSessionId]);
    const membershipSummary = await observer.query('select public.blog_publication_summary($1::uuid,1) as summary', [membershipSessionId]);
    const membershipDigest = membershipSummary.rows[0].summary.digest;
    const membershipRequestId = randomUUID();
    await blocker.query('begin');
    await blocker.query('lock table blog_private.releases in share mode');
    membershipTableLocked = true;
    const membershipBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const membershipFreezePid = Number((await requester.query('select pg_backend_pid() as pid')).rows[0].pid);
    await requester.query('begin');
    await requester.query('savepoint membership_freeze');
    membershipOuterOpen = true;
    await setJwtSession(requester, ownerId, membershipSessionId);
    membershipFreezePromise = requester.query(
      'select public.blog_freeze_release($1::uuid,1,$2::uuid,$3) as result',
      [membershipRequestId, membershipSessionId, membershipDigest],
    );
    membershipFreezePromise.catch(() => {});
    await waitForBlocking(monitor, membershipBlockerPid, membershipFreezePid, 'membership-freeze-release-insert-pg-blocking-pids');
    const pendingReleaseInsert = await monitor.query(
      `select exists(select 1 from pg_locks where pid=$1 and relation='blog_private.releases'::regclass
       and mode='RowExclusiveLock' and not granted) as waiting`, [membershipFreezePid],
    );
    if (pendingReleaseInsert.rows[0]?.waiting !== true) stop('membership-freeze-not-blocked-at-release-insert');
    let slotNowaitBlocked = false;
    try {
      await monitor.query('select singleton from blog_private.build_slot where singleton for update nowait');
    } catch (error) {
      if (error.code !== '55P03') throw error;
      slotNowaitBlocked = true;
    }
    if (!slotNowaitBlocked) stop('membership-freeze-does-not-hold-build-slot-at-release-insert');
    const membershipWriterPid = Number((await observer.query('select pg_backend_pid() as pid')).rows[0].pid);
    membershipPreparePromise = observer.query(
      'select public.blog_mark_prepared($1::uuid,1,$2,$3::uuid,1)',
      [membershipBId, 'upsert', membershipSessionId],
    );
    membershipPreparePromise.catch(() => {});
    const membershipPrepareMode = await Promise.race([
      waitForBlocking(monitor, membershipFreezePid, membershipWriterPid, 'membership-mark-prepared-slot-pg-blocking-pids').then(() => 'blocked'),
      membershipPreparePromise.then(() => 'completed'),
    ]);
    await blocker.query('commit');
    membershipTableLocked = false;
    const membershipFrozen = await membershipFreezePromise;
    const membershipFrozenResult = membershipFrozen.rows[0].result;
    const membershipPayload = JSON.parse(membershipFrozenResult.payload);
    if (!membershipPayload.posts.some((post) => post.id === membershipAId)
      || membershipPayload.posts.some((post) => post.id === membershipBId)) stop('membership-payload-not-exact-summary-set');
    const bInsideFreeze = await requester.query(
      'select prepared_action,first_confirmed_at from public.blog_posts where id=$1', [membershipBId],
    );
    const bConsumedBeforeRollback = bInsideFreeze.rows[0]?.prepared_action === null
      && bInsideFreeze.rows[0]?.first_confirmed_at !== null;
    await requester.query('rollback to savepoint membership_freeze');
    await requester.query('rollback');
    membershipOuterOpen = false;
    await membershipPreparePromise;
    membershipPreparePromise = null;
    const membershipBFinal = await monitor.query(
      'select prepared_action,first_confirmed_at from public.blog_posts where id=$1', [membershipBId],
    );
    await setJwtSession(monitor, ownerId, membershipSessionId);
    const membershipNextSummary = await monitor.query(
      'select public.blog_publication_summary($1::uuid,1) as summary', [membershipSessionId],
    );
    const bInNextSummary = membershipNextSummary.rows[0].summary.changes.some((change) => change.postId === membershipBId);
    process.stdout.write(`OBS late-ready mode=${membershipPrepareMode} consumed=${bConsumedBeforeRollback} action=${membershipBFinal.rows[0]?.prepared_action ?? 'null'} confirmed=${membershipBFinal.rows[0]?.first_confirmed_at !== null} nextSummary=${bInNextSummary}\n`);
    if (membershipPrepareMode !== 'blocked' || bConsumedBeforeRollback
      || membershipBFinal.rows[0]?.prepared_action !== 'upsert'
      || membershipBFinal.rows[0]?.first_confirmed_at !== null || !bInNextSummary) {
      stop('late-ready-article-was-consumed-by-unrelated-freeze');
    }
    process.stdout.write('PASS a late readiness mutation physically waited on the freeze build-slot lock and remained in the next summary; pg_blocking_pids confirmed both waits\n');
  } finally {
    if (locked || membershipTableLocked) await blocker.query('rollback').catch(() => {});
    if (freezeTransactionOpen || membershipOuterOpen) await requester.query('rollback').catch(() => {});
    if (requestPromise) await requestPromise.catch(() => {});
    if (membershipFreezePromise) await membershipFreezePromise.catch(() => {});
    if (membershipPreparePromise) await membershipPreparePromise.catch(() => {});
    if (savedPostId) await observer.query('delete from public.blog_posts where id=$1', [savedPostId]).catch(() => {});
    if (preparedPostId) await observer.query('delete from public.blog_posts where id=$1 and first_confirmed_at is null', [preparedPostId]).catch(() => {});
    if (membershipPostIds.length) await observer.query('delete from public.blog_posts where id=any($1::uuid[]) and first_confirmed_at is null', [membershipPostIds]).catch(() => {});
    await observer.query('delete from blog_private.admin_sessions where session_id=any($1::uuid[])', [[sessionId, postSessionId, freezeSlotSessionId, freezePostSessionId, freshSessionId, snapshotSessionId, writerSessionId, membershipSessionId]]).catch(() => {});
    if (ownerSetting) await observer.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id=$2', [previousOwnerId, ownerId]).catch(() => {});
    await Promise.all([blocker.end().catch(() => {}), requester.end().catch(() => {}), observer.end().catch(() => {}), monitor.end().catch(() => {})]);
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch((error) => {
    process.stderr.write(`Task 3 concurrency gate stopped at ${error?.stage ?? 'concurrency-test'}; only fixed classifications were emitted.\n`);
    process.exitCode = 1;
  });
}
