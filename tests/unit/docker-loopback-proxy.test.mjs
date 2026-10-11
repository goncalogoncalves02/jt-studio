import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import {
  assertContainerIdNotProtected,
  createSupabaseCliEnvironment,
  parseTaskProjectConfig,
  validateLocalDatabaseTarget,
} from '../../scripts/supabase-local.mjs';
import {
  buildStorageContainerCreateBody,
  buildStorageInitializerSpec,
  buildStorageServiceSpec,
  validateStorageContainerCreateRequest,
  validateStorageVolumeCreateRequest,
} from '../../scripts/supabase-storage-runtime.mjs';

const allowedNames = new Set([
  'supabase_db_jt-studio-blog-tests',
  'jt-studio-blog-tests-bind-probe',
]);

async function socketServer(handler, onUpgrade) {
  const dir = await mkdtemp(join(tmpdir(), 'jt-blog-docker-proxy-test-'));
  const socketPath = join(dir, 'docker.sock');
  const server = createHttpServer(handler);
  if (onUpgrade) server.on('upgrade', onUpgrade);
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    socketPath,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function request(socketPath, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

test('rewrites all published host bindings for the own project and preserves upstream response', async (t) => {
  let received;
  const upstream = await socketServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(201, { 'content-type': 'application/json', 'x-daemon-result': 'real' });
      res.end('{"Id":"actual-daemon-id"}');
    });
  });
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: upstream.socketPath, allowedNames });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const result = await request(proxy.socketPath, '/v1.56/containers/create?name=supabase_db_jt-studio-blog-tests', {
    method: 'POST',
    body: {
      Image: 'postgres:18.6-bookworm',
      Labels: { owner: 'jt-studio-blog-tests' },
      HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '54342' }, { HostPort: '54349' }] } },
    },
  });

  assert.deepEqual(received.body.HostConfig.PortBindings['5432/tcp'], [
    { HostIp: '127.0.0.1', HostPort: '54342' },
    { HostIp: '127.0.0.1', HostPort: '54349' },
  ]);
  assert.equal(received.body.Image, 'postgres:18.6-bookworm');
  assert.deepEqual(received.body.Labels, { owner: 'jt-studio-blog-tests' });
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-daemon-result'], 'real');
  assert.equal(result.body, '{"Id":"actual-daemon-id"}');
});

test('rejects a create outside the task allowlist without forwarding it', async (t) => {
  let forwarded = false;
  const upstream = await socketServer((_req, res) => { forwarded = true; res.end('{}'); });
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: upstream.socketPath, allowedNames });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const result = await request(proxy.socketPath, '/v1.56/containers/create?name=unrelated-container', {
    method: 'POST', body: { Image: 'postgres:18.6-bookworm' },
  });
  assert.equal(result.status, 403);
  assert.equal(forwarded, false);
});

test('rejects Docker operations outside this runtime boundary', async (t) => {
  let forwarded = 0;
  const upstream = await socketServer((_req, res) => { forwarded += 1; res.end('{}'); });
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: upstream.socketPath, allowedNames });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const cases = [
    { method: 'POST', path: '/v1.56/containers/prune' },
    { method: 'POST', path: '/v1.56/volumes/prune' },
    { method: 'POST', path: '/v1.56/networks/prune' },
    { method: 'DELETE', path: '/v1.56/volumes/protected-volume' },
    { method: 'DELETE', path: '/v1.56/networks/protected-network' },
    { method: 'DELETE', path: '/v1.56/containers/protected-container' },
    {
      method: 'POST',
      path: '/v1.56/containers/create?name=supabase_db_jt-studio-blog-tests',
      body: { Image: 'postgres:18.6-bookworm', HostConfig: { NetworkMode: 'host' } },
    },
    {
      method: 'POST',
      path: '/v1.56/containers/create?name=supabase_db_jt-studio-blog-tests',
      body: { Image: 'postgres:18.6-bookworm', HostConfig: { PublishAllPorts: true } },
    },
  ];
  for (const entry of cases) {
    const result = await request(proxy.socketPath, entry.path, entry);
    assert.equal(result.status, 403, `${entry.method} ${entry.path}`);
  }
  assert.equal(forwarded, 0);
});

