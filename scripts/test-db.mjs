import { spawnSync } from 'node:child_process';
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
]);

function fail(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
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
    const identity = await client.query("select current_database() as db, current_setting('server_version_num') as version");
    if (identity.rows[0]?.db !== 'postgres' || !identity.rows[0]?.version?.startsWith('17')) fail('database-identity');

    for (const name of names) {
      const sql = await readFile(join(root, allowedTests.get(name)), 'utf8');
      try { await client.query(sql); }
      catch (error) {
        const sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'UNKNOWN';
        const constraint = typeof error?.constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(error.constraint)
          ? `-${error.constraint}` : '';
        fail(`sql-${name}-${sqlstate}${constraint}`);
      }
      process.stdout.write(`PASS ${name}\n`);
    }
    process.stdout.write(`Task-owned PostgreSQL ${identity.rows[0].version.slice(0, 2)} at loopback:${target.port}; ${names.length} SQL gates passed.\n`);
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
