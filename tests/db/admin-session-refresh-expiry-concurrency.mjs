import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
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
  const project = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  if (!/^project_id\s*=\s*"jt-studio-blog-tests"/m.test(project) || !/^port\s*=\s*54342\s*$/m.test(project)) stop('task-project-config');
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
    const makeClient = () => new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 18000, statement_timeout: 18000, application_name: 'jt-studio-task4-refresh-expiry-proof' });
    return { status, makeClient };
  } finally {
    await proxy.close();
  }
}

async function waitForBlockingRpc(observer, blockerPid, functionName) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `select pid from pg_stat_activity
       where datname=current_database() and state='active' and query ilike $1
         and $2::integer = any(pg_blocking_pids(pid))`,
      [`%${functionName}%`, blockerPid],
    );
    if (result.rowCount === 1) return Number(result.rows[0].pid);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  stop(`${functionName}-pg-blocking-pids`);
}

async function waitForDatabaseExpiry(observer, expiresAt, stage) {
  const before = await observer.query('select clock_timestamp() < $1::timestamptz as active', [expiresAt]);
  if (before.rows[0]?.active !== true) stop(`${stage}-expired-before-lock-wait`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const after = await observer.query('select clock_timestamp() >= $1::timestamptz as expired', [expiresAt]);
    if (after.rows[0]?.expired === true) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  stop(`${stage}-database-expiry-not-reached`);
}

async function run() {
  currentStage = 'open-local-db';
  const { status, makeClient } = await openLocalDatabase();
  const blocker = makeClient();
  const observer = makeClient();
  const ownerId = randomUUID();
  const claimSessionId = randomUUID();
  const completeSessionId = randomUUID();
  const authSessionId = randomUUID();
  const cookieDigest = randomBytes(32).toString('hex');
  const completeCookieDigest = randomBytes(32).toString('hex');
  const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let ownerInstalled = false;
  let blockerTransaction = false;
  let pendingRpc;
  let sessionsInserted = false;
  try {
    currentStage = 'connect-db';
    await Promise.all([blocker.connect(), observer.connect()]);
    currentStage = 'fixture-baseline';
    const baseline = await observer.query('select (select authorized_owner_id is null from blog_private.settings where singleton) owner_null,(select count(*)::int from blog_private.admin_sessions where revoked_at is null) sessions');
    if (!baseline.rows[0]?.owner_null || baseline.rows[0].sessions !== 0) stop('task4-refresh-fixture-baseline');
    currentStage = 'install-owner';
    const installed = await observer.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id is null', [ownerId]);
    if (installed.rowCount !== 1) stop('task4-owner-install');
    ownerInstalled = true;
    currentStage = 'insert-session-fixtures';
    await observer.query(
      `insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,cookie_digest,expires_at,auth_expires_at,token_ciphertext)
       values ($1,$2,$3,1,decode($4,'hex'),clock_timestamp()+interval '6 seconds',clock_timestamp()+interval '1 hour','v1.a.a.a'),
              ($5,$2,$3,1,decode($6,'hex'),clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '1 hour','v1.a.a.a')`,
      [claimSessionId, ownerId, authSessionId, cookieDigest, completeSessionId, completeCookieDigest],
    );
    sessionsInserted = true;

    currentStage = 'claim-lock-blocker';
    await blocker.query('begin');
    blockerTransaction = true;
    await blocker.query('select session_id from blog_private.admin_sessions where session_id=$1 for update', [claimSessionId]);
    const blockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const claimId = randomUUID();
    pendingRpc = Promise.resolve(service.rpc('blog_admin_session_refresh_claim', { p_session_id: claimSessionId, p_generation: 1, p_claim_id: claimId }));
    pendingRpc.catch(() => {});
    currentStage = 'claim-wait-observation';
    await waitForBlockingRpc(observer, blockerPid, 'blog_admin_session_refresh_claim');
    const claimExpiry = await observer.query('select expires_at from blog_private.admin_sessions where session_id=$1', [claimSessionId]);
    currentStage = 'claim-db-expiry';
    await waitForDatabaseExpiry(observer, claimExpiry.rows[0].expires_at, 'refresh-claim-expiry');
    await blocker.query('commit');
    blockerTransaction = false;
    currentStage = 'claim-result';
    const claimResult = await pendingRpc;
    pendingRpc = null;
    if (claimResult.error || claimResult.data !== null) stop('expired-refresh-claim-after-lock-was-accepted');
    const claimState = await observer.query('select generation,refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [claimSessionId]);
    if (claimState.rows[0]?.refresh_claim_id !== null || claimState.rows[0]?.revoked_at !== null || String(claimState.rows[0]?.generation) !== '1') stop('expired-refresh-claim-state-mutated');
    process.stdout.write('PASS refresh claim revalidated app expiry after a physical row-lock wait; pg_blocking_pids observed the wait and no claim was created\n');

    currentStage = 'complete-claim-fixture';
    const claimed = await service.rpc('blog_admin_session_refresh_claim', { p_session_id: completeSessionId, p_generation: 1, p_claim_id: randomUUID() });
    if (claimed.error || claimed.data?.generation !== 1 || typeof claimed.data?.claim_id !== 'string') stop('complete-refresh-claim-fixture');
    const claimExpiryUpdate = await observer.query("update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '6 seconds' where session_id=$1 returning expires_at", [completeSessionId]);
    const completeExpiry = claimExpiryUpdate.rows[0].expires_at;
    currentStage = 'complete-lock-blocker';
    await blocker.query('begin');
    blockerTransaction = true;
    await blocker.query('select session_id from blog_private.admin_sessions where session_id=$1 for update', [completeSessionId]);
    const completeBlockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    pendingRpc = Promise.resolve(service.rpc('blog_admin_session_refresh_complete', {
      p_session_id: completeSessionId,
      p_generation: 1,
      p_claim_id: claimed.data.claim_id,
      p_auth_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      p_token_ciphertext: 'v1.a.a.a',
    }));
    pendingRpc.catch(() => {});
    currentStage = 'complete-wait-observation';
    await waitForBlockingRpc(observer, completeBlockerPid, 'blog_admin_session_refresh_complete');
    currentStage = 'complete-db-expiry';
    await waitForDatabaseExpiry(observer, completeExpiry, 'refresh-completion-expiry');
    await blocker.query('commit');
    blockerTransaction = false;
    currentStage = 'complete-result';
    const completeResult = await pendingRpc;
    pendingRpc = null;
    if (completeResult.error || completeResult.data !== null) stop('expired-refresh-completion-after-lock-was-accepted');
    const completeState = await observer.query('select generation,refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [completeSessionId]);
    if (String(completeState.rows[0]?.generation) !== '1' || completeState.rows[0]?.refresh_claim_id !== claimed.data.claim_id || completeState.rows[0]?.revoked_at !== null) stop('expired-refresh-completion-state-mutated');
    process.stdout.write('PASS refresh completion revalidated app expiry after a physical row-lock wait; pg_blocking_pids observed the wait and generation stayed fixed\n');
  } catch (error) {
    failureStage = currentStage;
    throw error;
  } finally {
    currentStage = 'cleanup';
    if (blockerTransaction) await blocker.query('rollback').catch(() => {});
    if (pendingRpc) await pendingRpc.catch(() => {});
    if (sessionsInserted) {
      const deletion = await observer.query('delete from blog_private.admin_sessions where user_id=$1 and session_id=any($2::uuid[])', [ownerId, [claimSessionId, completeSessionId]]).then(
        result => ({ rowCount: result.rowCount }),
        error => ({ code: typeof error?.code === 'string' && /^[0-9A-Z]{2,5}$/.test(error.code) ? error.code : 'none' }),
      );
      if (deletion.rowCount !== 2) process.stderr.write(`Task 4 refresh fixture cleanup did not delete exactly two owned sessions (code ${deletion.code ?? 'count-mismatch'}).\n`);
    }
    if (ownerInstalled) {
      const restoration = await observer.query('update blog_private.settings set authorized_owner_id=null where singleton and authorized_owner_id=$1', [ownerId]).then(
        result => ({ rowCount: result.rowCount }),
        error => ({ code: typeof error?.code === 'string' && /^[0-9A-Z]{2,5}$/.test(error.code) ? error.code : 'none' }),
      );
      if (restoration.rowCount !== 1) process.stderr.write(`Task 4 refresh fixture owner restore was not exact (code ${restoration.code ?? 'count-mismatch'}).\n`);
    }
    const final = await observer.query('select (select authorized_owner_id is null from blog_private.settings where singleton) owner_null,(select count(*)::int from blog_private.admin_sessions where revoked_at is null) sessions').then(
      result => result.rows[0],
      () => null,
    );
    if (!final?.owner_null || final.sessions !== 0) {
      process.stderr.write('Task 4 refresh fixture cleanup baseline was not verified.\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('PASS exact refresh proof fixture cleanup; owner NULL and sessions 0\n');
    }
    await blocker.end().catch(() => {});
    await observer.end().catch(() => {});
    await service.auth.dispose().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => {
    const stage = typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage) ? error.stage : (failureStage ?? currentStage);
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{2,5}$/.test(error.code) ? error.code : 'none';
    const kind = typeof error?.name === 'string' && /^[A-Za-z]{1,32}$/.test(error.name) ? error.name : 'Error';
    process.stderr.write(`Task 4 refresh expiry proof stopped at ${stage} (${kind}, code ${code}); credentials, response bodies, and SQL values were not retained.\n`);
    process.exitCode = 1;
  });
}