test('tracks created task containers and never requests anonymous volume removal', async (t) => {
  const forwarded = [];
  const upstream = await socketServer((req, res) => {
    forwarded.push(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"Id":"daemon-owned-id"}');
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: upstream.socketPath, allowedNames });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const created = await request(proxy.socketPath, '/v1.56/containers/create?name=supabase_db_jt-studio-blog-tests', {
    method: 'POST', body: { Image: 'postgres:18.6-bookworm' },
  });
  assert.equal(created.status, 201);
  const protectedDelete = await request(proxy.socketPath, '/v1.56/containers/untracked-id?force=true', { method: 'DELETE' });
  assert.equal(protectedDelete.status, 403);
  const volumeDelete = await request(proxy.socketPath, '/v1.56/containers/daemon-owned-id?force=true&v=true', { method: 'DELETE' });
  assert.equal(volumeDelete.status, 403);
  const ownDelete = await request(proxy.socketPath, '/v1.56/containers/daemon-owned-id?force=true&v=false', { method: 'DELETE' });
  assert.equal(ownDelete.status, 204);
  assert.deepEqual(forwarded, [
    'POST /v1.56/containers/create?name=supabase_db_jt-studio-blog-tests',
    'DELETE /v1.56/containers/daemon-owned-id?force=true&v=false',
  ]);
});

test('allows removal only for a preverified task container and never with its volumes', async (t) => {
  const ownId = 'a'.repeat(64);
  const forwarded = [];
  const upstream = await socketServer((req, res) => {
    forwarded.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames,
    verifiedContainerIds: new Set([ownId]),
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const ownDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?force=true&v=false`, { method: 'DELETE' });
  const volumeDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?force=true&v=true`, { method: 'DELETE' });
  const uppercaseDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?v=TRUE`, { method: 'DELETE' });
  const shorthandDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?v=t`, { method: 'DELETE' });
  const duplicateDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?v=false&v=false`, { method: 'DELETE' });
  const zeroDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}?v=0`, { method: 'DELETE' });
  const defaultDelete = await request(proxy.socketPath, `/v1.56/containers/${ownId}`, { method: 'DELETE' });
  const foreignDelete = await request(proxy.socketPath, `/v1.56/containers/${'b'.repeat(64)}?force=true&v=false`, { method: 'DELETE' });
  assert.equal(ownDelete.status, 204);
  assert.equal(volumeDelete.status, 403);
  assert.equal(uppercaseDelete.status, 403);
  assert.equal(shorthandDelete.status, 403);
  assert.equal(duplicateDelete.status, 403);
  assert.equal(zeroDelete.status, 204);
  assert.equal(defaultDelete.status, 204);
  assert.equal(foreignDelete.status, 403);
  assert.deepEqual(forwarded, [
    `DELETE /v1.56/containers/${ownId}?force=true&v=false`,
    `DELETE /v1.56/containers/${ownId}?v=0`,
    `DELETE /v1.56/containers/${ownId}`,
  ]);
});

test('does not seed a preexisting container ID from the protected inventory', () => {
  const ownId = 'a'.repeat(64);
  const protectedId = 'b'.repeat(64);
  assert.equal(assertContainerIdNotProtected(ownId, { protectedContainers: [{ ID: protectedId }] }), ownId);
  assert.throws(() => assertContainerIdNotProtected(protectedId, { protectedContainers: [{ ID: protectedId }] }), /protected Docker inventory/);
  assert.throws(() => assertContainerIdNotProtected(ownId, {}), /inventory is invalid/);
});

