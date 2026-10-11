import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as requestHttp } from 'node:http';
import { createDockerLoopbackProxy } from './docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, parseTaskProjectConfig, runCliCapture, validateLocalDatabaseTarget } from './supabase-local.mjs';
import {
  assertStorageVolumeAbsent,
  buildStorageContainerCreateBody,
  buildStorageInitializerSpec,
  buildStorageServiceSpec,
  STORAGE_RUNTIME_IDENTITY,
  validateStorageContainerCreateRequest,
  validateStorageInitialPreflight,
  validateStorageResumePreflight,
  validateStorageResumeContainerInspection,
  startVerifiedStorageContainer,
  validateStorageVolume,
  validateStorageVolumeCreateRequest,
  validateStorageServiceInspection,
} from './supabase-storage-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = 'jt-studio-blog-tests';
const databasePort = 54342;
const apiPort = 54341;
const databaseId = 'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966';
const taskDir = join(root, '.superpowers/sdd/2026-10-11-blog-editorial');
const statePath = join(taskDir, 'task5-storage-runtime.json');
const lockPath = join(taskDir, 'task5-storage-runtime.lock');
const resumeLockPath = join(taskDir, 'task5-storage-runtime.resume.lock');
const imageRef = STORAGE_RUNTIME_IDENTITY.image;
const imageDigest = 'sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154';
const apiVersion = 'v1.45';

function fail(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

export function safeStorageFailureStage(error) {
  if (typeof error?.stage === 'string' && /^[a-z0-9; -]{1,96}$/.test(error.stage)) return error.stage;
  const match = typeof error?.message === 'string' && /^storage-runtime-([a-z0-9-]{1,96})$/.exec(error.message);
  return match ? match[1] : 'storage-runtime-failed';
}

function dockerCapture(args, { timeout = 30000 } = {}) {
  const result = spawnSync('docker', ['--context', 'desktop-linux', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail('docker-readonly-query');
  return result.stdout.trim();
}

function dockerSocketPath() {
  const endpoint = dockerCapture(['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}']);
  if (!endpoint.startsWith('unix:///')) fail('docker-context-socket');
  return endpoint.slice('unix://'.length);
}

function jsonLines(output, stage) {
  try { return output.split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch { fail(stage); }
}

function safeContainerRows() {
  const rows = dockerCapture(['container', 'ls', '-a', '--no-trunc', '--format', '{{json .}}']);
  return jsonLines(rows, 'container-inventory');
}

function safeVolumeRows() {
  const rows = dockerCapture(['volume', 'ls', '--format', '{{json .}}']);
  return jsonLines(rows, 'volume-inventory');
}

function parseLabels(source) {
  if (typeof source !== 'string' || !source) return {};
  return Object.fromEntries(source.split(',').flatMap((part) => {
    const index = part.indexOf('=');
    return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
  }));
}

export function parseStorageFileSizeLimit(source) {
  let inStorage = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inStorage = /^\s*\[storage\]\s*$/.test(line);
    if (!inStorage) continue;
    const match = /^\s*file_size_limit\s*=\s*"(\d+)(B|KiB|MiB|GiB)"\s*$/.exec(line);
    if (match) {
      const factors = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
      const bytes = Number(match[1]) * factors[match[2]];
      if (!Number.isSafeInteger(bytes) || bytes < 1) fail('storage-file-size-config');
      return bytes;
    }
  }
  fail('storage-file-size-config');
}

export function parseDataVolumeAvailableKiB(output) {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2
      || !/^Filesystem\s+1024-blocks\s+Used\s+Available\s+Capacity\s+Mounted on$/u.test(lines[0])) {
    fail('disk-capacity-output');
  }
  const fields = lines[1].split(/\s+/u);
  if (fields.length < 6
      || !/^\d+$/u.test(fields[1])
      || !/^\d+$/u.test(fields[2])
      || !/^\d+$/u.test(fields[3])
      || !/^\d+%$/u.test(fields[4])
      || fields.slice(5).join(' ').trim() === '') {
    fail('disk-capacity-output');
  }
  const available = Number(fields[3]);
  if (!Number.isSafeInteger(available)) fail('disk-capacity-output');
  return available;
}

export function validateStorageCapacityKiB(available) {
  if (!Number.isSafeInteger(available) || available < 2 * 1024 * 1024) fail('disk-capacity');
  return available;
}

export function parseListeningSockets(output) {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const match = /^\s*LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+/.exec(line);
    return match ? [{ host: match[1].replace(/^\[|\]$/g, '').replace(/%.*$/, ''), port: Number(match[2]) }] : [];
  });
}

function tarString(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

function tarOctal(block, start, length) {
  const value = tarString(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) fail('storage-volume-archive-number');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail('storage-volume-archive-number');
  return parsed;
}

export function parseStorageMountArchive(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 1024 || bytes.length > 4 * 1024 * 1024 || bytes.length % 512 !== 0) fail('storage-volume-archive-size');
  const entries = [];
  let offset = 0;
  let sawTerminator = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length
          || !bytes.subarray(offset, offset + 1024).every((byte) => byte === 0)) fail('storage-volume-archive-terminator');
      sawTerminator = true;
      break;
    }
    if (header.toString('utf8', 257, 263) !== 'ustar\0') fail('storage-volume-archive-format');
    const expectedChecksum = tarOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    if (actualChecksum !== expectedChecksum) fail('storage-volume-archive-checksum');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header, 124, 12);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + 512 + paddedSize > bytes.length) fail('storage-volume-archive-truncated');
    entries.push({
      name: fullName,
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      mode: tarOctal(header, 100, 8),
      size,
      type: String.fromCharCode(header[156] || 48),
    });
    offset += 512 + paddedSize;
  }
  if (!sawTerminator || entries.length === 0) fail('storage-volume-archive-terminator');
  for (let index = offset; index < bytes.length; index += 1) if (bytes[index] !== 0) fail('storage-volume-archive-trailing-data');
  const root = entries[0];
  return {
    rootName: root.name,
    entryCount: entries.length,
    rootIsDirectory: root.type === '5' && root.size === 0,
    rootUid: root.uid,
    rootGid: root.gid,
    rootMode: root.mode,
  };
}

function rawStorageMountArchive(containerId) {
  if (![STORAGE_RUNTIME_IDENTITY.existingServiceId, STORAGE_RUNTIME_IDENTITY.existingInitializerId].includes(containerId)) fail('storage-volume-container-id');
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'cp', `${containerId}:/mnt`, '-'], {
    encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail('storage-volume-archive-read');
  return parseStorageMountArchive(result.stdout);
}

