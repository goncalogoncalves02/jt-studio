import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectId = 'jt-studio-blog-tests';
let currentStage = 'startup';
let failureStage;

function stop(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

async function openLocalDatabase() {
  const config = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  if (!/^project_id\s*=\s*"jt-studio-blog-tests"/m.test(config) || !/^port\s*=\s*54342\s*$/m.test(config)) stop('task-project-config');
  const docker = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const endpoint = docker.status === 0 ? docker.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) stop('docker-local-socket');
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: endpoint.slice('unix://'.length),
    allowedNames: new Set(['supabase_db_jt-studio-blog-tests', 'supabase_auth_jt-studio-blog-tests', 'supabase_rest_jt-studio-blog-tests', 'supabase_kong_jt-studio-blog-tests']),
  });
  const socket = await proxy.listen();
  try {
    const env = createSupabaseCliEnvironment(process.env, socket);
    const cli = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cli, '--version'], { cwd: root, env });
    if (version.status !== 0 || version.stdout.trim() !== '2.120.0') stop('pinned-supabase-cli');
    const result = await runCliCapture(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, env });
    if (result.status !== 0) stop('supabase-local-status');
    const status = JSON.parse(result.stdout);
    validateLocalDatabaseTarget(status, projectId, 54342);
    const { Client } = await import('pg');
    const makeClient = (applicationName) => new Client({
      connectionString: status.DB_URL,
      connectionTimeoutMillis: 5000,
      query_timeout: 20000,
      statement_timeout: 20000,
      application_name: applicationName,
    });
    return { makeClient, close: () => proxy.close() };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

async function callService(client, sql, params) {
  await client.query('set role service_role');
  try { return await client.query(sql, params); }
  finally { await client.query('reset role'); }
}

async function waitForBlocking(observer, blockerPid, waiterPid, stage) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await observer.query('select $1::integer = any(pg_blocking_pids($2::integer)) as blocked', [blockerPid, waiterPid]);
    if (result.rows[0]?.blocked === true) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  stop(`${stage}-pg-blocking-pids`);
}