test('reports sanitized container-delete guard diagnostics without exposing IDs or query values', async (t) => {
  let observed;
  const upstream = await socketServer((_req, res) => { res.writeHead(204); res.end(); });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames,
    verifiedContainerIds: new Set(['a'.repeat(64)]),
    onDeleteEvent: (event) => { observed = event; },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const response = await request(proxy.socketPath, `/v1.56/containers/${'a'.repeat(64)}?force=true&v=false`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.deepEqual(observed, {
    endpoint: '/v1.56/containers/{id}',
    idKind: 'verified-full-id',
    idFormat: 'full-hex',
    volumeFlag: 'false',
    forceFlag: 'true',
  });
});

test('resolves only the verified task database name to its full ID before DELETE', async (t) => {
  const ownId = 'c'.repeat(64);
  const forwardedPaths = [];
  const upstream = await socketServer((req, res) => {
    forwardedPaths.push(req.url);
    res.writeHead(204);
    res.end();
  });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames,
    verifiedContainerIds: new Set([ownId]),
    verifiedContainerNameIds: new Map([['supabase_db_jt-studio-blog-tests', ownId]]),
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const ownDelete = await request(proxy.socketPath, '/v1.56/containers/supabase_db_jt-studio-blog-tests?force=true', { method: 'DELETE' });
  const unrelatedTaskName = await request(proxy.socketPath, '/v1.56/containers/supabase_auth_jt-studio-blog-tests?force=true', { method: 'DELETE' });
  const ownShortId = await request(proxy.socketPath, `/v1.56/containers/${ownId.slice(0, 12)}?v=0`, { method: 'DELETE' });
  const foreignShortId = await request(proxy.socketPath, `/v1.56/containers/${'d'.repeat(12)}?v=0`, { method: 'DELETE' });
  assert.equal(ownDelete.status, 204);
  assert.equal(unrelatedTaskName.status, 403);
  assert.equal(ownShortId.status, 204);
  assert.equal(foreignShortId.status, 403);
  assert.deepEqual(forwardedPaths, [
    `/v1.56/containers/${ownId}?force=true`,
    `/v1.56/containers/${ownId}?v=0`,
  ]);
});

test('starts only an explicitly resumable full container ID and forwards the real daemon response', async (t) => {
  const ownId = 'e'.repeat(64);
  const received = [];
  const upstream = await socketServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(204, { 'x-daemon-start': 'real' });
    res.end();
  });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames,
    verifiedContainerIds: new Set([ownId]),
    resumableContainerIds: new Set([ownId]),
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const started = await request(proxy.socketPath, `/v1.56/containers/${ownId}/start`, { method: 'POST' });
  const foreign = await request(proxy.socketPath, `/v1.56/containers/${'f'.repeat(64)}/start`, { method: 'POST' });
  const alias = await request(proxy.socketPath, '/v1.56/containers/supabase_db_jt-studio-blog-tests/start', { method: 'POST' });
  assert.equal(started.status, 204);
  assert.equal(started.headers['x-daemon-start'], 'real');
  assert.equal(foreign.status, 403);
  assert.equal(alias.status, 403);
  assert.deepEqual(received, [`POST /v1.56/containers/${ownId}/start`]);
});

test('Storage recovery proxy forwards starts only for the two approved full IDs', async (t) => {
  const initializerId = 'fc07c13392c9b099a44ac67f3d175dd87980513a907596b62c71fd01774417bc';
  const serviceId = '64db731c94b829cd30427a0b30630e5979e17f15d157d297ac13d7fe0a5910e1';
  const received = [];
  const upstream = await socketServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  const exactIds = new Set([initializerId, serviceId]);
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames: new Set(['supabase_storage_jt-studio-blog-tests-volume-init', 'supabase_storage_jt-studio-blog-tests']),
    verifiedContainerIds: exactIds,
    resumableContainerIds: exactIds,
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();
  const initializer = await request(proxy.socketPath, `/v1.56/containers/${initializerId}/start`, { method: 'POST' });
  const service = await request(proxy.socketPath, `/v1.56/containers/${serviceId}/start`, { method: 'POST' });
  const stranger = await request(proxy.socketPath, `/v1.56/containers/${'f'.repeat(64)}/start`, { method: 'POST' });
  const short = await request(proxy.socketPath, `/v1.56/containers/${serviceId.slice(0, 12)}/start`, { method: 'POST' });
  assert.equal(initializer.status, 204);
  assert.equal(service.status, 204);
  assert.equal(stranger.status, 403);
  assert.equal(short.status, 403);
  assert.deepEqual(received, [
    `POST /v1.56/containers/${initializerId}/start`,
    `POST /v1.56/containers/${serviceId}/start`,
  ]);
});

