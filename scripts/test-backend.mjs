import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDockerLoopbackProxy } from './docker-loopback-proxy.mjs';
import {
  createSupabaseCliEnvironment,
  parseTaskProjectConfig,
  runCliCapture,
  validateLocalDatabaseTarget,
} from './supabase-local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = 'jt-studio-blog-tests';
const expectedDbPort = 54342;
const expectedApiPort = 54341;

function stop(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

function localDockerSocket() {
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) stop('docker-local-socket');
  return endpoint.slice('unix://'.length);
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  const errorText = [payload?.msg, payload?.message, payload?.error_description, payload?.error]
    .filter((value) => typeof value === 'string').join(' ').toLowerCase();
  const errorClass = /invalid api key|api key is invalid/.test(errorText) ? 'invalid-key'
    : /email/.test(errorText) && /invalid|valid/.test(errorText) ? 'email-validation'
      : /password/.test(errorText) ? 'password-validation'
        : /signup.*disabled|signups.*disabled/.test(errorText) ? 'signup-disabled'
          : /database error|unexpected_failure/.test(errorText) ? 'auth-database-error'
            : payload && typeof payload === 'object' && /^[a-z_]{1,48}$/.test(payload.error_code ?? '') ? payload.error_code : 'unclassified';
  return { status: response.status, payload, errorClass };
}

function apiHeaders(apiKey, accessToken = apiKey) {
  return { apikey: apiKey, authorization: `Bearer ${accessToken}` };
}

function authSessionId(accessToken) {
  try { return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).session_id; }
  catch { return null; }
}

async function createAuthFixture(apiUrl, serviceKey, anonKey) {
  const email = `task3-${randomUUID()}@example.com`;
  const password = `Aa9!${randomUUID()}`;
  const created = await requestJson(new URL('/auth/v1/admin/users', apiUrl), {
    method: 'POST', headers: apiHeaders(serviceKey), body: { email, password, email_confirm: true },
  });
  const userId = created.payload?.id;
  if (![200, 201].includes(created.status) || typeof userId !== 'string') stop(`auth-fixture-create-http-${created.status}-${created.errorClass}`);
  const signedIn = await requestJson(new URL('/auth/v1/token?grant_type=password', apiUrl), {
    method: 'POST', headers: apiHeaders(anonKey), body: { email, password },
  });
  if (signedIn.status !== 200 || typeof signedIn.payload?.access_token !== 'string') {
    const removed = await requestJson(new URL(`/auth/v1/admin/users/${userId}`, apiUrl), { method: 'DELETE', headers: apiHeaders(serviceKey) });
    if (![200, 202, 204].includes(removed.status)) stop('auth-fixture-token-cleanup');
    stop('auth-fixture-token');
  }
  return { userId, accessToken: signedIn.payload.access_token };
}

