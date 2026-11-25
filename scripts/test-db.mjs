import { spawnSync } from 'node:child_process';
import { deepStrictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
const expectedPort = 54342;
const allowedTests = new Map([
  ['editorial', 'tests/db/editorial.sql'],
  ['editorial-inputs', 'tests/db/editorial-inputs.sql'],
  ['guard-mutations', 'tests/db/guard-mutations.sql'],
  ['publication', 'tests/db/publication.sql'],
  ['publication-dispatch', 'tests/db/publication-dispatch.sql'],
  ['build-slot', 'tests/db/build-slot.sql'],
  ['storage', 'tests/db/storage.sql'],
]);

function fail(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

async function captureTransactionalTestState(client) {
  const result = await client.query(`
    select
      (select jsonb_build_object('id', authorized_owner_id, 'updated_at', updated_at)
        from blog_private.settings where singleton) as owner,
      (select jsonb_build_object(
        'latest_release', latest_confirmed_release_id,
        'active_request', active_request_id,
        'active_deploy_id', active_deploy_id,
        'active_build_kind', active_build_kind,
        'active_build_release_id', active_build_release_id,
        'active_build_generation', active_build_generation,
        'active_attempt_id', active_attempt_id,
        'last_published_deploy_id', last_published_deploy_id,
        'last_published_release_id', last_published_release_id,
        'generation', generation,
        'updated_at', updated_at
      ) from blog_private.build_slot where singleton) as build_slot,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(deploy_id, ',' order by deploy_id), '')))
        from blog_private.reconciled_deploys) as reconciled_deploys,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(release_id::text, ',' order by release_id), '')))
        from blog_private.releases) as releases,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(id::text, ',' order by id), '')))
        from public.blog_posts) as posts,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(id, ',' order by id), '')))
        from public.blog_media) as media,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(session_id::text, ',' order by session_id), '')))
        from blog_private.admin_sessions) as sessions,
      (select jsonb_build_object('count', count(*), 'ids_hash', md5(coalesce(string_agg(request_id::text, ',' order by request_id), '')))
        from blog_private.publication_requests) as requests
  `);
  if (result.rowCount !== 1) fail('transaction-state-capture');
  return result.rows[0];
}

function dockerContextSocket() {
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const endpoint = result.status === 0 ? result.stdout.trim() : '';
  if (!endpoint.startsWith('unix:///')) fail('docker-local-socket');
  return endpoint.slice('unix://'.length);
}

async function run() {
  const selectedNames = process.argv.slice(2);
  const names = selectedNames.length ? selectedNames : [...allowedTests.keys()];
  if (names.some((name) => !allowedTests.has(name)) || new Set(names).size !== names.length) {
    fail('test-selection');
  }

  const configText = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  const config = parseTaskProjectConfig(configText);
  if (config.projectId !== projectId || config.databasePort !== expectedPort) fail('project-config');

  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: dockerContextSocket(),
    allowedNames: new Set([
      `supabase_db_${projectId}`,
      `supabase_auth_${projectId}`,
      `supabase_rest_${projectId}`,
      `supabase_kong_${projectId}`,
    ]),
  });
  let client;
  try {
    const socketPath = await proxy.listen();
    const environment = createSupabaseCliEnvironment(process.env, socketPath);
    const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env: environment });
    if (version.status !== 0 || version.stdout.trim() !== '2.120.0') fail('cli-version');
    const statusResult = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env: environment });
    if (statusResult.status !== 0) fail('local-status');
    let status;
    try { status = JSON.parse(statusResult.stdout); } catch { fail('local-status-json'); }
    let target;
    try { target = validateLocalDatabaseTarget(status, config.projectId, config.databasePort); } catch { fail('database-target'); }

    const { Client } = await import('pg');
    client = new Client({
      connectionString: status.DB_URL,
      connectionTimeoutMillis: 5000,
      query_timeout: 30000,
      statement_timeout: 30000,
      application_name: 'jt-studio-task3-db-tests',
    });
    await client.connect();
    client.on('notice', (notice) => {
      const stage = /^task7-stage:([a-z0-9-]{1,48})$/u.exec(notice?.message ?? '')?.[1];
      if (stage) process.stdout.write(`OBS publication-dispatch-stage=${stage}\n`);
    });
    const identity = await client.query("select current_database() as db, current_setting('server_version_num') as version");
    if (identity.rows[0]?.db !== 'postgres' || !identity.rows[0]?.version?.startsWith('17')) fail('database-identity');
    const serverVersion = Number(identity.rows[0].version);
    const serverVersionLabel = `PostgreSQL ${Math.trunc(serverVersion / 10000)}.${serverVersion % 10000}`;

    for (const name of names) {
      const sql = await readFile(join(root, allowedTests.get(name)), 'utf8');
      const before = await captureTransactionalTestState(client);
      try { await client.query(sql); }
      catch (error) {
        await client.query('rollback').catch(() => {});
        const afterFailure = await captureTransactionalTestState(client);
        try { deepStrictEqual(afterFailure, before); }
        catch { fail(`${name}-persisted-side-effects-after-failure`); }
        process.stdout.write(`PASS ${name}-no-persistent-side-effects-after-failure\n`);
        const sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'UNKNOWN';
        const constraint = typeof error?.constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(error.constraint)
          ? `-${error.constraint}` : '';
        const line = typeof error?.where === 'string'
          ? /inline_code_block line (\d+) at RAISE/i.exec(error.where)?.[1]
          : undefined;
        const source = typeof error?.where === 'string'
          ? [...error.where.matchAll(/PL\/pgSQL function ([a-z0-9_.]+)(?:\([^)]*\))? line (\d+)/gi)]
            .map((match) => `${match[1]}-line-${match[2]}`).slice(-3).join('-via-')
          : '';
        fail(`sql-${name}-${sqlstate}${constraint}${line ? `-raise-line-${line}` : ''}${source ? `-${source}` : ''}`);
      }
      process.stdout.write(`PASS ${name}\n`);
      const after = await captureTransactionalTestState(client);
      try { deepStrictEqual(after, before); }
      catch { fail(`${name}-persisted-side-effects`); }
      process.stdout.write(`PASS ${name}-no-persistent-side-effects\n`);
    }
    process.stdout.write(`Task-owned ${serverVersionLabel} at loopback:${target.port}; ${names.length} SQL gates passed.\n`);
  } finally {
    if (client) await client.end().catch(() => {});
    await proxy.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch((error) => {
    process.stderr.write(`Task 3 database gate stopped at ${error?.stage ?? 'database-test'}; no raw connection output was retained.\n`);
    process.exitCode = 1;
  });
}