test('Storage Docker create guard accepts only exact service/initializer specs before upstream', async (t) => {
  const serviceName = 'supabase_storage_jt-studio-blog-tests';
  const initializerName = `${serviceName}-volume-init`;
  const volumeName = 'supabase_storage_jt-studio-blog-tests';
  const image = 'supabase/storage-api:v1.79.36@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154';
  const networkId = '4a414b5db8a0304cff2b69a0bddb391614d409125f9981ab8202f6685d805585';
  const secret = 'storage-create-secret-fixture';
  const env = { DATABASE_URL: 'postgres://private', SERVICE_KEY: secret };
  const serviceSpec = buildStorageServiceSpec({ image, networkId, volumeName, env });
  const initSpec = buildStorageInitializerSpec({ image, networkId, volumeName, env: {} });
  const serviceBody = buildStorageContainerCreateBody(serviceName, serviceSpec);
  const initBody = buildStorageContainerCreateBody(initializerName, initSpec);
  let forwarded = 0;
  const createdId = 'a'.repeat(64);
  const upstream = await socketServer((req, res) => {
    forwarded += 1;
    if (req.method === 'POST' && req.url.includes('/containers/create')) {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Id: createdId }));
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames: new Set([serviceName, initializerName]),
    allowCreatedContainerStarts: true,
    createRequestGuard: (name, document) => validateStorageContainerCreateRequest(name, document, env),
    volumeCreateGuard: validateStorageVolumeCreateRequest,
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const volume = await request(proxy.socketPath, '/v1.56/volumes/create', {
    method: 'POST', body: { Name: volumeName, Driver: 'local', Labels: { 'org.jt-studio.project': 'jt-studio-blog-tests', 'org.jt-studio.task': 'blog-editorial-task5' } },
  });
  const service = await request(proxy.socketPath, `/v1.56/containers/create?name=${serviceName}`, { method: 'POST', body: serviceBody });
  const initializer = await request(proxy.socketPath, `/v1.56/containers/create?name=${initializerName}`, { method: 'POST', body: initBody });
  const start = await request(proxy.socketPath, `/v1.56/containers/${createdId}/start`, { method: 'POST' });
  assert.equal(volume.status, 204);
  assert.equal(service.status, 201);
  assert.equal(initializer.status, 201);
  assert.equal(start.status, 204);
  assert.equal(forwarded, 4);

  const invalid = [
    { name: serviceName, body: { ...serviceBody, User: '0:0' } },
    { name: serviceName, body: { ...serviceBody, HostConfig: { ...serviceBody.HostConfig, PortBindings: { '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }] } } } },
    { name: serviceName, body: { ...serviceBody, HostConfig: { ...serviceBody.HostConfig, NetworkMode: 'bridge' } } },
    { name: serviceName, body: { ...serviceBody, HostConfig: { ...serviceBody.HostConfig, Mounts: [{ Type: 'volume', Source: 'protected-volume', Target: '/mnt' }] } } },
    { name: serviceName, body: { ...serviceBody, HostConfig: { ...serviceBody.HostConfig, Mounts: [{ ...serviceBody.HostConfig.Mounts[0], VolumeOptions: { NoCopy: false } }] } } },
    { name: serviceName, body: { ...serviceBody, HostConfig: { ...serviceBody.HostConfig, NanoCpus: 0, Memory: 0, MemorySwap: 0, PidsLimit: 0 } } },
    { name: serviceName, body: { ...serviceBody, Healthcheck: { ...serviceBody.Healthcheck, Test: ['CMD-SHELL', 'wget http://127.0.0.1:5000/status'] } } },
    { name: initializerName, body: { ...initBody, Cmd: ['-e', 'require("node:fs").rmSync("/",{recursive:true,force:true})'] } },
    { name: initializerName, body: { ...initBody, HostConfig: { ...initBody.HostConfig, Mounts: [{ ...initBody.HostConfig.Mounts[0], VolumeOptions: { NoCopy: false } }] } } },
  ];
  for (const [index, entry] of invalid.entries()) {
    const result = await request(proxy.socketPath, `/v1.56/containers/create?name=${entry.name}`, { method: 'POST', body: entry.body });
    assert.equal(result.status, 403, `mutant ${index} must be rejected`);
    assert.equal(result.body.includes(secret), false);
  }
  const foreignVolume = await request(proxy.socketPath, '/v1.56/volumes/create', {
    method: 'POST', body: { Name: 'protected-volume', Driver: 'local' },
  });
  assert.equal(foreignVolume.status, 403);
  const foreignStart = await request(proxy.socketPath, `/v1.56/containers/${'b'.repeat(64)}/start`, { method: 'POST' });
  assert.equal(foreignStart.status, 403);
  assert.equal(forwarded, 4, 'invalid Docker requests must never reach the daemon');
});

test('passes through non-create requests and real response bytes unchanged', async (t) => {
  let observed;
  const upstream = await socketServer((req, res) => {
    observed = { method: req.method, url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"Containers":[]}');
  });
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: upstream.socketPath, allowedNames });
  t.after(async () => { await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const result = await request(proxy.socketPath, '/v1.56/containers/json?all=1');
  assert.deepEqual(observed, { method: 'GET', url: '/v1.56/containers/json?all=1' });
  assert.equal(result.body, '{"Containers":[]}');
});

test('forwards Docker exec hijack upgrades and raw daemon bytes unchanged', async (t) => {
  let observed;
  let upgradeEvent;
  let upstreamSocket;
  const upstream = await socketServer((_req, res) => {
    res.writeHead(400);
    res.end();
  }, (req, socket, head) => {
    observed = { method: req.method, url: req.url, upgrade: req.headers.upgrade, connection: req.headers.connection, headBytes: head.length };
    upstreamSocket = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write('raw-daemon-stream');
    socket.end();
  });
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames,
    onUpgradeEvent: (event) => { upgradeEvent = event; },
  });
  t.after(async () => { upstreamSocket?.destroy(); await proxy.close(); await upstream.close(); });
  await proxy.listen();

  const received = await new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: proxy.socketPath,
      path: '/v1.56/exec/opaque-exec-id/start?detach=false&hijack=true',
      method: 'POST',
      headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-length': '0' },
    });
    const timeout = setTimeout(() => {
      req.destroy();
      resolve({ outcome: 'timeout' });
    }, 250);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timeout);
      const chunks = [head];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => resolve({ outcome: 'upgrade', status: res.statusCode, bytes: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    req.end();
  });

  assert.equal(received.outcome, 'upgrade');
  assert.equal(received.status, 101);
  assert.equal(received.bytes, 'raw-daemon-stream');
  assert.deepEqual(observed, {
    method: 'POST',
    url: '/v1.56/exec/opaque-exec-id/start?detach=false&hijack=true',
    upgrade: 'tcp',
    connection: 'Upgrade',
    headBytes: 0,
  });
  assert.deepEqual(upgradeEvent, {
    method: 'POST',
    endpoint: '/v1.56/exec/{id}/start',
    upgrade: 'tcp',
    connectionUpgrade: true,
  });
});