async function run() {
  const config = parseTaskProjectConfig(await readFile(join(root, 'supabase/config.toml'), 'utf8'));
  if (config.projectId !== projectId || config.databasePort !== expectedDbPort || config.apiPort !== expectedApiPort) stop('project-config');

  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: localDockerSocket(),
    allowedNames: new Set([`supabase_db_${projectId}`, `supabase_auth_${projectId}`, `supabase_rest_${projectId}`, `supabase_kong_${projectId}`]),
  });
  let client;
  let apiUrl;
  let serviceRole;
  let owner;
  let nonOwner;
  const sessionIds = { owner: randomUUID(), nonOwner: randomUUID() };
  let postId;
  let ownerWasSet = false;
  let sessionsWereCreated = false;
  try {
    const socketPath = await proxy.listen();
    const env = createSupabaseCliEnvironment(process.env, socketPath);
    const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env });
    if (version.status !== 0 || version.stdout.trim() !== '2.120.0') stop('cli-version');
    const result = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env });
    if (result.status !== 0) stop('local-status');
    let status;
    try { status = JSON.parse(result.stdout); } catch { stop('local-status-json'); }
    validateLocalDatabaseTarget(status, config.projectId, config.databasePort);
    apiUrl = new URL(status.API_URL);
    if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== '127.0.0.1' || Number(apiUrl.port) !== expectedApiPort
      || typeof status.ANON_KEY !== 'string' || typeof status.SERVICE_ROLE_KEY !== 'string') stop('api-target');
    serviceRole = status.SERVICE_ROLE_KEY;

    const { Client } = await import('pg');
    client = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 15000, application_name: 'jt-studio-task3-api-tests' });
    await client.connect();
    const identity = await client.query("select current_database() as db, current_setting('server_version_num') as version");
    if (identity.rows[0]?.db !== 'postgres' || !identity.rows[0]?.version?.startsWith('17')) stop('database-identity');
    const setting = await client.query('select authorized_owner_id from blog_private.settings where singleton for update');
    if (setting.rowCount !== 1 || setting.rows[0].authorized_owner_id !== null) stop('owner-setting-baseline');

    owner = await createAuthFixture(apiUrl, serviceRole, status.ANON_KEY);
    nonOwner = await createAuthFixture(apiUrl, serviceRole, status.ANON_KEY);
    await client.query('update blog_private.settings set authorized_owner_id = $1 where singleton', [owner.userId]);
    ownerWasSet = true;
    await client.query(
      `insert into blog_private.admin_sessions(session_id,user_id,auth_session_id,generation,expires_at)
       values ($1,$2,$3,1,clock_timestamp()+interval '10 minutes'),($4,$5,$6,1,clock_timestamp()+interval '10 minutes')`,
      [sessionIds.owner, owner.userId, authSessionId(owner.accessToken), sessionIds.nonOwner, nonOwner.userId, authSessionId(nonOwner.accessToken)],
    );
    sessionsWereCreated = true;

    const saved = await requestJson(new URL('/rest/v1/rpc/blog_save_post', apiUrl), {
      method: 'POST', headers: apiHeaders(status.ANON_KEY, owner.accessToken), body: {
        p_input: {
          title: 'Task 3 API fixture', slug: `task3-api-${randomUUID()}`, excerpt: 'Local owner authorization proof',
          document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Local fixture body' }] }] },
          coverMediaId: null, serviceId: null,
        }, p_expected_revision: 0, p_session_id: sessionIds.owner, p_generation: 1,
      },
    });
    if (saved.status !== 200 || typeof saved.payload?.id !== 'string' || saved.payload.revision !== 1) stop('owner-rpc-save');
    postId = saved.payload.id;

    const ownerRows = await requestJson(new URL('/rest/v1/blog_posts?select=id,owner_id&id=eq.' + postId, apiUrl), { headers: apiHeaders(status.ANON_KEY, owner.accessToken) });
    const otherRows = await requestJson(new URL('/rest/v1/blog_posts?select=id,owner_id&id=eq.' + postId, apiUrl), { headers: apiHeaders(status.ANON_KEY, nonOwner.accessToken) });
    const anonRows = await requestJson(new URL('/rest/v1/blog_posts?select=id&id=eq.' + postId, apiUrl), { headers: apiHeaders(status.ANON_KEY) });
    if (ownerRows.status !== 200 || !Array.isArray(ownerRows.payload) || ownerRows.payload.length !== 1
      || ownerRows.payload[0].id !== postId || ownerRows.payload[0].owner_id !== owner.userId) stop('owner-rls-read');
    if (otherRows.status !== 200 || !Array.isArray(otherRows.payload) || otherRows.payload.length !== 0) stop('nonowner-rls-read');
    if (![401, 403].includes(anonRows.status)) stop('anonymous-table-denial');

    const nonOwnerRpc = await requestJson(new URL('/rest/v1/rpc/blog_publication_summary', apiUrl), {
      method: 'POST', headers: apiHeaders(status.ANON_KEY, nonOwner.accessToken),
      body: { p_session_id: sessionIds.nonOwner, p_generation: 1 },
    });
    const anonRpc = await requestJson(new URL('/rest/v1/rpc/blog_publication_summary', apiUrl), {
      method: 'POST', headers: apiHeaders(status.ANON_KEY), body: { p_session_id: sessionIds.owner, p_generation: 1 },
    });
    if (![401, 403].includes(nonOwnerRpc.status)) stop('nonowner-rpc-denial');
    if (![401, 403].includes(anonRpc.status)) stop('anonymous-rpc-denial');

    process.stdout.write('PASS local Data API owner RLS, non-owner isolation, anon denial, RPC grants, synthetic-session owner guard\n');
    process.stdout.write('Auth users were disposable JWT fixtures only; Task 4 Auth lifecycle remains untested.\n');
  } finally {
    let cleanupFailed = false;
    if (client) {
      if (postId) {
        try {
          const deleted = await client.query('delete from public.blog_posts where id = $1', [postId]);
          if (deleted.rowCount !== 1) cleanupFailed = true;
        } catch { cleanupFailed = true; }
      }
      if (sessionsWereCreated) {
        try {
          const deleted = await client.query('delete from blog_private.admin_sessions where session_id = any($1::uuid[])', [[sessionIds.owner, sessionIds.nonOwner]]);
          if (deleted.rowCount !== 2) cleanupFailed = true;
        } catch { cleanupFailed = true; }
      }
      if (ownerWasSet && owner?.userId) {
        try {
          const restored = await client.query('update blog_private.settings set authorized_owner_id = null where singleton and authorized_owner_id = $1', [owner.userId]);
          if (restored.rowCount !== 1) cleanupFailed = true;
        } catch { cleanupFailed = true; }
      }
      await client.end().catch(() => {});
    }
    if (serviceRole && apiUrl) {
      for (const fixture of [owner, nonOwner]) {
        if (fixture?.userId) {
          try {
            const removed = await requestJson(new URL(`/auth/v1/admin/users/${fixture.userId}`, apiUrl), { method: 'DELETE', headers: apiHeaders(serviceRole) });
            if (![200, 202, 204].includes(removed.status)) cleanupFailed = true;
          } catch { cleanupFailed = true; }
        }
      }
    }
    try { await proxy.close(); } catch { cleanupFailed = true; }
    if (cleanupFailed) stop('fixture-cleanup');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch((error) => {
    process.stderr.write(`Task 3 Data API gate stopped at ${error?.stage ?? 'api-test'}; no response bodies or credentials were retained.\n`);
    process.exitCode = 1;
  });
}
