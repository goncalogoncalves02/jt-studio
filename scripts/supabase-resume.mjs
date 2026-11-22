import { readFileSync } from 'node:fs';
import { STORAGE_RUNTIME_IDENTITY } from './supabase-storage-runtime.mjs';

export const TASK_RESUME_CONTAINERS = Object.freeze({
  db: Object.freeze({ id: 'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966', name: 'supabase_db_jt-studio-blog-tests', internalPort: 5432, hostPort: 54342, mounts: [['supabase_db_jt-studio-blog-tests', '/var/lib/postgresql/data']] }),
  rest: Object.freeze({ id: 'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603', name: 'supabase_rest_jt-studio-blog-tests', internalPort: null, hostPort: null, mounts: [] }),
  auth: Object.freeze({ id: '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b', name: 'supabase_auth_jt-studio-blog-tests', internalPort: null, hostPort: null, mounts: [] }),
  kong: Object.freeze({ id: '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4', name: 'supabase_kong_jt-studio-blog-tests', internalPort: 8000, hostPort: 54341, mounts: [] }),
});

export function assertProvisionable(projectContainers) {
  if (!Array.isArray(projectContainers)) throw new TypeError('Task project container inventory is invalid');
  if (projectContainers.length !== 0) throw new Error('Task project already has containers; provision is refused');
  return { allowed: true };
}

export function parseContainerInventoryRows(output) {
  if (typeof output !== 'string') throw new TypeError('Docker container inventory output is invalid');
  if (!output.trim()) return [];
  return output.trim().split(/\r?\n/).map((line) => {
    const [id, name, ...extra] = line.split('|');
    if (!/^[0-9a-f]{64}$/.test(id ?? '') || !name || extra.length > 0) {
      throw new TypeError('Docker container inventory must contain full IDs and names');
    }
    return { id, name };
  });
}

