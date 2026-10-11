import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request as requestHttp } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertProvisionable, decideResumeOrder, parseContainerInventoryRows, parseListenerOutput, probeTaskServices, resolveProtectedContainerRows, resumeExistingTaskStack, taskContainerReadiness, validateResumeStack } from '../../scripts/supabase-resume.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';

const ids = {
  db: 'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966',
  rest: 'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603',
  auth: '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b',
  kong: '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4',
};
const networkId = '4a414b5db8a0304cff2b69a0bddb391614d409125f9981ab8202f6685d805585';

function fixture() {
  const spec = [
    ['db', 'supabase_db_jt-studio-blog-tests', 5432, 54342, [{ Name: 'supabase_db_jt-studio-blog-tests', Destination: '/var/lib/postgresql/data' }]],
    ['rest', 'supabase_rest_jt-studio-blog-tests', 0, 0, []],
    ['auth', 'supabase_auth_jt-studio-blog-tests', 0, 0, []],
    ['kong', 'supabase_kong_jt-studio-blog-tests', 8000, 54341, []],
  ];
  return {
    containers: spec.map(([key, name, port, hostPort, mounts]) => ({
      Id: ids[key], Name: `/${name}`, State: { Status: 'exited', ExitCode: 0, OOMKilled: false },
      Config: { Labels: { 'com.supabase.cli.project': 'jt-studio-blog-tests', 'com.docker.compose.project': 'jt-studio-blog-tests' } },
      NetworkSettings: { Networks: { 'jt-studio-blog-tests-network': { NetworkID: networkId } } },
      HostConfig: { PortBindings: port ? { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] } : {} },
      Mounts: mounts,
    })),
    expectedProtectedContainerIds: Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(64)),
    observedProtectedContainerIds: Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(64)),
    expectedProtectedVolumeNames: Array.from({ length: 236 }, (_, i) => `protected-volume-${i}`),
    observedProtectedVolumeNames: Array.from({ length: 236 }, (_, i) => `protected-volume-${i}`),
    observedContainerIds: [...Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(64)), ...Object.values(ids)],
    observedVolumeNames: [...Array.from({ length: 236 }, (_, i) => `protected-volume-${i}`), 'supabase_db_jt-studio-blog-tests'],
    network: { Id: networkId, Name: 'jt-studio-blog-tests-network', Driver: 'bridge', Scope: 'local', HostBindingIPv4: '127.0.0.1', ProjectLabel: 'jt-studio-blog-tests' },
    volume: { Name: 'supabase_db_jt-studio-blog-tests', Driver: 'local' },
    config: { projectId: 'jt-studio-blog-tests', databasePort: 54342, apiPort: 54341 },
    listeners: [],
  };
}

test('validates the exact task stack and resumes in dependency order', () => {
  const input = fixture();
  const identity = validateResumeStack(input);
  assert.deepEqual(identity.ids, ids);
  assert.deepEqual(decideResumeOrder(input.containers), { order: ['db', 'auth', 'rest', 'kong'], dbAlreadyRunning: false });
});

test('accepts the verified all-running stack as an idempotent no-op', () => {
  const input = fixture();
  for (const container of input.containers) container.State.Status = 'running';
  input.containers.find((container) => container.Id === ids.db).State.Health = { Status: 'healthy' };
  input.listeners = [
    { port: 54342, host: '127.0.0.1', containerId: ids.db },
    { port: 54341, host: '127.0.0.1', containerId: ids.kong },
  ];
  assert.deepEqual(decideResumeOrder(input.containers), { order: [], dbAlreadyRunning: true });
  assert.doesNotThrow(() => validateResumeStack(input));
});

