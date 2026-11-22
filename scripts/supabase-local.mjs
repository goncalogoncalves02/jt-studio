import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as requestHttp } from 'node:http';
import { createDockerLoopbackProxy } from './docker-loopback-proxy.mjs';
import { assertProvisionable, parseContainerInventoryRows, parseListenerOutput, probeTaskServices, readResumeInventory, resolveProtectedContainerRows, resumeExistingTaskStack, taskContainerReadiness, TASK_RESUME_CONTAINERS, validateResumeStack } from './supabase-resume.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const taskHome = '/tmp/jt-studio-supabase-cli-home';
const projectId = 'jt-studio-blog-tests';
const networkName = 'jt-studio-blog-tests-network';
const excludedServices = [
  'realtime', 'storage-api', 'imgproxy', 'mailpit', 'postgres-meta', 'studio',
  'edge-runtime', 'logflare', 'vector', 'supavisor',
];
const allowedContainers = new Set([
  `supabase_db_${projectId}`,
  `supabase_auth_${projectId}`,
  `supabase_rest_${projectId}`,
  `supabase_kong_${projectId}`,
]);

function safeError(stage, error) {
  const wrapped = new Error(`${stage} failed`);
  wrapped.code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'UNSPECIFIED';
  wrapped.stage = typeof error?.stage === 'string' && /^[a-z][a-z0-9 /-]{0,64}$/.test(error.stage)
    ? error.stage : stage;
  return wrapped;
}

export function createSupabaseCliEnvironment(baseEnvironment, proxySocketPath) {
  const childEnvironment = {
    ...baseEnvironment,
    HOME: taskHome,
    XDG_CONFIG_HOME: join(taskHome, '.config'),
    XDG_CACHE_HOME: join(taskHome, '.cache'),
    DOCKER_HOST: `unix://${proxySocketPath}`,
    SUPABASE_TELEMETRY_DISABLED: '1',
  };
  delete childEnvironment.DOCKER_CONTEXT;
  delete childEnvironment.SUPABASE_ACCESS_TOKEN;
  return childEnvironment;
}