function currentListenerRows() {
  const output = spawnSync('ss', ['-ltnH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (output.error || output.status !== 0) fail('listener-inventory');
  return parseListeningSockets(output.stdout);
}

function unexpectedListeners(listeners) {
  return listeners.filter(({ host, port }) => {
    if ([5000, 5001].includes(port)) return true;
    if (![databasePort, apiPort].includes(port)) return false;
    return host !== '127.0.0.1';
  });
}

function safeNetworkInfo() {
  const network = JSON.parse(dockerCapture([
    'network', 'inspect', STORAGE_RUNTIME_IDENTITY.networkId,
    '--format', '{{json .}}',
  ]));
  return {
    id: network.Id,
    name: network.Name,
    driver: network.Driver,
    hostBindingIPv4: network.Options?.['com.docker.network.bridge.host_binding_ipv4'],
    labels: network.Labels ?? {},
    attachedIds: Object.keys(network.Containers ?? {}).sort(),
  };
}

export async function readInitialProtectedInventory() {
  let protectedContainers;
  let protectedVolumes;
  try {
    const original = JSON.parse(await readFile(join(taskDir, 'task3-precontainer-inventory.json'), 'utf8'));
    const volumes = JSON.parse(await readFile('/tmp/jt-studio-protected-docker-20261011.json', 'utf8'));
    protectedContainers = original.containers.map((entry) => entry.id);
    protectedVolumes = volumes.protectedVolumes.map((entry) => entry.Name);
  } catch { fail('protected-inventory-source'); }

  const containers = safeContainerRows();
  const volumes = safeVolumeRows();
  const taskNames = [
    'supabase_db_jt-studio-blog-tests', 'supabase_rest_jt-studio-blog-tests',
    'supabase_auth_jt-studio-blog-tests', 'supabase_kong_jt-studio-blog-tests',
  ];
  const taskRows = containers.filter((row) => taskNames.includes(row.Names?.replace(/^\//, '')));
  const byTaskName = new Map(taskRows.map((row) => [row.Names.replace(/^\//, ''), row]));
  const expectedIds = [
    databaseId,
    'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603',
    '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b',
    '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4',
  ];
  const observedIds = taskRows.map((row) => row.ID);
  const network = safeNetworkInfo();
  const listeners = unexpectedListeners(currentListenerRows());
  const storageVolumeExists = volumes.some((row) => row.Name === STORAGE_RUNTIME_IDENTITY.volumeName);
  const storageServiceExists = containers.some((row) => row.Names?.replace(/^\//, '') === STORAGE_RUNTIME_IDENTITY.serviceName);
  const storageInitializerExists = containers.some((row) => row.Names?.replace(/^\//, '') === STORAGE_RUNTIME_IDENTITY.initializerName);
  const input = {
    expectedProtectedContainerIds: protectedContainers,
    expectedProtectedVolumeNames: protectedVolumes,
    observedContainerIds: containers.map((row) => row.ID),
    observedVolumeNames: volumes.map((row) => row.Name),
    observedTaskContainerIds: observedIds,
    network,
    unexpectedListeners: listeners,
    storageVolumeExists,
    storageServiceExists,
    storageInitializerExists,
  };
  validateStorageInitialPreflight(input);
  for (const [index, name] of taskNames.entries()) {
    const row = byTaskName.get(name);
    if (!row || row.ID !== expectedIds[index]) fail('task-container-identity');
    if (parseLabels(row.Labels)['com.supabase.cli.project'] !== projectId) fail('task-container-labels');
  }
  if (!network.attachedIds.every((id) => expectedIds.includes(id)) || network.attachedIds.length !== 4) fail('task-network-attachments');
  const rowByName = new Map(taskRows.map((row) => [row.Names.replace(/^\//, ''), row]));
  for (const [name, containerPort, hostPort] of [
    ['supabase_db_jt-studio-blog-tests', '5432/tcp', databasePort],
    ['supabase_kong_jt-studio-blog-tests', '8000/tcp', apiPort],
  ]) {
    const row = rowByName.get(name);
    let bindings;
    try { bindings = JSON.parse(dockerCapture(['inspect', row.ID, '--format', '{{json .HostConfig.PortBindings}}'])); }
    catch { fail('task-port-inspect'); }
    const entries = Object.entries(bindings ?? {}).flatMap(([port, values]) => (values ?? []).map((value) => ({ port, ...value })));
    if (entries.length !== 1 || entries[0].port !== containerPort
        || entries[0].HostIp !== '127.0.0.1' || entries[0].HostPort !== String(hostPort)) fail('loopback-port-binding');
  }
  for (const name of ['supabase_rest_jt-studio-blog-tests', 'supabase_auth_jt-studio-blog-tests']) {
    const row = rowByName.get(name);
    let bindings;
    try { bindings = JSON.parse(dockerCapture(['inspect', row.ID, '--format', '{{json .HostConfig.PortBindings}}'])); }
    catch { fail('task-port-inspect'); }
    if (Object.values(bindings ?? {}).some((rows) => rows?.length)) fail('unexpected-task-port-binding');
  }
  return { protectedContainers, protectedVolumes, taskIds: expectedIds, taskRows, network };
}

async function readResumeProtectedInventory(state, { serviceRunning = false } = {}) {
  let protectedContainers;
  let protectedVolumes;
  try {
    const original = JSON.parse(await readFile(join(taskDir, 'task3-precontainer-inventory.json'), 'utf8'));
    const volumes = JSON.parse(await readFile('/tmp/jt-studio-protected-docker-20261011.json', 'utf8'));
    protectedContainers = original.containers.map((entry) => entry.id);
    protectedVolumes = volumes.protectedVolumes.map((entry) => entry.Name);
  } catch { fail('protected-inventory-source'); }

  const containers = safeContainerRows();
  const volumes = safeVolumeRows();
  const storageRows = containers.filter((row) => [STORAGE_RUNTIME_IDENTITY.serviceName, STORAGE_RUNTIME_IDENTITY.initializerName]
    .includes(row.Names?.replace(/^\//, '')));
  const serviceRow = storageRows.find((row) => row.Names?.replace(/^\//, '') === STORAGE_RUNTIME_IDENTITY.serviceName);
  const initializerRow = storageRows.find((row) => row.Names?.replace(/^\//, '') === STORAGE_RUNTIME_IDENTITY.initializerName);
  let initializerState;
  let serviceState;
  try {
    initializerState = JSON.parse(dockerCapture(['inspect', STORAGE_RUNTIME_IDENTITY.existingInitializerId, '--format', '{{json .State}}']));
    serviceState = JSON.parse(dockerCapture(['inspect', STORAGE_RUNTIME_IDENTITY.existingServiceId, '--format', '{{json .State}}']));
  } catch { fail('resume-state-inspect'); }
  const ownIds = {
    initializerId: initializerRow?.ID,
    serviceId: serviceRow?.ID,
    initializerName: STORAGE_RUNTIME_IDENTITY.initializerName,
    serviceName: STORAGE_RUNTIME_IDENTITY.serviceName,
    volumeName: STORAGE_RUNTIME_IDENTITY.volumeName,
    initializerStatus: initializerState?.Status,
    initializerExitCode: initializerState?.ExitCode,
    initializerOOMKilled: initializerState?.OOMKilled,
    serviceStatus: serviceState?.Status,
    serviceExitCode: serviceState?.ExitCode,
    serviceOOMKilled: serviceState?.OOMKilled,
    serviceHealthy: serviceState?.Health?.Status === 'healthy',
  };
  const taskNames = [
    'supabase_db_jt-studio-blog-tests', 'supabase_rest_jt-studio-blog-tests',
    'supabase_auth_jt-studio-blog-tests', 'supabase_kong_jt-studio-blog-tests',
  ];
  const taskRows = containers.filter((row) => taskNames.includes(row.Names?.replace(/^\//, '')));
  const taskIds = [
    'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966',
    'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603',
    '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b',
    '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4',
  ];
  const network = safeNetworkInfo();
  const volume = JSON.parse(dockerCapture(['volume', 'inspect', STORAGE_RUNTIME_IDENTITY.volumeName, '--format', '{{json .}}']));
  ownIds.serviceVolumeNoCopy = undefined;
  ownIds.initializerVolumeNoCopy = undefined;
  validateStorageResumePreflight({
    expectedProtectedContainerIds: protectedContainers,
    expectedProtectedVolumeNames: protectedVolumes,
    observedContainerIds: containers.map((row) => row.ID),
    observedVolumeNames: volumes.map((row) => row.Name),
    observedTaskContainerIds: taskRows.map((row) => row.ID),
    storage: ownIds,
    expectServiceRunning: serviceRunning,
    network,
    unexpectedListeners: unexpectedListeners(currentListenerRows()),
    volume: { name: volume?.Name, driver: volume?.Driver, labels: volume?.Labels },
  });
  if (state?.imageRef !== imageRef || state?.imageDigest !== imageDigest
      || state?.volumeName !== STORAGE_RUNTIME_IDENTITY.volumeName
      || state?.serviceName !== STORAGE_RUNTIME_IDENTITY.serviceName
      || state?.initializerName !== STORAGE_RUNTIME_IDENTITY.initializerName
      || state?.serviceId !== ownIds.serviceId || state?.initializerId !== ownIds.initializerId
      || state?.createdFromInventory !== true
      || !Array.isArray(state.taskContainersChecked) || state.taskContainersChecked.length !== taskIds.length
      || state.taskContainersChecked.some((id, index) => id !== taskIds[index])) fail('resume-state-identity');

  const byTaskName = new Map(taskRows.map((row) => [row.Names.replace(/^\//, ''), row]));
  for (const [index, name] of taskNames.entries()) {
    const row = byTaskName.get(name);
    if (!row || row.ID !== taskIds[index] || parseLabels(row.Labels)['com.supabase.cli.project'] !== projectId) fail('task-container-identity');
  }
  const expectedNetworkIds = serviceRunning ? [...taskIds, ownIds.serviceId] : taskIds;
  if (!Array.isArray(network.attachedIds) || new Set(network.attachedIds).size !== expectedNetworkIds.length
      || expectedNetworkIds.some((id) => !network.attachedIds.includes(id))) fail('resume-network-attachments');
  const rowByName = new Map(taskRows.map((row) => [row.Names.replace(/^\//, ''), row]));
  for (const [name, containerPort, hostPort] of [
    ['supabase_db_jt-studio-blog-tests', '5432/tcp', databasePort],
    ['supabase_kong_jt-studio-blog-tests', '8000/tcp', apiPort],
  ]) {
    const row = rowByName.get(name);
    let bindings;
    try { bindings = JSON.parse(dockerCapture(['inspect', row.ID, '--format', '{{json .HostConfig.PortBindings}}'])); }
    catch { fail('task-port-inspect'); }
    const entries = Object.entries(bindings ?? {}).flatMap(([port, values]) => (values ?? []).map((value) => ({ port, ...value })));
    if (entries.length !== 1 || entries[0].port !== containerPort || entries[0].HostIp !== '127.0.0.1'
        || entries[0].HostPort !== String(hostPort)) fail('loopback-port-binding');
  }
  for (const name of ['supabase_rest_jt-studio-blog-tests', 'supabase_auth_jt-studio-blog-tests']) {
    const row = rowByName.get(name);
    let bindings;
    try { bindings = JSON.parse(dockerCapture(['inspect', row.ID, '--format', '{{json .HostConfig.PortBindings}}'])); }
    catch { fail('task-port-inspect'); }
    if (Object.values(bindings ?? {}).some((rows) => rows?.length)) fail('unexpected-task-port-binding');
  }
  return { taskIds, taskRows, protectedContainers, protectedVolumes, network, serviceId: ownIds.serviceId, initializerId: ownIds.initializerId };
}

function assertFreeCapacity() {
  const output = dockerCapture(['exec', databaseId, 'df', '-Pk', '/var/lib/postgresql/data']);
  return validateStorageCapacityKiB(parseDataVolumeAvailableKiB(output));
}

export function validatePinnedImageInspection(output) {
  let image;
  try { image = JSON.parse(output); } catch { fail('image-inspect-json'); }
  const config = image?.Config;
  if (!image || typeof image !== 'object' || Array.isArray(image)
      || !config || typeof config !== 'object' || Array.isArray(config)) fail('image-inspect-json');
  const configuredUser = config.User;
  if (configuredUser !== undefined && configuredUser !== '') fail('image-identity');
  if (!Array.isArray(config.Env) || config.Env.some((entry) => typeof entry !== 'string' || /[\0\r\n]/.test(entry))) fail('image-identity');
  const repoDigests = image.RepoDigests;
  const entrypoint = config.Entrypoint;
  const command = config.Cmd;
  if (typeof image.Id !== 'string' || !image.Id
      || image.Os !== 'linux' || image.Architecture !== 'amd64'
      || !Array.isArray(repoDigests) || !repoDigests.some((entry) => typeof entry === 'string' && entry.endsWith(`@${imageDigest}`))
      || JSON.stringify(entrypoint) !== '["docker-entrypoint.sh"]'
      || JSON.stringify(command) !== '["node","dist/start/server.js"]') fail('image-identity');
  return { imageId: image.Id, repoDigests, platform: `${image.Os}/${image.Architecture}`, configuredUser: '', defaultEnv: config.Env };
}

function inspectImage() {
  const result = dockerCapture(['image', 'inspect', imageRef, '--format', '{{json .}}']);
  return validatePinnedImageInspection(result);
}

function requestDockerApi(socketPath, method, path, body) {
  return new Promise((resolveResponse, rejectResponse) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = requestHttp({
      socketPath,
      path: `/${apiVersion}${path}`,
      method,
      headers: bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': bytes.length },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy();
          rejectResponse(new Error('docker-response-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
        const status = res.statusCode ?? 599;
        if (status < 200 || status >= 300) rejectResponse(new Error('docker-api-request-failed'));
        else resolveResponse({ status, payload });
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker-api-timeout')));
    req.on('error', () => rejectResponse(new Error('docker-api-transport')));
    if (bytes) req.end(bytes);
    else req.end();
  });
}

async function readLocalStatus(cliPath, projectConfig, socketPath) {
  const environment = createSupabaseCliEnvironment(process.env, socketPath);
  const cli = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env: environment });
  if (cli.status !== 0 || cli.stdout.trim() !== '2.120.0') fail('supabase-cli-version');
  const result = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env: environment });
  if (result.status !== 0) fail('supabase-local-status');
  let status;
  try { status = JSON.parse(result.stdout); } catch { fail('supabase-local-status-json'); }
  validateLocalDatabaseTarget(status, projectId, databasePort);
  const apiUrl = new URL(status.API_URL);
  if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== '127.0.0.1' || Number(apiUrl.port) !== apiPort
      || typeof status.ANON_KEY !== 'string' || !status.ANON_KEY
      || typeof status.SERVICE_ROLE_KEY !== 'string' || !status.SERVICE_ROLE_KEY
      || typeof status.JWT_SECRET !== 'string' || !status.JWT_SECRET) fail('supabase-local-api-target');
  if (projectConfig.projectId !== projectId || projectConfig.databasePort !== databasePort || projectConfig.apiPort !== apiPort) fail('supabase-project-config');
  return { status, apiUrl };
}

async function readJwks(apiUrl, jwtSecret) {
  const response = await fetch(new URL('/auth/v1/.well-known/jwks.json', apiUrl), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) fail('auth-jwks-status');
  let payload;
  try { payload = await response.json(); } catch { fail('auth-jwks-json'); }
  if (!Array.isArray(payload?.keys) || payload.keys.length === 0
      || payload.keys.some((key) => key.kty !== 'EC' && key.kty !== 'RSA')) fail('auth-jwks-keys');
  return JSON.stringify({ keys: [...payload.keys, { kty: 'oct', k: Buffer.from(jwtSecret, 'utf8').toString('base64url') }] });
}

function storageEnv(status, apiUrl, jwks) {
  const db = new URL(status.DB_URL);
  db.username = 'supabase_storage_admin';
  db.hostname = 'supabase_db_jt-studio-blog-tests';
  db.port = '5432';
  const taskAccess = 'jt-studio-task5-storage-disabled-s3-access';
  const taskSecret = 'jt-studio-task5-storage-disabled-s3-secret';
  return {
    DB_MIGRATIONS_FREEZE_AT: '',
    ANON_KEY: status.ANON_KEY,
    SERVICE_KEY: status.SERVICE_ROLE_KEY,
    AUTH_JWT_SECRET: status.JWT_SECRET,
    JWT_JWKS: jwks,
    DATABASE_URL: db.toString(),
    FILE_SIZE_LIMIT: String(status.storageFileSizeLimit),
    STORAGE_BACKEND: 'file',
    FILE_STORAGE_BACKEND_PATH: '/mnt',
    TENANT_ID: 'stub',
    STORAGE_S3_REGION: 'local',
    GLOBAL_S3_BUCKET: 'stub',
    ENABLE_IMAGE_TRANSFORMATION: 'false',
    IMAGE_TRANSFORMATION_ENABLED: 'false',
    TUS_URL_PATH: '/storage/v1/upload/resumable',
    S3_PROTOCOL_ENABLED: 'false',
    S3_PROTOCOL_ACCESS_KEY_ID: taskAccess,
    S3_PROTOCOL_ACCESS_KEY_SECRET: taskSecret,
    S3_PROTOCOL_PREFIX: '/storage/v1',
    UPLOAD_FILE_SIZE_LIMIT: '1048576',
    UPLOAD_FILE_SIZE_LIMIT_STANDARD: '1048576',
    VECTOR_ENABLED: 'false',
    TMPDIR: '/tmp',
  };
}

function parseCreatedId(result, stage) {
  const id = result.payload?.Id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) fail(stage);
  return id;
}

function dockerInspectPath(id) { return `/containers/${id}/json`; }

export function storageProcessQueryPath(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) fail('storage-process-container-id');
  const query = new URLSearchParams({ ps_args: '-eo pid,uid,gid,args' });
  return `/containers/${id}/top?${query}`;
}

export function parseStorageProcessTop(payload) {
  const titles = payload?.Titles;
  const rows = payload?.Processes;
  if (!Array.isArray(titles) || !Array.isArray(rows) || titles.some((title) => typeof title !== 'string')) fail('storage-process-inspect');
  const pidColumns = titles.flatMap((title, index) => title === 'PID' ? [index] : []);
  const uidColumns = titles.flatMap((title, index) => title === 'UID' ? [index] : []);
  const gidColumns = titles.flatMap((title, index) => title === 'GID' ? [index] : []);
  const commandColumns = titles.flatMap((title, index) => title === 'COMMAND' || title === 'CMD' ? [index] : []);
  if (pidColumns.length !== 1 || uidColumns.length !== 1 || gidColumns.length !== 1 || commandColumns.length !== 1) fail('storage-process-inspect');
  const [pidIndex] = pidColumns;
  const [uidIndex] = uidColumns;
  const [gidIndex] = gidColumns;
  const [commandIndex] = commandColumns;
  const serverRows = rows.filter((row) => Array.isArray(row) && row.length === titles.length
    && typeof row[commandIndex] === 'string' && /node.*dist\/start\/server\.js/.test(row[commandIndex]));
  if (serverRows.length !== 1) fail('storage-process-inspect');
  const [pid, uid, gid] = [serverRows[0][pidIndex], serverRows[0][uidIndex], serverRows[0][gidIndex]];
  if (![pid, uid, gid].every((value) => typeof value === 'string' && /^\d+$/.test(value))) fail('storage-process-inspect');
  const processUid = Number(uid);
  const processGid = Number(gid);
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1 || !Number.isSafeInteger(processUid) || processUid !== 1000
      || !Number.isSafeInteger(processGid) || processGid !== 1000) fail('storage-process-inspect');
  return { processUid, processGid };
}

async function inspectContainer(socketPath, id) {
  const result = await requestDockerApi(socketPath, 'GET', dockerInspectPath(id));
  if (result.payload?.Id !== id) fail('container-id-inspect');
  return result.payload;
}

function resumeInspectionProjection(inspect, imageId, kind) {
  const service = kind === 'service';
  const id = service ? STORAGE_RUNTIME_IDENTITY.existingServiceId : STORAGE_RUNTIME_IDENTITY.existingInitializerId;
  const name = service ? STORAGE_RUNTIME_IDENTITY.serviceName : STORAGE_RUNTIME_IDENTITY.initializerName;
  const mounts = inspect.Mounts ?? [];
  const network = inspect.NetworkSettings?.Networks?.[STORAGE_RUNTIME_IDENTITY.networkName];
  const commandMatches = service
    ? JSON.stringify(inspect.Config?.Entrypoint) === '["docker-entrypoint.sh"]'
      && JSON.stringify(inspect.Config?.Cmd) === JSON.stringify(['node', 'dist/start/server.js'])
    : JSON.stringify(inspect.Config?.Entrypoint) === '["node"]'
      && JSON.stringify(inspect.Config?.Cmd) === JSON.stringify(['-e', buildStorageInitializerSpec({ ...STORAGE_RUNTIME_IDENTITY, env: {} }).security.command[2]]);
  return {
    id: inspect.Id,
    name: inspect.Name?.replace(/^\//, ''),
    imageRef: inspect.Config?.Image,
    imageId: inspect.Image,
    user: inspect.Config?.User,
    labels: inspect.Config?.Labels ?? {},
    status: inspect.State?.Status,
    healthy: inspect.State?.Health?.Status === 'healthy',
    exitCode: inspect.State?.ExitCode,
    oomKilled: inspect.State?.OOMKilled,
    networkId: service ? inspect.HostConfig?.NetworkMode : undefined,
    networkMode: service ? undefined : inspect.HostConfig?.NetworkMode,
    networkNames: Object.keys(inspect.NetworkSettings?.Networks ?? {}).sort(),
    networkAlias: service && network?.NetworkID === STORAGE_RUNTIME_IDENTITY.networkId
      && network.Aliases?.includes('storage') === true,
    publishedPorts: Object.values(inspect.HostConfig?.PortBindings ?? {}).reduce((sum, rows) => sum + (rows?.length ?? 0), 0),
    nanoCpus: inspect.HostConfig?.NanoCpus,
    memoryBytes: inspect.HostConfig?.Memory,
    memorySwapBytes: inspect.HostConfig?.MemorySwap,
    pidsLimit: inspect.HostConfig?.PidsLimit,
    capDrop: inspect.HostConfig?.CapDrop,
    capAdd: inspect.HostConfig?.CapAdd,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name,
    noNewPrivileges: (inspect.HostConfig?.SecurityOpt ?? []).includes('no-new-privileges:true'),
    readOnlyRootfs: inspect.HostConfig?.ReadonlyRootfs,
    mounts: mounts.map((mount) => ({
      type: mount.Type,
      name: mount.Name,
      destination: mount.Destination,
      rw: mount.RW,
      noCopy: inspect.HostConfig?.Mounts?.find((entry) => entry.Target === mount.Destination)?.VolumeOptions?.NoCopy,
    })),
    commandMatches: inspect.Id === id && inspect.Name === `/${name}` && commandMatches,
    tmpfsMatches: service && JSON.stringify(inspect.HostConfig?.Tmpfs) === JSON.stringify({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000' }),
    environment: inspect.Config?.Env,
  };
}

async function startContainer(socketPath, id) {
  await requestDockerApi(socketPath, 'POST', `/containers/${id}/start`);
}

async function waitContainer(socketPath, id) {
  const result = await requestDockerApi(socketPath, 'POST', `/containers/${id}/wait?condition=not-running`);
  const code = result.payload?.StatusCode;
  if (!Number.isInteger(code)) fail('container-exit-status');
  return code;
}

function verifyInitializer(inspect, id) {
  const labels = inspect.Config?.Labels ?? {};
  const mounts = inspect.Mounts ?? [];
  if (inspect.Id !== id || inspect.Name !== `/${STORAGE_RUNTIME_IDENTITY.initializerName}`
      || inspect.Config?.Image !== imageRef || inspect.Config?.User !== '0:0'
      || labels['org.jt-studio.project'] !== projectId || labels['org.jt-studio.task'] !== 'blog-editorial-task5'
      || inspect.State?.Status !== 'exited' || inspect.State?.ExitCode !== 0 || inspect.State?.OOMKilled
      || inspect.HostConfig?.NetworkMode !== 'none'
      || Object.values(inspect.HostConfig?.PortBindings ?? {}).some((rows) => rows?.length)
      || JSON.stringify(inspect.HostConfig?.CapDrop ?? []) !== '["ALL"]'
      || JSON.stringify(inspect.HostConfig?.CapAdd ?? []) !== '["CHOWN"]'
      || !(inspect.HostConfig?.SecurityOpt ?? []).includes('no-new-privileges:true')
      || inspect.HostConfig?.ReadonlyRootfs !== true
      || inspect.HostConfig?.NanoCpus !== 1_000_000_000
      || inspect.HostConfig?.Memory !== 128 * 1024 * 1024
      || inspect.HostConfig?.MemorySwap !== 128 * 1024 * 1024
      || inspect.HostConfig?.PidsLimit !== 16
      || mounts.length !== 1 || mounts[0].Name !== STORAGE_RUNTIME_IDENTITY.volumeName
      || mounts[0].Destination !== '/mnt' || mounts[0].RW !== true
      || JSON.stringify(inspect.Config?.Entrypoint) !== '["node"]'
      || JSON.stringify(inspect.Config?.Cmd) !== JSON.stringify(['-e', buildStorageInitializerSpec({ ...STORAGE_RUNTIME_IDENTITY, env: {} }).security.command[2]])) fail('initializer-inspection');
}

async function verifyService(socketPath, id, networkId, { allowKnownLegacyNoCopy = false } = {}) {
  const inspect = await inspectContainer(socketPath, id);
  const process = await requestDockerApi(socketPath, 'GET', storageProcessQueryPath(id));
  const { processUid, processGid } = parseStorageProcessTop(process.payload);
  const networkEntry = inspect.NetworkSettings?.Networks?.[STORAGE_RUNTIME_IDENTITY.networkName];
  const networkNames = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  const publishedPorts = Object.values(inspect.HostConfig?.PortBindings ?? {}).flatMap((rows) => rows ?? []);
  const mounts = inspect.Mounts ?? [];
  if (mounts.length !== 1 || mounts[0].Type !== 'volume') fail('storage-mounts');
  validateStorageServiceInspection({
    configUser: inspect.Config?.User,
    processUid,
    processGid,
    publishedPorts,
    networkId: networkEntry?.NetworkID,
    networkAlias: networkEntry?.Aliases?.includes('storage'),
    volumeName: mounts[0].Name,
    volumeNoCopy: inspect.HostConfig?.Mounts?.[0]?.VolumeOptions?.NoCopy,
    nanoCpus: inspect.HostConfig?.NanoCpus,
    memoryBytes: inspect.HostConfig?.Memory,
    memorySwapBytes: inspect.HostConfig?.MemorySwap,
    pidsLimit: inspect.HostConfig?.PidsLimit,
    capDrop: inspect.HostConfig?.CapDrop,
    noNewPrivileges: (inspect.HostConfig?.SecurityOpt ?? []).includes('no-new-privileges:true'),
    readOnlyRootfs: inspect.HostConfig?.ReadonlyRootfs,
  }, { allowKnownLegacyNoCopy, containerId: id });
  if (inspect.Config?.Image !== imageRef || networkNames.length !== 1
      || networkNames[0] !== STORAGE_RUNTIME_IDENTITY.networkName || !networkEntry || networkEntry.NetworkID !== networkId
      || !networkEntry.Aliases?.includes('storage') || mounts[0].Destination !== '/mnt'
      || mounts[0].RW !== true || inspect.State?.Status !== 'running'
      || inspect.State?.Health?.Status !== 'healthy') fail('storage-health');
}

function dockerLabels() {
  return { 'org.jt-studio.project': projectId, 'org.jt-studio.task': 'blog-editorial-task5' };
}

async function waitHealthy(socketPath, id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const inspect = await inspectContainer(socketPath, id);
    if (inspect.State?.Status === 'exited' || inspect.State?.Status === 'dead') fail('storage-exited-before-health');
    if (inspect.State?.Health?.Status === 'healthy') return;
    if (inspect.State?.Health?.Status === 'unhealthy') fail('storage-unhealthy');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  fail('storage-health-timeout');
}

function dockerVolumeCreateBody() {
  return {
    Name: STORAGE_RUNTIME_IDENTITY.volumeName,
    Driver: 'local',
    Labels: dockerLabels(),
  };
}

async function run() {
  if (process.argv[2] === 'resume') return resumeExistingStorage();
  if (process.argv[2] === 'resume-preflight') return resumeExistingStorage({ preflightOnly: true });
  if (process.argv[2] === 'verify-existing') return verifyExistingStorage();
  if (process.argv[2] !== 'start') fail('usage');
  const [configText, taskInventory] = await Promise.all([
    readFile(join(root, 'supabase/config.toml'), 'utf8'),
    readInitialProtectedInventory(),
  ]);
  const projectConfig = parseTaskProjectConfig(configText);
  const configuredFileSizeLimit = parseStorageFileSizeLimit(configText);
  if (projectConfig.projectId !== projectId || projectConfig.databasePort !== databasePort || projectConfig.apiPort !== apiPort) fail('project-config');
  const availableKiB = assertFreeCapacity();
  const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
  try { await stat(statePath); fail('task-storage-state-already-exists; verify existing task resources manually'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { fail('task-storage-runner-lock-exists; verify runtime state manually'); }

  const baseSocket = dockerSocketPath();
  const statusProxy = createDockerLoopbackProxy({
    upstreamSocketPath: baseSocket,
    allowedNames: new Set([STORAGE_RUNTIME_IDENTITY.serviceName, STORAGE_RUNTIME_IDENTITY.initializerName]),
  });
  let statusData;
  try {
    const proxyPath = await statusProxy.listen();
    statusData = await readLocalStatus(cliPath, projectConfig, proxyPath);
  } finally { await statusProxy.close(); }
  statusData.status.storageFileSizeLimit = configuredFileSizeLimit;
  const jwks = await readJwks(statusData.apiUrl, statusData.status.JWT_SECRET);
  const env = storageEnv(statusData.status, statusData.apiUrl, jwks);
  const serviceSpec = buildStorageServiceSpec({ ...STORAGE_RUNTIME_IDENTITY, env });
  const initializerSpec = buildStorageInitializerSpec({ ...STORAGE_RUNTIME_IDENTITY, env: {} });
  const pulled = spawnSync('docker', ['--context', 'desktop-linux', 'pull', '--platform', 'linux/amd64', imageRef], {
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 300_000,
  });
  if (pulled.error || pulled.status !== 0) fail('pinned-image-pull');
  const pulledImage = inspectImage();
  if (pulledImage.platform !== 'linux/amd64' || pulledImage.configuredUser !== '') fail('image-runtime-identity');

  const preflightAgain = await readInitialProtectedInventory();
  if (preflightAgain.network.id !== taskInventory.network.id
      || preflightAgain.taskIds.join(',') !== taskInventory.taskIds.join(',')
      || assertFreeCapacity() < 2 * 1024 * 1024) fail('post-pull-preflight');
  assertStorageVolumeAbsent({ exists: false, name: STORAGE_RUNTIME_IDENTITY.volumeName });

  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: baseSocket,
    allowedNames: new Set([STORAGE_RUNTIME_IDENTITY.serviceName, STORAGE_RUNTIME_IDENTITY.initializerName]),
    allowCreatedContainerStarts: true,
    createRequestGuard: (name, document) => validateStorageContainerCreateRequest(name, document, env),
    volumeCreateGuard: validateStorageVolumeCreateRequest,
  });
  const proxyPath = await proxy.listen();
  let state = {
    imageRef,
    imageDigest,
    volumeName: STORAGE_RUNTIME_IDENTITY.volumeName,
    serviceName: STORAGE_RUNTIME_IDENTITY.serviceName,
    initializerName: STORAGE_RUNTIME_IDENTITY.initializerName,
    createdFromInventory: true,
    protectedContainersChecked: taskInventory.protectedContainers.length,
    taskContainersChecked: taskInventory.taskIds,
    availableKiBBeforePull: availableKiB,
    initializerId: null,
    serviceId: null,
  };
  const persist = async () => {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    const volumeResult = await requestDockerApi(proxyPath, 'POST', '/volumes/create', dockerVolumeCreateBody());
    const volume = volumeResult.payload?.Name === STORAGE_RUNTIME_IDENTITY.volumeName
      ? volumeResult.payload : (await requestDockerApi(proxyPath, 'GET', `/volumes/${STORAGE_RUNTIME_IDENTITY.volumeName}`)).payload;
    validateStorageVolume({ name: volume?.Name, driver: volume?.Driver, labels: volume?.Labels });
    state.volumeCreatedAt = volume.CreatedAt;
    state.volumeLabels = volume.Labels;
    await persist();

    const initializerBody = buildStorageContainerCreateBody(STORAGE_RUNTIME_IDENTITY.initializerName, initializerSpec);
    const initializerCreated = await requestDockerApi(proxyPath, 'POST', `/containers/create?name=${STORAGE_RUNTIME_IDENTITY.initializerName}`, initializerBody);
    state.initializerId = parseCreatedId(initializerCreated, 'initializer-create-id');
    await persist();
    await startContainer(proxyPath, state.initializerId);
    if (await waitContainer(proxyPath, state.initializerId) !== 0) fail('initializer-exit');
    const initializerInspect = await inspectContainer(proxyPath, state.initializerId);
    verifyInitializer(initializerInspect, state.initializerId);
    await persist();

    const serviceBody = buildStorageContainerCreateBody(STORAGE_RUNTIME_IDENTITY.serviceName, serviceSpec);
    const serviceCreated = await requestDockerApi(proxyPath, 'POST', `/containers/create?name=${STORAGE_RUNTIME_IDENTITY.serviceName}`, serviceBody);
    state.serviceId = parseCreatedId(serviceCreated, 'storage-create-id');
    await persist();
    await startContainer(proxyPath, state.serviceId);
    await waitHealthy(proxyPath, state.serviceId);
    await verifyService(proxyPath, state.serviceId, STORAGE_RUNTIME_IDENTITY.networkId);
    state.availableKiBAfterStart = assertFreeCapacity();
    await persist();
    process.stdout.write(`Task 5 Storage runtime created and verified; protected IDs unchanged; local evidence=${statePath}\n`);
  } finally { await proxy.close(); await lock.close(); }
}

async function verifyExistingStorage() {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    const [lock, stateFile, resumeLock] = await Promise.all([stat(lockPath), stat(statePath), stat(resumeLockPath)]);
    if (!lock.isFile() || lock.size !== 0 || (lock.mode & 0o777) !== 0o600 || lock.uid !== 1000 || lock.gid !== 1000
        || !stateFile.isFile() || (stateFile.mode & 0o777) !== 0o600 || stateFile.uid !== 1000 || stateFile.gid !== 1000
        || !resumeLock.isFile() || resumeLock.size !== 0 || (resumeLock.mode & 0o777) !== 0o600
        || resumeLock.uid !== 1000 || resumeLock.gid !== 1000) fail('verify-existing-state-lock');
  } catch (error) {
    if (error?.stage) throw error;
    fail('verify-existing-state-lock');
  }
  const baseSocket = dockerSocketPath();
  await readResumeProtectedInventory(state, { serviceRunning: true });
  assertFreeCapacity();
  const configText = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  const projectConfig = parseTaskProjectConfig(configText);
  const configuredFileSizeLimit = parseStorageFileSizeLimit(configText);
  if (projectConfig.projectId !== projectId || projectConfig.databasePort !== databasePort || projectConfig.apiPort !== apiPort) fail('project-config');
  const image = inspectImage();
  if (image.platform !== 'linux/amd64' || image.configuredUser !== '') fail('image-runtime-identity');
  const statusProxy = createDockerLoopbackProxy({
    upstreamSocketPath: baseSocket,
    allowedNames: new Set([STORAGE_RUNTIME_IDENTITY.serviceName, STORAGE_RUNTIME_IDENTITY.initializerName]),
  });
  let statusData;
  try {
    const statusProxyPath = await statusProxy.listen();
    statusData = await readLocalStatus(join(root, 'node_modules/supabase/dist/supabase.js'), projectConfig, statusProxyPath);
  } finally { await statusProxy.close(); }
  statusData.status.storageFileSizeLimit = configuredFileSizeLimit;
  const jwks = await readJwks(statusData.apiUrl, statusData.status.JWT_SECRET);
  const expectedServiceEnv = storageEnv(statusData.status, statusData.apiUrl, jwks);
  const [serviceInspect, initializerInspect, volumeResponse] = await Promise.all([
    inspectContainer(baseSocket, STORAGE_RUNTIME_IDENTITY.existingServiceId),
    inspectContainer(baseSocket, STORAGE_RUNTIME_IDENTITY.existingInitializerId),
    requestDockerApi(baseSocket, 'GET', `/volumes/${STORAGE_RUNTIME_IDENTITY.volumeName}`),
  ]);
  validateStorageVolume({
    name: volumeResponse.payload?.Name,
    driver: volumeResponse.payload?.Driver,
    labels: volumeResponse.payload?.Labels,
  });
  if (serviceInspect.Image !== image.imageId || initializerInspect.Image !== image.imageId) fail('resume-image-id');
  const archive = rawStorageMountArchive(STORAGE_RUNTIME_IDENTITY.existingServiceId);
  const inspection = {
    imageId: image.imageId,
    imageDefaults: image.defaultEnv,
    expectedServiceEnv,
    service: resumeInspectionProjection(serviceInspect, image.imageId, 'service'),
    initializer: resumeInspectionProjection(initializerInspect, image.imageId, 'initializer'),
    archive,
  };
  validateStorageResumeContainerInspection(inspection, { serviceRunning: true });
  await verifyService(baseSocket, STORAGE_RUNTIME_IDENTITY.existingServiceId, STORAGE_RUNTIME_IDENTITY.networkId, {
    allowKnownLegacyNoCopy: true,
  });
  await readResumeProtectedInventory(state, { serviceRunning: true });
  process.stdout.write(`Task 5 Storage existing runtime verified read-only; no lifecycle action; local evidence=${statePath}\n`);
}

async function resumeExistingStorage({ preflightOnly = false } = {}) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    const [lock, stateFile] = await Promise.all([stat(lockPath), stat(statePath)]);
    if (!lock.isFile() || lock.size !== 0 || (lock.mode & 0o777) !== 0o600 || lock.uid !== 1000 || lock.gid !== 1000
        || !stateFile.isFile() || (stateFile.mode & 0o777) !== 0o600 || stateFile.uid !== 1000 || stateFile.gid !== 1000) fail('resume-task-lock');
  } catch (error) {
    if (error?.stage) throw error;
    fail('resume-state-or-lock');
  }
  const baseSocket = dockerSocketPath();
  await readResumeProtectedInventory(state);
  assertFreeCapacity();
  const configText = await readFile(join(root, 'supabase/config.toml'), 'utf8');
  const projectConfig = parseTaskProjectConfig(configText);
  const configuredFileSizeLimit = parseStorageFileSizeLimit(configText);
  if (projectConfig.projectId !== projectId || projectConfig.databasePort !== databasePort || projectConfig.apiPort !== apiPort) fail('project-config');
  const image = inspectImage();
  if (image.platform !== 'linux/amd64' || image.configuredUser !== '') fail('image-runtime-identity');
  const statusProxy = createDockerLoopbackProxy({
    upstreamSocketPath: baseSocket,
    allowedNames: new Set([STORAGE_RUNTIME_IDENTITY.serviceName, STORAGE_RUNTIME_IDENTITY.initializerName]),
  });
  let statusData;
  try {
    const statusProxyPath = await statusProxy.listen();
    statusData = await readLocalStatus(join(root, 'node_modules/supabase/dist/supabase.js'), projectConfig, statusProxyPath);
  } finally { await statusProxy.close(); }
  statusData.status.storageFileSizeLimit = configuredFileSizeLimit;
  const jwks = await readJwks(statusData.apiUrl, statusData.status.JWT_SECRET);
  const expectedServiceEnv = storageEnv(statusData.status, statusData.apiUrl, jwks);
  const [serviceInspect, initializerInspect, volumeResponse] = await Promise.all([
    inspectContainer(baseSocket, STORAGE_RUNTIME_IDENTITY.existingServiceId),
    inspectContainer(baseSocket, STORAGE_RUNTIME_IDENTITY.existingInitializerId),
    requestDockerApi(baseSocket, 'GET', `/volumes/${STORAGE_RUNTIME_IDENTITY.volumeName}`),
  ]);
  validateStorageVolume({
    name: volumeResponse.payload?.Name,
    driver: volumeResponse.payload?.Driver,
    labels: volumeResponse.payload?.Labels,
  });
  if (serviceInspect.Image !== image.imageId || initializerInspect.Image !== image.imageId) fail('resume-image-id');
  const archive = rawStorageMountArchive(STORAGE_RUNTIME_IDENTITY.existingServiceId);
  const resumeInspection = {
    imageId: image.imageId,
    imageDefaults: image.defaultEnv,
    expectedServiceEnv,
    service: resumeInspectionProjection(serviceInspect, image.imageId, 'service'),
    initializer: resumeInspectionProjection(initializerInspect, image.imageId, 'initializer'),
    archive,
  };
  validateStorageResumeContainerInspection(resumeInspection);
  if (state.resumeCompleted === true) fail('resume-already-completed');
  if (preflightOnly) {
    process.stdout.write('Task 5 Storage read-only recovery preflight passed; no start performed.\n');
    return;
  }

  let resumeLock;
  try { resumeLock = await open(resumeLockPath, 'wx', 0o600); }
  catch { fail('resume-lock-exists-preserve-and-inspect'); }

  const exactIds = new Set([STORAGE_RUNTIME_IDENTITY.existingInitializerId, STORAGE_RUNTIME_IDENTITY.existingServiceId]);
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: baseSocket,
    allowedNames: new Set([STORAGE_RUNTIME_IDENTITY.initializerName, STORAGE_RUNTIME_IDENTITY.serviceName]),
    verifiedContainerIds: exactIds,
    resumableContainerIds: exactIds,
  });
  let proxyPath;
  try {
    proxyPath = await proxy.listen();
    await startVerifiedStorageContainer(resumeInspection, 'initializer', (id) => startContainer(proxyPath, id));
    if (await waitContainer(proxyPath, STORAGE_RUNTIME_IDENTITY.existingInitializerId) !== 0) fail('resume-initializer-exit');
    const initializerAfter = await inspectContainer(proxyPath, STORAGE_RUNTIME_IDENTITY.existingInitializerId);
    verifyInitializer(initializerAfter, STORAGE_RUNTIME_IDENTITY.existingInitializerId);
    const ownedEmptyArchive = rawStorageMountArchive(STORAGE_RUNTIME_IDENTITY.existingInitializerId);
    if (ownedEmptyArchive.rootName !== 'mnt/' || ownedEmptyArchive.entryCount !== 1
        || !ownedEmptyArchive.rootIsDirectory || ownedEmptyArchive.rootUid !== 1000
        || ownedEmptyArchive.rootGid !== 1000 || ownedEmptyArchive.rootMode !== 0o755) fail('resume-initialized-volume-verification');

    await readResumeProtectedInventory(state);
    assertFreeCapacity();
    const [serviceBeforeStart, initializerBeforeStart] = await Promise.all([
      inspectContainer(proxyPath, STORAGE_RUNTIME_IDENTITY.existingServiceId),
      inspectContainer(proxyPath, STORAGE_RUNTIME_IDENTITY.existingInitializerId),
    ]);
    const serviceStartInspection = {
      imageId: image.imageId,
      imageDefaults: image.defaultEnv,
      expectedServiceEnv,
      expectedArchiveOwner: 1000,
      service: resumeInspectionProjection(serviceBeforeStart, image.imageId, 'service'),
      initializer: resumeInspectionProjection(initializerBeforeStart, image.imageId, 'initializer'),
      archive: rawStorageMountArchive(STORAGE_RUNTIME_IDENTITY.existingInitializerId),
    };
    await startVerifiedStorageContainer(serviceStartInspection, 'service', (id) => startContainer(proxyPath, id));
    await waitHealthy(proxyPath, STORAGE_RUNTIME_IDENTITY.existingServiceId);
    await verifyService(proxyPath, STORAGE_RUNTIME_IDENTITY.existingServiceId, STORAGE_RUNTIME_IDENTITY.networkId, {
      allowKnownLegacyNoCopy: true,
    });
    await readResumeProtectedInventory(state, { serviceRunning: true });
    state.resumeCompleted = true;
    state.resumeCompletedAt = new Date().toISOString();
    state.legacyNoCopy = {
      initializer: 'absent-or-false on the original, exact initializer ID; start does not populate volumes',
      service: 'absent-or-false on the original, exact service ID; fresh creates still require NoCopy=true',
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Task 5 Storage existing containers resumed and verified; protected IDs unchanged; local evidence=${statePath}\n`);
  } finally {
    await proxy.close();
    await resumeLock.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch((error) => {
    const stage = safeStorageFailureStage(error);
    process.stderr.write(`Task 5 Storage runtime stopped at ${stage}. No cleanup was attempted.\n`);
    process.exitCode = 1;
  });
}