test('isolates Docker and Supabase CLI state in the child environment', () => {
  const original = {
    DOCKER_CONTEXT: 'desktop-linux',
    DOCKER_HOST: 'tcp://old-host:2375',
    SUPABASE_ACCESS_TOKEN: 'secret-value',
    HOME: '/home/user',
    XDG_CONFIG_HOME: '/home/user/.config',
    SUPABASE_TELEMETRY_DISABLED: '0',
    OTHER_SETTING: 'kept',
  };
  const child = createSupabaseCliEnvironment(original, '/tmp/private/docker.sock');
  assert.equal(child.DOCKER_HOST, 'unix:///tmp/private/docker.sock');
  assert.equal(child.HOME, '/tmp/jt-studio-supabase-cli-home');
  assert.equal(child.XDG_CONFIG_HOME, '/tmp/jt-studio-supabase-cli-home/.config');
  assert.equal(child.XDG_CACHE_HOME, '/tmp/jt-studio-supabase-cli-home/.cache');
  assert.equal(child.SUPABASE_TELEMETRY_DISABLED, '1');
  assert.equal(Object.hasOwn(child, 'DOCKER_CONTEXT'), false);
  assert.equal(Object.hasOwn(child, 'SUPABASE_ACCESS_TOKEN'), false);
  assert.equal(child.OTHER_SETTING, 'kept');
  assert.deepEqual(original, {
    DOCKER_CONTEXT: 'desktop-linux',
    DOCKER_HOST: 'tcp://old-host:2375',
    SUPABASE_ACCESS_TOKEN: 'secret-value',
    HOME: '/home/user',
    XDG_CONFIG_HOME: '/home/user/.config',
    SUPABASE_TELEMETRY_DISABLED: '0',
    OTHER_SETTING: 'kept',
  });
});

test('parses only the exact local project ID and database port from CLI config', () => {
  const config = parseTaskProjectConfig(`project_id = "jt-studio-blog-tests"
[api]
port = 54341
[db]
port = 54342
shadow_port = 54340
`);
  assert.deepEqual(config, { projectId: 'jt-studio-blog-tests', databasePort: 54342, apiPort: 54341 });
});

test('accepts only the task project database URL on its expected IPv4 loopback port', () => {
  assert.deepEqual(validateLocalDatabaseTarget({
    DB_URL: 'postgresql://postgres:local-test-only@127.0.0.1:54342/postgres',
  }, 'jt-studio-blog-tests', 54342), {
    hostname: '127.0.0.1', port: 54342, database: 'postgres',
  });
  for (const url of [
    'postgresql://postgres:local-test-only@localhost:54342/postgres',
    'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres',
    'postgresql://postgres:local-test-only@example.supabase.co:5432/postgres',
    'postgresql://postgres:local-test-only@127.0.0.1:54342/other',
  ]) {
    assert.throws(() => validateLocalDatabaseTarget({ DB_URL: url }, 'jt-studio-blog-tests', 54342));
  }
  assert.throws(() => validateLocalDatabaseTarget({ DB_URL: 'postgresql://postgres:local-test-only@127.0.0.1:54342/postgres' }, 'other-project', 54342));
});