export function resolveProtectedContainerRows(protectedInventory, observedRows) {
  if (!Array.isArray(protectedInventory) || !Array.isArray(observedRows)) {
    throw new TypeError('Protected Docker container inventory is invalid');
  }
  const resolved = [];
  const usedIds = new Set();
  for (const protectedRow of protectedInventory) {
    const prefix = protectedRow?.ID;
    const expectedNames = String(protectedRow?.Names ?? '').split(',').map((name) => name.replace(/^\//, '').trim()).filter(Boolean);
    if (typeof prefix !== 'string' || !/^[0-9a-f]{12,64}$/.test(prefix) || expectedNames.length === 0) {
      throw new TypeError('Protected Docker inventory has an invalid identity');
    }
    const matches = observedRows.filter((row) => row.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error('Protected container ID prefix does not resolve uniquely');
    const match = matches[0];
    const actualNames = match.name.split(',').map((name) => name.replace(/^\//, '').trim());
    if (!expectedNames.some((name) => actualNames.includes(name))) {
      throw new Error('Protected container name does not match its inventory identity');
    }
    if (usedIds.has(match.id)) throw new Error('Protected container inventory resolves duplicate identities');
    usedIds.add(match.id);
    resolved.push(match);
  }
  return resolved;
}

export function readResumeInventory() {
  const original = JSON.parse(readFileSync('/tmp/jt-studio-protected-docker-20261011.json', 'utf8'));
  if (original.protectedContainers?.length !== 7 || original.protectedVolumes?.length !== 236) {
    throw new Error('Original protected inventory is invalid');
  }

  let reviewed;
  try {
    reviewed = JSON.parse(readFileSync('/tmp/jt-studio-protected-docker-resume.json', 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return original;
    throw error;
  }
  const containers = reviewed.protectedContainers;
  const volumes = reviewed.protectedVolumes;
  if (!Array.isArray(containers) || !Array.isArray(volumes)
      || !containers.every(({ ID, Names }) => /^[0-9a-f]{64}$/.test(ID) && typeof Names === 'string' && Names.length > 0)
      || !volumes.every(({ Name }) => typeof Name === 'string' && Name.length > 0)
      || !original.protectedContainers.every(({ ID, Names }) => containers.some((row) => row.ID === ID && row.Names === Names))
      || !original.protectedVolumes.every(({ Name }) => volumes.some((row) => row.Name === Name))) {
    throw new Error('Reviewed inventory must preserve the original protected resources');
  }
  return reviewed;
}

export function parseListenerOutput(output, configuredPorts) {
  if (typeof output !== 'string' || !(configuredPorts instanceof Set)) {
    throw new TypeError('Local listener inspection is invalid');
  }
  const listeners = [];
  for (const line of output.split(/\r?\n/).filter((value) => value.trim())) {
    const columns = line.trim().split(/\s+/);
    const match = /^(.+):(\d+)$/.exec(columns[3] ?? '');
    if (columns[0] !== 'LISTEN' || !match) throw new Error('Local listener output contains an unrecognized endpoint');
    const endpoint = { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
    if (configuredPorts.has(endpoint.port)) listeners.push(endpoint);
  }
  const keys = listeners.map((item) => `${item.host}:${item.port}`);
  if (new Set(keys).size !== keys.length) throw new Error('Local listener output contains a duplicate endpoint');
  return listeners;
}

export function taskContainerReadiness(state, health, healthcheckConfigured, requireHealth = false) {
  if (state === 'exited' || state === 'dead' || state === 'removing') return 'failed';
  if (state !== 'running') return 'waiting';
  if (requireHealth && !healthcheckConfigured) return 'failed';
  if (healthcheckConfigured && health !== 'healthy') return health === 'starting' ? 'waiting' : 'failed';
  return 'ready';
}

export async function probeTaskServices(apiUrl, anonKey, fetchImpl = fetch) {
  if (!(apiUrl instanceof URL) || apiUrl.protocol !== 'http:' || apiUrl.hostname !== '127.0.0.1' || Number(apiUrl.port) !== 54341
      || typeof anonKey !== 'string' || anonKey.length === 0 || typeof fetchImpl !== 'function') {
    throw new TypeError('Task service probe target is invalid');
  }
  const headers = { apikey: anonKey };
  const auth = await fetchImpl(new URL('/auth/v1/health', apiUrl), { headers, signal: AbortSignal.timeout(10000) });
  if (!auth.ok) throw new Error(`Auth readiness returned HTTP ${auth.status}`);
  const rest = await fetchImpl(new URL('/rest/v1/', apiUrl), { headers, signal: AbortSignal.timeout(10000) });
  if (!rest.ok) throw new Error(`PostgREST readiness returned HTTP ${rest.status}`);
  return { authStatus: auth.status, postgrestStatus: rest.status };
}

function assert(condition, message) {
  if (!condition) throw new Error(`Task Supabase resume guard: ${message}`);
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function decideResumeOrder(containers) {
  assert(Array.isArray(containers) && containers.length === 4, 'exactly four task containers are required');
  const states = containers.map((container) => container?.State?.Status);
  assert(states.every((state) => state === 'running' || state === 'exited'), 'container state is unknown');
  const byId = new Map(containers.map((container) => [container.Id, container]));
  const db = byId.get(TASK_RESUME_CONTAINERS.db.id);
  const siblings = containers.filter((container) => container.Id !== TASK_RESUME_CONTAINERS.db.id);
  const dbHealthy = db?.State?.Health?.Status === 'healthy';
  if (states.every((state) => state === 'running')) {
    assert(dbHealthy, 'running database is not healthy');
    return { order: [], dbAlreadyRunning: true };
  }
  if (states.every((state) => state === 'exited')) return { order: ['db', 'auth', 'rest', 'kong'], dbAlreadyRunning: false };
  if (db?.State?.Status === 'running' && dbHealthy && siblings.every((container) => container.State.Status === 'exited')) {
    return { order: ['auth', 'rest', 'kong'], dbAlreadyRunning: true };
  }
  throw new Error('Task Supabase partial stack is not resumable');
}

export function validateResumeStack(input) {
  assert(input && typeof input === 'object', 'runtime facts are missing');
  const specs = TASK_RESUME_CONTAINERS;
  assert(input.config?.projectId === 'jt-studio-blog-tests'
    && input.config?.databasePort === 54342 && input.config?.apiPort === 54341, 'project configuration changed');
  const expectedProtectedContainers = input.expectedProtectedContainerIds;
  const observedProtectedContainers = input.observedProtectedContainerIds;
  const expectedProtectedVolumes = input.expectedProtectedVolumeNames;
  const observedProtectedVolumes = input.observedProtectedVolumeNames;
  assert(Array.isArray(expectedProtectedContainers) && expectedProtectedContainers.length >= 7
    && sameStrings(expectedProtectedContainers, observedProtectedContainers), 'protected container inventory changed');
  assert(Array.isArray(expectedProtectedVolumes) && expectedProtectedVolumes.length >= 236
    && sameStrings(expectedProtectedVolumes, observedProtectedVolumes), 'protected volume inventory changed');
  const expectedTaskIds = Object.values(specs).map((spec) => spec.id);
  const storageIds = [STORAGE_RUNTIME_IDENTITY.existingServiceId, STORAGE_RUNTIME_IDENTITY.existingInitializerId];
  const storageVolume = STORAGE_RUNTIME_IDENTITY.volumeName;
  const storagePresent = storageIds.some((id) => input.observedContainerIds.includes(id))
    || input.observedVolumeNames.includes(storageVolume);
  const expectedAllContainerIds = [...expectedProtectedContainers, ...expectedTaskIds, ...(storagePresent ? storageIds : [])];
  const expectedAllVolumes = [...expectedProtectedVolumes, 'supabase_db_jt-studio-blog-tests', ...(storagePresent ? [storageVolume] : [])];
  assert(sameStrings(expectedAllContainerIds, input.observedContainerIds), 'unexpected container inventory entry');
  assert(sameStrings(expectedAllVolumes, input.observedVolumeNames), 'unexpected volume inventory entry');
  assert(input.network?.Id === '4a414b5db8a0304cff2b69a0bddb391614d409125f9981ab8202f6685d805585'
    && input.network?.Name === 'jt-studio-blog-tests-network' && input.network?.Driver === 'bridge'
    && input.network?.Scope === 'local' && input.network?.HostBindingIPv4 === '127.0.0.1'
    && input.network?.ProjectLabel === 'jt-studio-blog-tests', 'task bridge identity changed');
  assert(input.volume?.Name === 'supabase_db_jt-studio-blog-tests' && input.volume?.Driver === 'local'
    && !expectedProtectedVolumes.includes(input.volume.Name), 'task database volume identity changed');

  const containers = input.containers;
  assert(Array.isArray(containers) && containers.length === 4, 'container inventory is incomplete');
  const byName = new Map(containers.map((container) => [container?.Name?.replace(/^\//, ''), container]));
  assert(byName.size === 4, 'container inventory has duplicate names');
  const ids = {};
  for (const [service, spec] of Object.entries(specs)) {
    const container = byName.get(spec.name);
    assert(container && container.Id === spec.id && !expectedProtectedContainers.includes(container.Id), `${service} full ID is unrecognized or protected`);
    assert(container.Config?.Labels?.['com.supabase.cli.project'] === 'jt-studio-blog-tests'
      && container.Config?.Labels?.['com.docker.compose.project'] === 'jt-studio-blog-tests', `${service} project labels changed`);
    const attachedNetworks = Object.entries(container.NetworkSettings?.Networks ?? {});
    assert(attachedNetworks.length === 1 && attachedNetworks[0][0] === 'jt-studio-blog-tests-network'
      && attachedNetworks[0][1]?.NetworkID === input.network.Id, `${service} network changed`);
    const bindings = container.HostConfig?.PortBindings ?? {};
    const published = Object.entries(bindings).flatMap(([port, rows]) => (rows ?? []).map((row) => ({ port, ...row })));
    if (spec.internalPort) {
      assert(published.length === 1 && published[0].port === `${spec.internalPort}/tcp`
        && published[0].HostIp === '127.0.0.1' && published[0].HostPort === String(spec.hostPort), `${service} published binding changed`);
    } else assert(published.length === 0, `${service} has an unexpected published binding`);
    const mounts = (container.Mounts ?? []).map((mount) => [mount.Name, mount.Destination]);
    assert(JSON.stringify(mounts) === JSON.stringify(spec.mounts), `${service} mounts changed`);
    if (container.State.Status === 'exited') assert(container.State.ExitCode === 0 && container.State.OOMKilled === false, `${service} did not exit cleanly`);
    ids[service] = container.Id;
  }
  const resumeState = decideResumeOrder(containers);
  const order = resumeState.order;
  const expectedOwnedPorts = new Map([[54342, specs.db.id], [54341, specs.kong.id]]);
  const expectedListeners = containers.filter((container) => container.State.Status === 'running')
    .flatMap((container) => [specs.db.id, specs.kong.id].includes(container.Id)
      ? [{ id: container.Id, port: container.Id === specs.db.id ? 54342 : 54341 }] : []);
  for (const listener of input.listeners ?? []) {
    const ownerId = expectedOwnedPorts.get(listener.port);
    assert(ownerId && listener.host === '127.0.0.1'
      && expectedListeners.some((expected) => expected.id === ownerId && expected.port === listener.port),
    'a task port is held by an unexpected process or container');
  }
  assert((input.listeners ?? []).length === expectedListeners.length, 'configured listeners do not match stack state');
  return { ids, order, dbAlreadyRunning: resumeState.dbAlreadyRunning };
}

export async function resumeExistingTaskStack(input, { startContainer, waitRunning, afterDatabase = async () => {} }) {
  if (typeof startContainer !== 'function' || typeof waitRunning !== 'function' || typeof afterDatabase !== 'function') {
    throw new TypeError('Task resume callbacks are required');
  }
  const decision = validateResumeStack(input);
  if (decision.dbAlreadyRunning) {
    await afterDatabase(decision.ids.db);
    if (decision.order.length === 0) {
      for (const service of ['auth', 'rest', 'kong']) await waitRunning(service, decision.ids[service]);
    }
  }
  for (const service of decision.order) {
    const id = decision.ids[service];
    await startContainer(service, id);
    await waitRunning(service, id);
    if (service === 'db') await afterDatabase(id);
  }
  return decision;
}