test('fails closed for partial, foreign, protected, wildcard, IPv6, mount, network, volume, or port drift', () => {
  const mutations = [
    (x) => { x.containers.pop(); },
    (x) => { x.containers[0].Id = '9'.repeat(64); },
    (x) => { x.expectedProtectedContainerIds[0] = ids.db; x.observedProtectedContainerIds[0] = ids.db; },
    (x) => { x.containers[0].HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0'; },
    (x) => { x.containers[3].HostConfig.PortBindings['8000/tcp'] = [{ HostIp: '::', HostPort: '54341' }]; },
    (x) => { x.containers[1].Mounts.push({ Source: '/tmp', Destination: '/tmp' }); },
    (x) => { x.containers[2].NetworkSettings.Networks['jt-studio-blog-tests-network'].NetworkID = '8'.repeat(64); },
    (x) => { x.volume.Name = 'different-volume'; },
    (x) => { x.listeners.push({ port: 54342, containerId: '9'.repeat(64) }); },
    (x) => { x.containers[0].State.Status = 'running'; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => validateResumeStack(input));
  }
});

test('rejects mixed running and stopped states before choosing any starts', () => {
  const input = fixture();
  input.containers[0].State.Status = 'running';
  assert.throws(() => decideResumeOrder(input.containers), /partial/);
});

test('provision accepts only a genuinely absent task stack', () => {
  assert.deepEqual(assertProvisionable([]), { allowed: true });
  assert.throws(() => assertProvisionable([{ Name: '/supabase_db_jt-studio-blog-tests' }]), /already has containers/);
});

test('inventory parser requires full Docker IDs and preserves exact names', () => {
  const entries = parseContainerInventoryRows(`${ids.db}|supabase_db_jt-studio-blog-tests\n${ids.kong}|supabase_kong_jt-studio-blog-tests`);
  assert.deepEqual(entries, [
    { id: ids.db, name: 'supabase_db_jt-studio-blog-tests' },
    { id: ids.kong, name: 'supabase_kong_jt-studio-blog-tests' },
  ]);
  assert.throws(() => parseContainerInventoryRows('bf0489cbc54c|supabase_db_jt-studio-blog-tests'), /full IDs/);
});

test('resolves protected inventory prefixes only by a unique full ID and matching name', () => {
  const protectedId = 'abcdef0123456789'.padEnd(64, 'a');
  const foreignId = 'abcdef012345' + 'b'.repeat(52);
  const inventory = [{ ID: protectedId.slice(0, 12), Names: '/protected-service' }];
  const observed = [{ id: protectedId, name: 'protected-service' }, { id: '9'.repeat(64), name: 'task-service' }];
  assert.deepEqual(resolveProtectedContainerRows(inventory, observed), [observed[0]]);
  assert.throws(() => resolveProtectedContainerRows(inventory, [...observed, { id: foreignId, name: 'other-service' }]), /unique/);
  assert.throws(() => resolveProtectedContainerRows([{ ...inventory[0], Names: '/renamed-service' }], observed), /name/);
});

test('resume orchestration sends guarded full-ID starts to the fake Docker endpoint in dependency order', async (t) => {
  const input = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'jt-blog-resume-orchestration-'));
  const upstreamPath = join(dir, 'docker.sock');
  const observed = [];
  const server = createHttpServer((req, res) => {
    observed.push(`${req.method} ${req.url}`);
    res.writeHead(204);
    res.end();
  });
  server.listen(upstreamPath);
  await once(server, 'listening');
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstreamPath,
    allowedNames: new Set(Object.values({ db: 'supabase_db_jt-studio-blog-tests', rest: 'supabase_rest_jt-studio-blog-tests', auth: 'supabase_auth_jt-studio-blog-tests', kong: 'supabase_kong_jt-studio-blog-tests' })),
    verifiedContainerIds: new Set(Object.values(ids)),
    resumableContainerIds: new Set(Object.values(ids)),
  });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const socketPath = await proxy.listen();
  const events = [];
  const result = await resumeExistingTaskStack(input, {
    startContainer: (_service, id) => new Promise((resolve, reject) => {
      const req = requestHttp({ socketPath, path: `/v1.56/containers/${id}/start`, method: 'POST' }, (res) => {
        res.resume();
        res.once('end', () => res.statusCode === 204 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
      });
      req.once('error', reject);
      req.end();
    }),
    waitRunning: async (service, id) => {
      if (service === 'db') {
        events.push('health:db:starting');
        events.push('health:db:healthy');
      }
      events.push(`ready:${service}:${id}`);
    },
    afterDatabase: async () => { events.push('sql:db'); },
  });
  assert.deepEqual(result.order, ['db', 'auth', 'rest', 'kong']);
  assert.deepEqual(observed, ['POST /v1.56/containers/' + ids.db + '/start', 'POST /v1.56/containers/' + ids.auth + '/start', 'POST /v1.56/containers/' + ids.rest + '/start', 'POST /v1.56/containers/' + ids.kong + '/start']);
  assert.deepEqual(events, ['health:db:starting', 'health:db:healthy', `ready:db:${ids.db}`, 'sql:db', `ready:auth:${ids.auth}`, `ready:rest:${ids.rest}`, `ready:kong:${ids.kong}`]);
});

test('resume orchestration performs no endpoint call when fresh validation fails', async () => {
  const input = fixture();
  input.containers[1].State.Status = 'running';
  let calls = 0;
  await assert.rejects(() => resumeExistingTaskStack(input, {
    startContainer: async () => { calls += 1; },
    waitRunning: async () => { calls += 1; },
  }), /partial/);
  assert.equal(calls, 0);
});

test('accepts only the exact healthy database plus three stopped siblings checkpoint', async () => {
  const input = fixture();
  const db = input.containers.find((container) => container.Id === ids.db);
  db.State.Status = 'running';
  db.State.Health = { Status: 'healthy' };
  input.listeners = [{ port: 54342, host: '127.0.0.1' }];
  const result = validateResumeStack(input);
  assert.deepEqual(result.order, ['auth', 'rest', 'kong']);
  assert.equal(result.dbAlreadyRunning, true);
  db.State.Health = { Status: 'starting' };
  assert.throws(() => validateResumeStack(input), /partial/);
  db.State.Health = { Status: 'healthy' };
  input.containers.find((container) => container.Id === ids.auth).State.Status = 'running';
  assert.throws(() => validateResumeStack(input), /partial/);
});