async function waitForDatabaseExpiry(observer, expiresAt, stage) {
  const initial = await observer.query('select clock_timestamp() < $1::timestamptz as active', [expiresAt]);
  if (initial.rows[0]?.active !== true) stop(`${stage}-expired-before-wait`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = await observer.query('select clock_timestamp() >= $1::timestamptz as expired', [expiresAt]);
    if (current.rows[0]?.expired === true) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  stop(`${stage}-database-expiry-not-reached`);
}

function variant(mediaId, width, height, digestChar) {
  const sha256 = digestChar.repeat(64);
  return {
    width, height, mime: 'image/webp', byteLength: 1024, sha256,
    objectKey: `public/${mediaId}/${width}-${sha256}.webp`,
  };
}

async function createUploadingGroup(client, userId, sessionId, mediaId, includeSmallest) {
  const variants = [variant(mediaId, 1200, 800, 'a'), variant(mediaId, 960, 640, 'b')];
  if (includeSmallest) variants.push(variant(mediaId, 480, 320, 'c'));
  for (const item of variants) {
    const result = await callService(client,
      'select public.blog_media_record_variant($1::uuid,$2::uuid,1,$3::text,$4::jsonb) as recorded',
      [userId, sessionId, mediaId, JSON.stringify(item)]);
    if (result.rows[0]?.recorded !== true) stop('fixture-variant-record');
  }
  return await client.query('select state,variants from public.blog_media where id=$1', [mediaId]).then(result => result.rows[0]);
}

async function assertDeniedWithoutMediaChange({ observer, waiter, blocker, blockerOpen, pending, mediaId, before, intentBefore, sessionId, expiryBefore, stage }) {
  let denial;
  try { await pending; } catch (error) { denial = error; }
  await waiter.query('reset role').catch(() => {});
  if (denial?.code !== '42501') stop(`${stage}-expired-session-not-denied`);
  const after = await observer.query('select state,variants from public.blog_media where id=$1', [mediaId]);
  const intentAfter = await observer.query('select owner_id,master_width,master_height,expected_widths from blog_private.media_upload_intents where media_id=$1', [mediaId]);
  const sessionAfter = await observer.query('select expires_at from blog_private.admin_sessions where session_id=$1', [sessionId]);
  if (after.rowCount !== 1 || after.rows[0].state !== before.state || JSON.stringify(after.rows[0].variants) !== JSON.stringify(before.variants)) {
    stop(`${stage}-media-state-mutated`);
  }
  if (intentAfter.rowCount !== 1 || JSON.stringify(intentAfter.rows[0]) !== JSON.stringify(intentBefore)) stop(`${stage}-intent-state-mutated`);
  if (new Date(sessionAfter.rows[0]?.expires_at).getTime() !== new Date(expiryBefore).getTime()) stop(`${stage}-session-row-changed`);
  if (blockerOpen) await blocker.query('rollback').catch(() => {});
}

async function run() {
  const { makeClient, close } = await openLocalDatabase();
  const setup = makeClient('jt-studio-task5-media-lock-fixture');
  const blocker = makeClient('jt-studio-task5-media-lock-blocker');
  const waiter = makeClient('jt-studio-task5-media-lock-waiter');
  const observer = makeClient('jt-studio-task5-media-lock-observer');
  const userId = randomUUID();
  const providerSessionId = randomUUID();
  const appSessionId = randomUUID();
  const completeMediaId = randomUUID();
  const recordMediaId = randomUUID();
  const email = `task5-lock-${randomUUID()}@example.invalid`;
  const sessionIds = [appSessionId];
  let ownerInstalled = false;
  let blockerOpen = false;
  let pending;
  try {
    currentStage = 'connect';
    await Promise.all([setup.connect(), blocker.connect(), waiter.connect(), observer.connect()]);
    const baseline = await observer.query(`select
      (select authorized_owner_id is null from blog_private.settings where singleton) as owner_null,
      (select count(*)::int from blog_private.admin_sessions app
       where app.revoked_at is null and app.expires_at > clock_timestamp() and app.auth_expires_at > clock_timestamp()
         and exists (select 1 from auth.sessions provider where provider.id=app.auth_session_id
                    and provider.user_id=app.user_id and (provider.not_after is null or provider.not_after > clock_timestamp()))) as active_sessions`);
    if (!baseline.rows[0]?.owner_null || baseline.rows[0].active_sessions !== 0) stop('fixture-baseline');
    currentStage = 'install-synthetic-owner';
    const owner = await setup.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id is null', [userId]);
    if (owner.rowCount !== 1) stop('owner-install');
    ownerInstalled = true;
    await setup.query(
      `insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
       values($1,'authenticated','authenticated',$2,'',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp())`,
      [userId, email],
    );
    await setup.query('insert into auth.sessions(id,user_id,created_at,updated_at,not_after) values($1,$2,clock_timestamp(),clock_timestamp(),null)', [providerSessionId, userId]);
    await setup.query(
      `insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,cookie_digest,expires_at,auth_expires_at,token_ciphertext)
       values($1,$2,$3,1,decode($4,'hex'),clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '20 minutes','v1.a.a.a')`,
      [appSessionId, userId, providerSessionId, randomBytes(32).toString('hex')],
    );
    currentStage = 'create-uploading-groups';
    const completeBefore = await createUploadingGroup(setup, userId, appSessionId, completeMediaId, true);
    const recordBefore = await createUploadingGroup(setup, userId, appSessionId, recordMediaId, false);
    if (completeBefore?.state !== 'uploading' || recordBefore?.state !== 'uploading') stop('fixture-groups-uploading');
    currentStage = 'complete-wait-setup';
    const completeIntent = await observer.query('select owner_id,master_width,master_height,expected_widths from blog_private.media_upload_intents where media_id=$1', [completeMediaId]);
    const valid = await observer.query('select blog_private.media_admin_session_live($1,$2,1) as live', [userId, appSessionId]);
    if (completeIntent.rowCount !== 1 || valid.rows[0]?.live !== true) stop('complete-session-valid-before-wait');
    const completeExpiryUpdate = await setup.query("update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '4 seconds' where session_id=$1 returning expires_at", [appSessionId]);
    const completeExpiry = completeExpiryUpdate.rows[0]?.expires_at;
    if ((await observer.query('select blog_private.media_admin_session_live($1,$2,1) as live', [userId, appSessionId])).rows[0]?.live !== true) stop('complete-session-valid-at-start');
    await blocker.query('begin');
    blockerOpen = true;
    await blocker.query('select id from public.blog_media where id=$1 for update', [completeMediaId]);
    const completeBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const completeWaiterPid = Number((await waiter.query('select pg_backend_pid() as pid')).rows[0].pid);
    await waiter.query('set role service_role');
    pending = waiter.query('select public.blog_media_complete($1::uuid,$2::uuid,1,$3::text)', [userId, appSessionId, completeMediaId]);
    pending.catch(() => {});
    currentStage = 'complete-blocking-evidence';
    await waitForBlocking(observer, completeBlockerPid, completeWaiterPid, 'complete-media-row');
    await waitForDatabaseExpiry(observer, completeExpiry, 'complete-session');
    const completeSessionLine = await observer.query('select expires_at from blog_private.admin_sessions where session_id=$1', [appSessionId]);
    if (new Date(completeSessionLine.rows[0]?.expires_at).getTime() !== new Date(completeExpiry).getTime()) stop('complete-session-line-mutated');
    await blocker.query('commit');
    blockerOpen = false;
    currentStage = 'complete-denial';
    await assertDeniedWithoutMediaChange({ observer, waiter, blocker, blockerOpen, pending, mediaId: completeMediaId, before: completeBefore, intentBefore: completeIntent.rows[0], sessionId: appSessionId, expiryBefore: completeExpiry, stage: 'complete' });
    pending = null;
    process.stdout.write('PASS completion waited on the media row, pg_blocking_pids proved the blocker, unchanged app expiry elapsed, and the transition was denied without state change.\n');

    currentStage = 'record-wait-setup';
    await setup.query("update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '20 minutes' where session_id=$1", [appSessionId]);
    if ((await observer.query('select blog_private.media_admin_session_live($1,$2,1) as live', [userId, appSessionId])).rows[0]?.live !== true) stop('record-session-restored-for-fixture');
    const recordIntent = await observer.query('select owner_id,master_width,master_height,expected_widths from blog_private.media_upload_intents where media_id=$1', [recordMediaId]);
    const recordExpiryUpdate = await setup.query("update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '4 seconds' where session_id=$1 returning expires_at", [appSessionId]);
    const recordExpiry = recordExpiryUpdate.rows[0]?.expires_at;
    if ((await observer.query('select blog_private.media_admin_session_live($1,$2,1) as live', [userId, appSessionId])).rows[0]?.live !== true) stop('record-session-valid-at-start');
    await blocker.query('begin');
    blockerOpen = true;
    await blocker.query('select media_id from blog_private.media_upload_intents where media_id=$1 for update', [recordMediaId]);
    const recordBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const recordWaiterPid = Number((await waiter.query('select pg_backend_pid() as pid')).rows[0].pid);
    await waiter.query('set role service_role');
    pending = waiter.query('select public.blog_media_record_variant($1::uuid,$2::uuid,1,$3::text,$4::jsonb)', [userId, appSessionId, recordMediaId, JSON.stringify(variant(recordMediaId, 480, 320, 'c'))]);
    pending.catch(() => {});
    currentStage = 'record-blocking-evidence';
    await waitForBlocking(observer, recordBlockerPid, recordWaiterPid, 'record-intent-row');
    await waitForDatabaseExpiry(observer, recordExpiry, 'record-session');
    const recordSessionLine = await observer.query('select expires_at from blog_private.admin_sessions where session_id=$1', [appSessionId]);
    if (new Date(recordSessionLine.rows[0]?.expires_at).getTime() !== new Date(recordExpiry).getTime()) stop('record-session-line-mutated');
    await blocker.query('commit');
    blockerOpen = false;
    currentStage = 'record-denial';
    await assertDeniedWithoutMediaChange({ observer, waiter, blocker, blockerOpen, pending, mediaId: recordMediaId, before: recordBefore, intentBefore: recordIntent.rows[0], sessionId: appSessionId, expiryBefore: recordExpiry, stage: 'record' });
    pending = null;
    process.stdout.write('PASS variant recording waited on the private intent row, pg_blocking_pids proved the blocker, unchanged app expiry elapsed, and the write was denied without state change.\n');
  } catch (error) {
    failureStage = currentStage;
    throw error;
  } finally {
    if (blockerOpen) await blocker.query('rollback').catch(() => {});
    if (pending) await pending.catch(() => {});
    await waiter.query('reset role').catch(() => {});
    await setup.query('update auth.sessions set not_after=clock_timestamp()-interval \'1 second\' where id=$1 and user_id=$2', [providerSessionId, userId]).catch(() => {});
    await setup.query("update blog_private.admin_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()), expires_at=least(expires_at,clock_timestamp()-interval '1 second') where user_id=$1 and session_id=any($2::uuid[])", [userId, sessionIds]).catch(() => {});
    if (ownerInstalled) await setup.query('update blog_private.settings set authorized_owner_id=null where singleton and authorized_owner_id=$1', [userId]).catch(() => {});
    const final = await observer.query(
      `select (select authorized_owner_id is null from blog_private.settings where singleton) owner_null,
              (select count(*)::int from blog_private.admin_sessions where session_id=any($1::uuid[])) retained_sessions,
              (select count(*)::int from blog_private.admin_sessions app where app.session_id=any($1::uuid[])
                and app.revoked_at is null and app.expires_at>clock_timestamp() and app.auth_expires_at>clock_timestamp()
                and exists (select 1 from auth.sessions provider where provider.id=app.auth_session_id and provider.user_id=app.user_id
                  and (provider.not_after is null or provider.not_after>clock_timestamp()))) active_task_sessions,
              (select count(*)::int from auth.sessions provider where provider.id=$3::uuid and provider.user_id=$4::uuid
                and (provider.not_after is null or provider.not_after>clock_timestamp())) active_provider_sessions,
              (select count(*)::int from public.blog_media where id=any($2::text[])) retained_media`,
      [sessionIds, [completeMediaId, recordMediaId], providerSessionId, userId],
    ).catch(() => null);
    if (!final?.rows[0]?.owner_null || final.rows[0].retained_sessions !== 1 || final.rows[0].active_task_sessions !== 0
        || final.rows[0].active_provider_sessions !== 0 || final.rows[0].retained_media !== 2) {
      process.stderr.write('Task 5 lock-expiry fixture restore failed; retained synthetic media rows are preserved for diagnosis.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`PASS exact session fixture restored; owner NULL, fixture session retained but inactive, provider authority inactive, and retained diagnostic media=${completeMediaId},${recordMediaId}.\n`);
    }
    await Promise.all([setup.end().catch(() => {}), blocker.end().catch(() => {}), waiter.end().catch(() => {}), observer.end().catch(() => {})]);
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => {
    const stage = typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage) ? error.stage : (failureStage ?? currentStage);
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{2,5}$/.test(error.code) ? error.code : 'none';
    process.stderr.write(`Task 5 media lock expiry proof stopped at ${stage} (code ${code}); credentials and SQL values were not retained.\n`);
    process.exitCode = 1;
  });
}