export function runCliCapture(executable, args, options) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const captureLimit = 1024 * 1024;
    const append = (chunks, stream, currentBytes, setBytes) => {
      stream.on('data', (chunk) => {
        const nextBytes = currentBytes() + chunk.length;
        if (nextBytes > captureLimit) {
          if (!settled) {
            settled = true;
            child.kill('SIGTERM');
            rejectResult(new Error('Supabase CLI output exceeded the capture limit'));
          }
          return;
        }
        setBytes(nextBytes);
        chunks.push(chunk);
      });
    };
    append(stdout, child.stdout, () => stdoutBytes, (value) => { stdoutBytes = value; });
    append(stderr, child.stderr, () => stderrBytes, (value) => { stderrBytes = value; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      rejectResult(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolveResult({
        status: signal ? null : (code ?? 127),
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function parseTaskProjectConfig(source) {
  const configuredProjectId = /^project_id\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  let inDatabase = false;
  let inApi = false;
  let databasePort;
  let apiPort;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inDatabase = /^\s*\[db\]\s*$/.test(line);
      inApi = /^\s*\[api\]\s*$/.test(line);
    }
    if (inDatabase) {
      const match = /^\s*port\s*=\s*(\d+)\s*$/.exec(line);
      if (match) databasePort = Number(match[1]);
    }
    if (inApi) {
      const match = /^\s*port\s*=\s*(\d+)\s*$/.exec(line);
      if (match) apiPort = Number(match[1]);
    }
  }
  return { projectId: configuredProjectId, databasePort, apiPort };
}

export function validateLocalDatabaseTarget(status, expectedProjectId, expectedPort) {
  if (!status || typeof status !== 'object' || Array.isArray(status)
      || typeof status.DB_URL !== 'string') {
    throw new TypeError('Local Supabase status has no database URL');
  }
  let databaseUrl;
  try { databaseUrl = new URL(status.DB_URL); } catch { throw new TypeError('Local Supabase database URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
      || databaseUrl.hostname !== '127.0.0.1'
      || Number(databaseUrl.port) !== expectedPort
      || databaseUrl.username !== 'postgres'
      || !databaseUrl.password
      || databaseUrl.pathname !== '/postgres'
      || databaseUrl.search || databaseUrl.hash
      || expectedProjectId !== projectId) {
    throw new Error('Supabase database target is outside the task-owned loopback project');
  }
  return { hostname: databaseUrl.hostname, port: Number(databaseUrl.port), database: 'postgres' };
}

export function assertContainerIdNotProtected(containerId, inventory) {
  if (typeof containerId !== 'string' || !/^[0-9a-f]{64}$/.test(containerId)
      || !inventory || !Array.isArray(inventory.protectedContainers)) {
    throw new TypeError('Protected Docker inventory is invalid');
  }
  if (inventory.protectedContainers.some((container) => container?.ID === containerId)) {
    throw new Error('Task database container is part of the protected Docker inventory');
  }
  return containerId;
}

function dockerOutput(args) {
  const result = spawnSync('docker', ['--context', 'desktop-linux', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) {
    const error = new Error('Docker Desktop query failed');
    error.code = dockerFailureCode(result);
    throw error;
  }
  return result.stdout.trim();
}

export function dockerFailureCode(result) {
  if (result?.error) {
    const knownSpawnCodes = new Set(['EACCES', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EPERM']);
    return knownSpawnCodes.has(result.error.code) ? `DOCKER_${result.error.code}` : 'DOCKER_SPAWN_ERROR';
  }
  if (Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255) {
    return `DOCKER_EXIT_${result.status}`;
  }
  return 'DOCKER_TERMINATED';
}

export function dockerFactsStage(args) {
  if (args[0] === 'container' && args[1] === 'inspect') return 'docker container inspect';
  if (args[0] === 'container' && args[1] === 'ls') return 'docker container inventory';
  if (args[0] === 'volume' && args[1] === 'inspect') return 'docker task volume inspect';
  if (args[0] === 'volume' && args[1] === 'ls') return 'docker volume inventory';
  if (args[0] === 'network' && args[1] === 'inspect') return 'docker task network inspect';
  return 'docker task identity query';
}

function readDockerFacts(args) {
  try { return dockerOutput(args); } catch (cause) {
    const error = new Error('Task-owned Docker identity check failed');
    error.stage = dockerFactsStage(args);
    error.code = typeof cause?.code === 'string' && /^(DOCKER_(?:EACCES|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOENT|EPERM|SPAWN_ERROR|TERMINATED)|DOCKER_EXIT_(?:0|[1-9][0-9]{0,2}))$/.test(cause.code)
      ? cause.code : 'DOCKER_QUERY_FAILED';
    throw error;
  }
}

export function resumeContainerInspectFormat() {
  return '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{with index .State "Health"}}{{.Status}}{{else}}none{{end}}|{{with index .Config "Healthcheck"}}configured{{else}}none{{end}}|{{json .Config.Labels}}|{{json .NetworkSettings.Networks}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}';
}

export function parseResumeContainerProjection(output) {
  const parts = output.split('|');
  if (parts.length !== 11) throw new Error('Task container inspect result is incomplete');
  try {
    const labels = JSON.parse(parts[7]);
    const networks = JSON.parse(parts[8]);
    const bindings = JSON.parse(parts[9]);
    const mounts = JSON.parse(parts[10]);
    return {
      Id: parts[0], Name: parts[1],
      State: { Status: parts[2], ExitCode: Number(parts[3]), OOMKilled: parts[4] === 'true', Health: parts[5] === 'none' ? undefined : { Status: parts[5] } },
      Config: { Labels: labels, Healthcheck: parts[6] === 'configured' ? {} : undefined },
      NetworkSettings: { Networks: networks },
      HostConfig: { PortBindings: bindings }, Mounts: mounts,
    };
  } catch { throw new Error('Task container inspect result is invalid'); }
}

function inspectResumeContainer(id) {
  const args = ['container', 'inspect', id, '--format', resumeContainerInspectFormat()];
  try { return parseResumeContainerProjection(readDockerFacts(args)); }
  catch (cause) {
    if (cause?.stage) throw cause;
    const error = new Error('Task Docker inspect projection is invalid');
    error.code = 'DOCKER_PROJECTION_INVALID';
    error.stage = 'docker container projection';
    throw error;
  }
}

export function inspectResumeFacts(config) {
  const protectedInventory = readResumeInventory();
  if (!Array.isArray(protectedInventory.protectedContainers) || !Array.isArray(protectedInventory.protectedVolumes)) {
    throw new Error('Protected Docker inventory is invalid');
  }
  const observedContainerRows = parseContainerInventoryRows(readDockerFacts(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}|{{.Names}}']));
  const observedContainerIds = observedContainerRows.map(({ id }) => id);
  const resolvedProtectedRows = resolveProtectedContainerRows(protectedInventory.protectedContainers, observedContainerRows);
  const protectedIds = resolvedProtectedRows.map(({ id }) => id);
  const observedProtectedContainerIds = [...protectedIds];
  const observedVolumeNames = readDockerFacts(['volume', 'ls', '--format', '{{.Name}}']).split('\n').filter(Boolean);
  const protectedVolumeNames = protectedInventory.protectedVolumes.map((volume) => volume.Name);
  const observedProtectedVolumeNames = observedVolumeNames.filter((name) => protectedVolumeNames.includes(name));
  const containers = Object.values(TASK_RESUME_CONTAINERS).map((spec) => inspectResumeContainer(spec.id));
  const networkParts = readDockerFacts(['network', 'inspect', networkName, '--format',
    '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}|{{index .Labels "org.jt-studio.project"}}']).split('|');
  const volumeParts = readDockerFacts(['volume', 'inspect', 'supabase_db_jt-studio-blog-tests', '--format', '{{.Name}}|{{.Driver}}']).split('|');
  const ss = spawnSync('ss', ['-Hltn', 'sport = :54340 or sport = :54341 or sport = :54342 or sport = :54343 or sport = :54344'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (ss.status !== 0) throw new Error('Task port listener inspection failed');
  const listeners = parseListenerOutput(ss.stdout, new Set([54340, 54341, 54342, 54343, 54344]));
  return {
    containers, expectedProtectedContainerIds: protectedIds, observedProtectedContainerIds,
    expectedProtectedVolumeNames: protectedVolumeNames, observedProtectedVolumeNames,
    observedContainerIds, observedVolumeNames,
    network: { Id: networkParts[0], Name: networkParts[1], Driver: networkParts[2], Scope: networkParts[3], HostBindingIPv4: networkParts[4], ProjectLabel: networkParts[5] },
    volume: { Name: volumeParts[0], Driver: volumeParts[1] }, config, listeners,
  };
}

function startViaDockerProxy(socketPath, id) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = requestHttp({ socketPath, path: `/v1.56/containers/${id}/start`, method: 'POST', agent: false }, (res) => {
      res.resume();
      res.once('end', () => {
        if (res.statusCode === 204 || res.statusCode === 304) resolveRequest(res.statusCode);
        else rejectRequest(new Error(`Docker start returned HTTP ${res.statusCode ?? 0}`));
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Docker start request timed out')));
    req.once('error', rejectRequest);
    req.end();
  });
}

function runtimeIdentity() {
  const upstream = dockerOutput([
    'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}',
  ]);
  if (!upstream.startsWith('unix:///')) throw new Error('Docker Desktop must use a local Unix socket');
  const networkFacts = dockerOutput([
    'network', 'inspect', networkName, '--format',
    '{{.Id}}|{{.Driver}}|{{.Scope}}|{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}|{{index .Labels "org.jt-studio.project"}}',
  ]).split('|');
  if (networkFacts.length !== 5 || !/^[0-9a-f]{64}$/.test(networkFacts[0])
      || networkFacts[1] !== 'bridge' || networkFacts[2] !== 'local'
      || networkFacts[3] !== '127.0.0.1' || networkFacts[4] !== projectId) {
    throw new Error('Task-owned loopback bridge identity check failed');
  }
  return { upstreamSocketPath: upstream.slice('unix://'.length), networkId: networkFacts[0] };
}

function assertTaskDatabaseContainer(networkId, expectedPort) {
  const facts = dockerOutput([
    'container', 'inspect', `supabase_db_${projectId}`, '--format',
    '{{.Id}}|{{.State.Status}}|{{.Name}}|{{index .Config.Labels "com.supabase.cli.project"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostIp}}|{{.HostPort}}{{end}}|{{range $name, $net := .NetworkSettings.Networks}}{{$net.NetworkID}}{{end}}',
  ]).split('|');
  if (facts.length !== 8 || !/^[0-9a-f]{64}$/.test(facts[0])
      || facts[1] !== 'running' || facts[2] !== `/supabase_db_${projectId}`
      || facts[3] !== projectId || facts[4] !== projectId
      || facts[5] !== '127.0.0.1' || facts[6] !== String(expectedPort) || facts[7] !== networkId) {
    throw new Error('Task database container identity check failed');
  }
  return facts[0];
}

function privateLogPath() {
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '');
  const action = process.argv[2] === 'migrate' ? 'migrate' : process.argv[2] === 'resume' ? 'resume' : 'provision';
  return join(root, '.superpowers/sdd/2026-10-11-blog-editorial', `task3-supabase-${action}-${stamp}.private.log`);
}

export function localMigrationArgs(cliPath, workdir) {
  return [cliPath, 'migration', 'up', '--local', '--workdir', workdir];
}

async function startLocalSupabase() {
  let runtime;
  try { runtime = runtimeIdentity(); } catch (error) { throw safeError('runtime identity', error); }
  try {
    const projectContainers = parseContainerInventoryRows(dockerOutput(['container', 'ls', '-a', '--no-trunc', '--filter', `label=com.supabase.cli.project=${projectId}`, '--format', '{{.ID}}|{{.Names}}']));
    assertProvisionable(projectContainers);
  } catch (error) { throw safeError('provision absence guard', error); }
  let log;
  let logWrites = Promise.resolve();
  const appendUpgradeEvent = (event) => {
    if (!log) return;
    const safeEvent = {
      method: event.method,
      endpoint: event.endpoint,
      upgrade: event.upgrade,
      connectionUpgrade: event.connectionUpgrade,
    };
    logWrites = logWrites.then(() => log.writeFile(`\n[docker-upgrade] ${JSON.stringify(safeEvent)}\n`));
  };
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: runtime.upstreamSocketPath,
    allowedNames: allowedContainers,
    onUpgradeEvent: appendUpgradeEvent,
  });
  let socketPath;
  try { socketPath = await proxy.listen(); } catch (error) { throw safeError('proxy listener', error); }
  const logPath = privateLogPath();
  try {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    log = await open(logPath, 'wx', 0o600);
  } catch (error) {
    await proxy.close();
    throw safeError('private log initialization', error);
  }
  const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
  const childEnvironment = createSupabaseCliEnvironment(process.env, socketPath);
  const args = [
    cliPath,
    'start',
    '--network-id', runtime.networkId,
    '--exclude', excludedServices.join(','),
  ];

  let child;
  let spawnError;
  let proxyCloseError;
  const append = (chunk) => { logWrites = logWrites.then(() => log.writeFile(chunk)); };
  try {
    await mkdir(taskHome, { recursive: true, mode: 0o700 });
    child = spawn(process.execPath, args, { cwd: root, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const forwardSignal = (signal) => { if (child && child.exitCode === null) child.kill(signal); };
    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);
    const code = await new Promise((resolveCode) => {
      child.once('error', (error) => { spawnError = error; resolveCode(127); });
      child.once('exit', (exitCode, signal) => resolveCode(signal ? 128 : (exitCode ?? 127)));
    });
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
    await logWrites;
    await log.sync();
    process.stdout.write(`Supabase CLI exit=${code}; saída privada=${logPath}\n`);
    if (spawnError) process.stderr.write('Supabase CLI could not be started.\n');
    process.exitCode = code;
  } finally {
    await log.close();
    try { await proxy.close(); } catch (error) { proxyCloseError = error; }
  }
  if (proxyCloseError) throw safeError('proxy shutdown', proxyCloseError);
}

async function waitContainerReady(id, stage, requireHealth = false) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    let projection;
    try {
      projection = parseReadinessProjection(readDockerFacts([
        'container', 'inspect', id, '--format', readinessInspectFormat(),
      ]));
    } catch (cause) {
      const error = cause?.stage ? cause : Object.assign(new Error('Container readiness response is invalid'), {
        code: 'DOCKER_PROJECTION_INVALID', stage: 'docker readiness projection',
      });
      throw safeError(stage, error);
    }
    const readiness = taskContainerReadiness(projection.status, projection.health, projection.healthcheckConfigured, requireHealth);
    if (readiness === 'ready') return;
    if (readiness === 'failed') throw safeError(stage, new Error('Container readiness failed closed'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw safeError(stage, new Error('Container readiness deadline exceeded'));
}

export function readinessInspectFormat() {
  return '{{.State.Status}}|{{with index .State "Health"}}{{.Status}}{{else}}none{{end}}|{{with index .Config "Healthcheck"}}configured{{else}}none{{end}}';
}

export function parseReadinessProjection(output) {
  const fields = output.split('|');
  if (fields.length !== 3 || !fields[0] || !fields[1] || !['none', 'configured'].includes(fields[2])) {
    throw new Error('Container readiness response is invalid');
  }
  return { status: fields[0], health: fields[1], healthcheckConfigured: fields[2] === 'configured' };
}

async function readLocalStatus(cliPath, childEnvironment, config) {
  const result = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env: childEnvironment });
  if (result.status !== 0) {
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    const code = /health|healthy|database.*ready|not ready/i.test(diagnostic) ? 'STATUS_DB_NOT_READY'
      : /docker|daemon|socket/i.test(diagnostic) ? 'STATUS_DOCKER_UNAVAILABLE'
        : /config|project|link/i.test(diagnostic) ? 'STATUS_CONFIG' : 'STATUS_UNKNOWN';
    const error = new Error('Status command failed');
    error.code = code;
    throw safeError('local Supabase status', error);
  }
  let status;
  try { status = JSON.parse(result.stdout); } catch { throw safeError('local Supabase status', new Error('Status response is invalid')); }
  try { validateLocalDatabaseTarget(status, config.projectId, config.databasePort); }
  catch (error) { throw safeError('local Supabase database target', error); }
  return status;
}

async function waitForDatabase(databaseUrl) {
  const { Client } = await import('pg');
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500, query_timeout: 2500, statement_timeout: 2500 });
    try {
      await client.connect();
      const result = await client.query("select current_database() as database, current_setting('server_version_num') as version");
      const row = result.rows[0];
      if (row?.database !== 'postgres' || !String(row.version).startsWith('17')) {
        throw new Error('Database identity or major version is unexpected');
      }
      return { database: row.database, major: String(row.version).slice(0, 2) };
    } catch (error) {
      const retryable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error?.code)
        || error?.code === '57P03';
      if (!retryable) throw safeError('PostgreSQL identity or authorization', error);
      lastError = error;
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw safeError('PostgreSQL health', lastError ?? new Error('Database readiness timed out'));
}

async function resumeLocalSupabase() {
  const configText = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  const config = parseTaskProjectConfig(configText);
  let facts;
  try {
    facts = inspectResumeFacts(config);
    validateResumeStack(facts);
  } catch (cause) {
    const error = cause?.code ? cause : Object.assign(new Error('Task resume guard rejected the observed state'), {
      code: 'TASK_RESUME_GUARD_FAILED', stage: 'resume stack guard',
    });
    throw safeError('resume preflight', error);
  }

  let runtime;
  try { runtime = runtimeIdentity(); } catch (error) { throw safeError('runtime identity', error); }
  const ids = Object.values(TASK_RESUME_CONTAINERS).map(({ id }) => id);
  let log;
  let proxy;
  let logWrites = Promise.resolve();
  const append = (line) => { if (log) logWrites = logWrites.then(() => log.writeFile(`${line}\n`)); };
  try {
    const logPath = join(root, '.superpowers/sdd/2026-10-11-blog-editorial', `task3-supabase-resume-${new Date().toISOString().replaceAll(':', '').replaceAll('-', '')}.private.log`);
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    log = await open(logPath, 'wx', 0o600);
    proxy = createDockerLoopbackProxy({
      upstreamSocketPath: runtime.upstreamSocketPath,
      allowedNames: allowedContainers,
      verifiedContainerIds: new Set(ids),
      resumableContainerIds: new Set(ids),
    });
    const socketPath = await proxy.listen();
    const childEnvironment = createSupabaseCliEnvironment(process.env, socketPath);
    const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env: childEnvironment });
    if (version.status !== 0 || version.stdout.trim() !== '2.120.0') throw safeError('pinned Supabase CLI version', new Error('CLI version mismatch'));

    let database;
    await resumeExistingTaskStack(facts, {
      startContainer: async (service, id) => {
        append(`start service=${service} id=verified-full-id`);
        await startViaDockerProxy(socketPath, id);
      },
      waitRunning: (service, id) => waitContainerReady(id, `${service} container readiness`),
      afterDatabase: async (id) => {
        await waitContainerReady(id, 'PostgreSQL health', true);
        const status = await readLocalStatus(cliPath, childEnvironment, config);
        database = await waitForDatabase(status.DB_URL);
        append(`ready service=db database=${database.database} major=${database.major}`);
      },
    });
    if (!database) throw safeError('PostgreSQL health', new Error('Database SQL readiness was not established'));
    const finalFacts = inspectResumeFacts(config);
    validateResumeStack(finalFacts);
    const status = await readLocalStatus(cliPath, childEnvironment, config);
    const apiUrl = new URL(status.API_URL);
    if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== '127.0.0.1' || Number(apiUrl.port) !== config.apiPort
      || typeof status.ANON_KEY !== 'string' || !status.ANON_KEY) {
      throw safeError('local Data API target', new Error('API status target is outside task loopback'));
    }
    try { await probeTaskServices(apiUrl, status.ANON_KEY); }
    catch (error) { throw safeError('functional local services', error); }
    await logWrites;
    await log.sync();
    process.stdout.write(`Task Supabase runtime resumed and verified; private evidence=${logPath}\n`);
  } finally {
    if (log) {
      await logWrites.catch(() => {});
      await log.close();
    }
    if (proxy) await proxy.close();
  }
}

async function migrateLocalSupabase() {
  let runtime;
  try { runtime = runtimeIdentity(); } catch (error) { throw safeError('runtime identity', error); }
  const configText = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  const config = parseTaskProjectConfig(configText);
  if (config.projectId !== projectId || config.databasePort !== 54342) {
    throw safeError('project configuration', new Error('Task project configuration check failed'));
  }
  let databaseContainerId;
  try {
    databaseContainerId = assertTaskDatabaseContainer(runtime.networkId, config.databasePort);
    const inventory = JSON.parse(await readFile('/tmp/jt-studio-protected-docker-20261011.json', 'utf8'));
    databaseContainerId = assertContainerIdNotProtected(databaseContainerId, inventory);
  }
  catch (error) { throw safeError('database container identity', error); }

  let log;
  let logWrites = Promise.resolve();
  const appendUpgradeEvent = (event) => {
    if (!log) return;
    const safeEvent = {
      method: event.method,
      endpoint: event.endpoint,
      upgrade: event.upgrade,
      connectionUpgrade: event.connectionUpgrade,
    };
    logWrites = logWrites.then(() => log.writeFile(`\n[docker-upgrade] ${JSON.stringify(safeEvent)}\n`));
  };
  const appendDeleteEvent = (event) => {
    if (!log) return;
    const safeEvent = {
      endpoint: event.endpoint,
      idKind: event.idKind,
      idFormat: event.idFormat,
      volumeFlag: event.volumeFlag,
      forceFlag: event.forceFlag,
    };
    logWrites = logWrites.then(() => log.writeFile(`\n[docker-delete] ${JSON.stringify(safeEvent)}\n`));
  };
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: runtime.upstreamSocketPath,
    allowedNames: allowedContainers,
    verifiedContainerIds: new Set([databaseContainerId]),
    verifiedContainerNameIds: new Map([[`supabase_db_${projectId}`, databaseContainerId]]),
    onUpgradeEvent: appendUpgradeEvent,
    onDeleteEvent: appendDeleteEvent,
  });
  let socketPath;
  try { socketPath = await proxy.listen(); } catch (error) { throw safeError('proxy listener', error); }
  const logPath = privateLogPath();
  try {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await mkdir(taskHome, { recursive: true, mode: 0o700 });
    log = await open(logPath, 'wx', 0o600);
  } catch (error) {
    await proxy.close();
    throw safeError('private log initialization', error);
  }

  const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
  const childEnvironment = createSupabaseCliEnvironment(process.env, socketPath);
  let versionResult;
  try { versionResult = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env: childEnvironment }); }
  catch (error) {
    await log.close();
    await proxy.close();
    throw safeError('pinned Supabase CLI version', error);
  }
  if (versionResult.status !== 0 || versionResult.stdout.trim() !== '2.120.0') {
    await log.close();
    await proxy.close();
    throw safeError('pinned Supabase CLI version', new Error('CLI version check failed'));
  }
  let statusResult;
  try { statusResult = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env: childEnvironment }); }
  catch (error) {
    await log.close();
    await proxy.close();
    throw safeError('loopback database URL guard', error);
  }
  let status;
  try {
    await logWrites;
    if (statusResult.status !== 0) throw new Error('Supabase local status command failed');
    status = JSON.parse(statusResult.stdout);
    validateLocalDatabaseTarget(status, config.projectId, config.databasePort);
  } catch (error) {
    await log.close();
    await proxy.close();
    throw safeError('loopback database URL guard', error);
  }

  const args = localMigrationArgs(cliPath, root);
  let child;
  let spawnError;
  let proxyCloseError;
  const append = (chunk) => { logWrites = logWrites.then(() => log.writeFile(chunk)); };
  try {
    child = spawn(process.execPath, args, { cwd: root, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const code = await new Promise((resolveCode) => {
      child.once('error', (error) => { spawnError = error; resolveCode(127); });
      child.once('exit', (exitCode, signal) => resolveCode(signal ? 128 : (exitCode ?? 127)));
    });
    await logWrites;
    await log.sync();
    process.stdout.write(`Supabase local migration up exit=${code}; saída privada=${logPath}\n`);
    if (spawnError) process.stderr.write('Supabase CLI could not be started.\n');
    process.exitCode = code;
  } finally {
    await log.close();
    try { await proxy.close(); } catch (error) { proxyCloseError = error; }
  }
  if (proxyCloseError) throw safeError('proxy shutdown', proxyCloseError);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!['provision', 'resume', 'migrate'].includes(process.argv[2]) || process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/supabase-local.mjs provision|resume|migrate\n');
    process.exitCode = 2;
  } else if (process.argv[2] === 'start') {
    await startLocalSupabase().catch((error) => {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNSPECIFIED';
      const stage = typeof error?.stage === 'string' ? error.stage : 'CLI lifecycle';
      process.stderr.write(`Task-owned Supabase runtime failed during ${stage} (error=${code}); inspect local guards without exposing private output.\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[2] === 'provision') {
    await startLocalSupabase().catch((error) => {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNSPECIFIED';
      const stage = typeof error?.stage === 'string' ? error.stage : 'CLI lifecycle';
      process.stderr.write(`Task-owned Supabase provision failed during ${stage} (error=${code}); inspect local guards without exposing private output.\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[2] === 'resume') {
    await resumeLocalSupabase().catch((error) => {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNSPECIFIED';
      const stage = typeof error?.stage === 'string' ? error.stage : 'container resume';
      process.stderr.write(`Task-owned Supabase resume failed during ${stage} (error=${code}); inspect local guards without exposing private output.\n`);
      process.exitCode = 1;
    });
  } else {
    await migrateLocalSupabase().catch((error) => {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'UNSPECIFIED';
      const stage = typeof error?.stage === 'string' ? error.stage : 'CLI lifecycle';
      process.stderr.write(`Task-owned Supabase migration failed during ${stage} (error=${code}); inspect local guards without exposing private output.\n`);
      process.exitCode = 1;
    });
  }
}