test('healthy database checkpoint rejects non-loopback, IPv6, duplicate, and foreign configured listeners', () => {
  const input = fixture();
  input.containers.find((container) => container.Id === ids.db).State.Status = 'running';
  input.containers.find((container) => container.Id === ids.db).State.Health = { Status: 'healthy' };
  for (const listeners of [
    [{ host: '0.0.0.0', port: 54342 }],
    [{ host: '::', port: 54342 }],
    [{ host: '127.0.0.1', port: 54342 }, { host: '127.0.0.1', port: 54342 }],
    [{ host: '127.0.0.1', port: 54340 }],
  ]) {
    assert.throws(() => validateResumeStack({ ...input, listeners }));
  }
});

test('healthy database checkpoint performs guarded SQL before resuming any sibling', async () => {
  const input = fixture();
  const db = input.containers.find((container) => container.Id === ids.db);
  db.State.Status = 'running';
  db.State.Health = { Status: 'healthy' };
  input.listeners = [{ port: 54342, host: '127.0.0.1' }];
  const events = [];
  const decision = await resumeExistingTaskStack(input, {
    startContainer: async (service, id) => { events.push(`start:${service}:${id}`); },
    waitRunning: async (service) => { events.push(`ready:${service}`); },
    afterDatabase: async (id) => { events.push(`sql:${id}`); },
  });
  assert.deepEqual(decision.order, ['auth', 'rest', 'kong']);
  assert.deepEqual(events, [
    `sql:${ids.db}`,
    `start:auth:${ids.auth}`, 'ready:auth',
    `start:rest:${ids.rest}`, 'ready:rest',
    `start:kong:${ids.kong}`, 'ready:kong',
  ]);
});

test('all-running idempotent resume rechecks healthy services without start calls', async () => {
  const input = fixture();
  for (const container of input.containers) container.State.Status = 'running';
  input.containers.find((container) => container.Id === ids.db).State.Health = { Status: 'healthy' };
  input.listeners = [{ port: 54342, host: '127.0.0.1' }, { port: 54341, host: '127.0.0.1' }];
  const events = [];
  await resumeExistingTaskStack(input, {
    startContainer: async () => { events.push('unexpected-start'); },
    waitRunning: async (service) => { events.push(`healthy:${service}`); },
    afterDatabase: async () => { events.push('sql:db'); },
  });
  assert.deepEqual(events, ['sql:db', 'healthy:auth', 'healthy:rest', 'healthy:kong']);
});

test('listener parser uses the actual TCP-only ss format and rejects duplicate endpoints', () => {
  const output = [
    'LISTEN 0 4096 127.0.0.1:54342 0.0.0.0:*',
  ].join('\n');
  assert.deepEqual(parseListenerOutput(output, new Set([54341, 54342])), [{ host: '127.0.0.1', port: 54342 }]);
  assert.throws(() => parseListenerOutput(`${output}\n${output}`, new Set([54342])), /duplicate/);
  assert.deepEqual(parseListenerOutput('LISTEN 0 10 0.0.0.0:54342 0.0.0.0:*', new Set([54342])), [{ host: '0.0.0.0', port: 54342 }]);
  assert.deepEqual(parseListenerOutput('LISTEN 0 10 [::]:54342 [::]:*', new Set([54342])), [{ host: '::', port: 54342 }]);
  assert.throws(() => parseListenerOutput('tcp LISTEN 0 10 invalid 0.0.0.0:*', new Set([54342])), /unrecognized/);
});

test('Docker readiness waits for configured health and fails closed on missing or unknown state', () => {
  assert.equal(taskContainerReadiness('running', 'starting', true, true), 'waiting');
  assert.equal(taskContainerReadiness('running', 'healthy', true, true), 'ready');
  assert.equal(taskContainerReadiness('running', 'none', false, true), 'failed');
  assert.equal(taskContainerReadiness('running', 'unhealthy', true), 'failed');
  assert.equal(taskContainerReadiness('exited', 'healthy', true), 'failed');
});

test('functional Auth and PostgREST probes use the local key and stop on the first failure', async () => {
  const calls = [];
  const ok = async (_url, options) => { calls.push(options); return { ok: true, status: 200 }; };
  const result = await probeTaskServices(new URL('http://127.0.0.1:54341'), 'local-anon-key', ok);
  assert.deepEqual(result, { authStatus: 200, postgrestStatus: 200 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((options) => options.headers.apikey === 'local-anon-key'));
  calls.length = 0;
  await assert.rejects(() => probeTaskServices(new URL('http://127.0.0.1:54341'), 'local-anon-key', async () => {
    calls.push(true); return { ok: false, status: 503 };
  }), /Auth readiness/);
  assert.equal(calls.length, 1);
});
