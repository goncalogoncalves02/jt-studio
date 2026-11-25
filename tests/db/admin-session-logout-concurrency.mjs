import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectId = 'jt-studio-blog-tests';

function stop(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

async function openDatabase() {
  const source = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  if (!/^project_id\s*=\s*"jt-studio-blog-tests"/m.test(source) || !/^port\s*=\s*54342\s*$/m.test(source)) stop('project-config');
  const docker = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const endpoint = docker.status === 0 ? docker.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) stop('docker-local-socket');
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: endpoint.slice('unix://'.length),
    allowedNames: new Set([`supabase_db_${projectId}`, `supabase_auth_${projectId}`, `supabase_rest_${projectId}`, `supabase_kong_${projectId}`]),
  });
  const socket = await proxy.listen();
  const env = createSupabaseCliEnvironment(process.env, socket);
  const cli = join(root, 'node_modules/supabase/dist/supabase.js');
  const version = await runCliCapture(process.execPath, [cli, '--version'], { cwd: root, env });
  if (version.status !== 0 || version.stdout.trim() !== '2.120.0') { await proxy.close(); stop('cli-version'); }
  const result = await runCliCapture(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, env });
  if (result.status !== 0) { await proxy.close(); stop('local-status'); }
  let status;
  try { status = JSON.parse(result.stdout); } catch { await proxy.close(); stop('local-status-json'); }
  if (status.API_URL !== 'http://127.0.0.1:54341') { await proxy.close(); stop('api-loopback-target'); }
  validateLocalDatabaseTarget(status, projectId, 54342);
  const { Client } = await import('pg');
  const makeClient = () => new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 12000, statement_timeout: 12000, application_name: 'jt-studio-task4-logout-concurrency' });
  return { makeClient, close: () => proxy.close() };
}

async function waitForBlocking(observer, blockerPid, waiterPid) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await observer.query('select $1::integer = any(pg_blocking_pids($2::integer)) as blocked', [blockerPid, waiterPid]);
    if (result.rows[0]?.blocked === true) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  stop('logout-mutation-pg-blocking-pids');
}

async function run() {
  const { makeClient, close } = await openDatabase();
  const blocker = makeClient();
  const mutation = makeClient();
  const observer = makeClient();
  const ownerId = randomUUID();
  const sessionId = randomUUID();
  const slug = `task4-logout-lock-${randomUUID()}`;
  let ownerInstalled = false;
  let lockOpen = false;
  let mutationPending;
  try {
    await Promise.all([blocker.connect(), mutation.connect(), observer.connect()]);
    const baseline = await observer.query('select (select authorized_owner_id is null from blog_private.settings where singleton) as owner_null,(select count(*)::int from blog_private.admin_sessions where revoked_at is null) as sessions');
    if (!baseline.rows[0]?.owner_null || baseline.rows[0]?.sessions !== 0) stop('task4-session-fixture-baseline');
    const installed = await observer.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id is null', [ownerId]);
    if (installed.rowCount !== 1) stop('task4-owner-install');
    ownerInstalled = true;
    await observer.query('insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,expires_at) values($1,$2,$1,1,clock_timestamp()+interval \'30 minutes\')', [sessionId, ownerId]);
    await mutation.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [ownerId, JSON.stringify({ sub: ownerId, session_id: sessionId })]);

    await blocker.query('begin');
    lockOpen = true;
    const logout = await blocker.query('select public.blog_admin_session_revoke($1,$2) as revoked', [sessionId, ownerId]);
    if (logout.rows[0]?.revoked !== true) stop('task4-logout-rpc-revoked');
    const blockerPid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid);
    const mutationPid = Number((await mutation.query('select pg_backend_pid() as pid')).rows[0].pid);
    mutationPending = mutation.query(
      'select public.blog_save_post($1::jsonb,0,$2::uuid,1) as result',
      [JSON.stringify({ title: 'Logout race fixture', slug, excerpt: '', document: { type: 'doc', content: [] } }), sessionId],
    );
    await waitForBlocking(observer, blockerPid, mutationPid);
    await blocker.query('commit');
    lockOpen = false;
    let denied = false;
    try { await mutationPending; }
    catch (error) { denied = error.code === '42501'; }
    mutationPending = null;
    if (!denied) stop('task4-mutation-denied-after-logout');
    const final = await observer.query(
      'select revoked_at is not null as revoked, refresh_claim_id is null as claim_cleared from blog_private.admin_sessions where session_id=$1',
      [sessionId],
    );
    if (!final.rows[0]?.revoked || !final.rows[0]?.claim_cleared) stop('task4-logout-final-state');
    const posts = await observer.query('select count(*)::int as count from public.blog_posts where slug=$1', [slug]);
    if (posts.rows[0]?.count !== 0) stop('task4-revoked-mutation-no-write');
    process.stdout.write('PASS actual logout RPC blocked the concurrent owner mutation; pg_blocking_pids observed the wait and the mutation was denied after revocation.\n');
  } finally {
    if (lockOpen) await blocker.query('rollback').catch(() => {});
    if (mutationPending) await mutationPending.catch(() => {});
    await observer.query('delete from blog_private.admin_sessions where session_id=$1', [sessionId]).catch(() => {});
    if (ownerInstalled) await observer.query('update blog_private.settings set authorized_owner_id=null where singleton and authorized_owner_id=$1', [ownerId]).catch(() => {});
    const finalBaseline = await observer.query('select (select authorized_owner_id is null from blog_private.settings where singleton) as owner_null,(select count(*)::int from blog_private.admin_sessions where revoked_at is null) as sessions').catch(() => null);
    await Promise.all([blocker.end().catch(() => {}), mutation.end().catch(() => {}), observer.end().catch(() => {})]);
    await close();
    if (!finalBaseline?.rows[0]?.owner_null || finalBaseline.rows[0]?.sessions !== 0) stop('task4-session-fixture-cleanup');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch(error => {
    const stage = typeof error?.stage === 'string' && /^[a-z0-9-]{1,72}$/i.test(error.stage) ? error.stage : 'logout-concurrency';
    process.stderr.write(`Task 4 database proof stopped at ${stage}.\n`);
    process.exitCode = 1;
  });
}
