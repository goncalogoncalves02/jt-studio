import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  assertStorageVolumeAbsent,
  buildStorageContainerCreateBody,
  buildStorageInitializerSpec,
  buildStorageServiceSpec,
  validateStorageContainerCreateRequest,
  validateStorageVolume,
  validateStorageInitialPreflight,
  validateStorageServiceInspection,
  validateStorageResumePreflight,
  validateStorageResumeContainerInspection,
  startVerifiedStorageContainer,
  STORAGE_RUNTIME_IDENTITY,
} from '../../scripts/supabase-storage-runtime.mjs';

const runtime = {
  image: 'supabase/storage-api:v1.79.36@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154',
  networkId: '4a414b5db8a0304cff2b69a0bddb391614d409125f9981ab8202f6685d805585',
  volumeName: 'supabase_storage_jt-studio-blog-tests',
  env: { DATABASE_URL: 'postgres://private', STORAGE_BACKEND: 'file' },
};

test('Storage service spec is pinned, internal-only, non-root, and resource bounded', () => {
  const spec = buildStorageServiceSpec(runtime);
  assert.equal(spec.name, 'supabase_storage_jt-studio-blog-tests');
  assert.equal(spec.image, runtime.image);
  assert.equal(spec.user, '1000:1000');
  assert.equal(spec.networkId, runtime.networkId);
  assert.deepEqual(spec.networkAliases, ['storage']);
  assert.deepEqual(spec.ports, []);
  assert.deepEqual(spec.mounts, [{ type: 'volume', source: runtime.volumeName, target: '/mnt', noCopy: true }]);
  assert.equal(spec.resources.nanoCpus, 1_000_000_000);
  assert.equal(spec.resources.memoryBytes, 805_306_368);
  assert.equal(spec.resources.memorySwapBytes, 805_306_368);
  assert.equal(spec.resources.pidsLimit, 256);
  assert.deepEqual(spec.security.capDrop, ['ALL']);
  assert.deepEqual(spec.security.securityOpt, ['no-new-privileges:true']);
  assert.equal(spec.security.readOnlyRootfs, true);
  assert.deepEqual(spec.security.tmpfs, { '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000' });
  assert.equal(spec.security.command.join(' '), 'node dist/start/server.js');
  assert.deepEqual(spec.env, runtime.env);
  const body = buildStorageContainerCreateBody(spec.name, spec);
  assert.equal(body.User, '1000:1000');
  assert.deepEqual(body.HostConfig.PortBindings, {});
  assert.equal(body.HostConfig.NetworkMode, runtime.networkId);
  assert.equal(body.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(body.HostConfig.Memory, 768 * 1024 * 1024);
  assert.equal(body.HostConfig.MemorySwap, 768 * 1024 * 1024);
  assert.equal(body.HostConfig.PidsLimit, 256);
  assert.deepEqual(body.Healthcheck.Test, [
    'CMD', 'node', '-e',
    "fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
  ]);
  assert.equal(body.Healthcheck.Timeout, 2_000_000_000);
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: 'volume', Source: runtime.volumeName, Target: '/mnt', VolumeOptions: { NoCopy: true } }]);
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.equal(validateStorageContainerCreateRequest(spec.name, body, runtime.env), true);
  for (const mutate of [
    (value) => { value.User = '0:0'; },
    (value) => { value.HostConfig.PortBindings = { '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: '5000' }] }; },
    (value) => { value.HostConfig.NetworkMode = 'bridge'; },
    (value) => { value.HostConfig.Memory = 0; },
    (value) => { value.HostConfig.MemorySwap = 0; },
    (value) => { value.HostConfig.PidsLimit = 0; },
    (value) => { value.HostConfig.CapDrop = []; },
    (value) => { value.HostConfig.ReadonlyRootfs = false; },
    (value) => { value.HostConfig.Mounts = []; },
    (value) => { value.HostConfig.Mounts[0].VolumeOptions.NoCopy = false; },
    (value) => { value.Cmd = ['sh', '-c', 'id']; },
    (value) => { value.Healthcheck.Test = ['CMD-SHELL', 'wget http://127.0.0.1:5000/status']; },
  ]) {
    const altered = structuredClone(body);
    mutate(altered);
    assert.equal(validateStorageContainerCreateRequest(spec.name, altered, runtime.env), false);
  }
});

test('Storage service builder rejects any image, network, or volume outside the exact task pin', () => {
  assert.throws(() => buildStorageServiceSpec({ ...runtime, image: 'supabase/storage-api:latest' }), /image/);
  assert.throws(() => buildStorageServiceSpec({ ...runtime, networkId: 'other-network' }), /network/);
  assert.throws(() => buildStorageServiceSpec({ ...runtime, volumeName: 'protected-volume' }), /volume/);
});

test('Docker argv passes secret environment keys without their values', () => {
  const secret = 'sensitive-task-fixture-value';
  const spec = buildStorageServiceSpec({ ...runtime, env: { ...runtime.env, SERVICE_KEY: secret } });
  const body = buildStorageContainerCreateBody(spec.name, spec);
  assert.ok(body.Env.includes(`SERVICE_KEY=${secret}`));
  assert.throws(() => buildStorageServiceSpec({ ...runtime, env: { ...runtime.env, OTHER_SECRET: secret } }), /env-key/);
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(body.HostConfig.PortBindings, {});
});

test('initializer is a finite ownership-only command with no network, ports, or application secrets', () => {
  const spec = buildStorageInitializerSpec({ ...runtime, env: {} });
  assert.equal(spec.name, 'supabase_storage_jt-studio-blog-tests-volume-init');
  assert.equal(spec.image, runtime.image);
  assert.equal(spec.user, '0:0');
  assert.equal(spec.networkMode, 'none');
  assert.deepEqual(spec.ports, []);
  assert.deepEqual(spec.mounts, [{ type: 'volume', source: runtime.volumeName, target: '/mnt', noCopy: true }]);
  assert.deepEqual(spec.env, {});
  assert.match(spec.security.command.join(' '), /lchownSync|chownSync/);
  assert.match(spec.security.command.join(' '), /readdirSync/);
  assert.match(spec.security.command.join(' '), /\/etc\/passwd/);
  assert.doesNotMatch(spec.security.command.join(' '), /-R|recursive/i);
  assert.doesNotMatch(spec.security.command.join(' '), /dist\/start\/server/);
  const body = buildStorageContainerCreateBody(spec.name, spec);
  assert.equal(body.HostConfig.NetworkMode, 'none');
  assert.deepEqual(body.HostConfig.CapAdd, ['CHOWN']);
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: 'volume', Source: runtime.volumeName, Target: '/mnt', VolumeOptions: { NoCopy: true } }]);
  assert.deepEqual(body.Env, []);
  assert.deepEqual(body.HostConfig.PortBindings, {});
  assert.equal(validateStorageContainerCreateRequest(spec.name, body, {}), true);
  const altered = structuredClone(body);
  altered.Cmd = ['-e', "require('node:fs').chownSync('/',0,0)"];
  assert.equal(validateStorageContainerCreateRequest(spec.name, altered, {}), false);
  const copyEnabled = structuredClone(body);
  copyEnabled.HostConfig.Mounts[0].VolumeOptions.NoCopy = false;
  assert.equal(validateStorageContainerCreateRequest(spec.name, copyEnabled, {}), false);
});

test('initializer command rejects unexpected passwd or volume state before chown', () => {
  const spec = buildStorageInitializerSpec({ ...runtime, env: {} });
  const command = spec.security.command[2];

  function execute({ passwd = 'node:x:1000:1000:Linux User:/home/node:/bin/sh', entries = [], uid = 0, gid = 0, directory = true } = {}) {
    const chownCalls = [];
    const fs = {
      readFileSync(path) { assert.equal(path, '/etc/passwd'); return passwd; },
      lstatSync(path) { assert.equal(path, '/mnt'); return { isDirectory: () => directory, uid, gid }; },
      readdirSync(path) { assert.equal(path, '/mnt'); return entries; },
      chownSync(path, nextUid, nextGid) { chownCalls.push([path, nextUid, nextGid]); uid = nextUid; gid = nextGid; },
    };
    let exitCode = null;
    const process = { exit(code) { exitCode = code; throw new Error('initializer-exit'); } };
    try {
      vm.runInNewContext(command, { require: (name) => { assert.equal(name, 'node:fs'); return fs; }, process });
    } catch (error) {
      if (error.message !== 'initializer-exit') throw error;
    }
    return { chownCalls, exitCode, uid, gid };
  }

  assert.deepEqual(execute(), { chownCalls: [['/mnt', 1000, 1000]], exitCode: null, uid: 1000, gid: 1000 });
  for (const state of [
    { passwd: 'node:x:1001:1000:Linux User:/home/node:/bin/sh' },
    { entries: ['unexpected-object'] },
    { uid: 1234 },
    { gid: 1234 },
    { directory: false },
  ]) {
    const result = execute(state);
    assert.deepEqual(result.chownCalls, []);
    assert.ok([41, 42].includes(result.exitCode));
  }
});

test('only a nonexistent task volume can be initialized and created volume labels are checked', () => {
  assert.equal(assertStorageVolumeAbsent({ exists: false, name: runtime.volumeName }), true);
  assert.throws(() => assertStorageVolumeAbsent({ exists: true, name: runtime.volumeName }), /volume-already-exists/);
  assert.throws(() => assertStorageVolumeAbsent({ exists: false, name: 'protected-volume' }), /volume-name/);
  assert.equal(validateStorageVolume({
    name: runtime.volumeName,
    driver: 'local',
    labels: { 'org.jt-studio.project': 'jt-studio-blog-tests', 'org.jt-studio.task': 'blog-editorial-task5' },
  }), true);
  assert.throws(() => validateStorageVolume({ name: runtime.volumeName, driver: 'local', labels: {} }), /volume-project-label/);
});

test('initial create preflight preserves full protected IDs and refuses any extra resource or listener', () => {
  const protectedIds = Array.from({ length: 7 }, (_, index) => String(index + 1).repeat(64));
  const protectedVolumeNames = Array.from({ length: 236 }, (_, index) => `protected-volume-${index}`);
  const expectedTaskIds = [
    'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966',
    'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603',
    '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b',
    '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4',
  ];
  const base = {
    expectedProtectedContainerIds: protectedIds,
    expectedProtectedVolumeNames: protectedVolumeNames,
    observedContainerIds: [...protectedIds, ...expectedTaskIds],
    observedVolumeNames: [...protectedVolumeNames, 'supabase_db_jt-studio-blog-tests'],
    observedTaskContainerIds: expectedTaskIds,
    network: {
      id: runtime.networkId,
      name: 'jt-studio-blog-tests-network',
      driver: 'bridge',
      hostBindingIPv4: '127.0.0.1',
      labels: { 'org.jt-studio.project': 'jt-studio-blog-tests' },
    },
    unexpectedListeners: [],
    storageVolumeExists: false,
    storageServiceExists: false,
    storageInitializerExists: false,
  };
  assert.equal(validateStorageInitialPreflight(base), true);
  for (const [key, value] of [
    ['observedContainerIds', [...base.observedContainerIds, 'a'.repeat(64)]],
    ['observedContainerIds', base.observedContainerIds.map((id) => id.slice(0, 12))],
    ['observedVolumeNames', [...base.observedVolumeNames, 'unexpected-volume']],
    ['network', { ...base.network, hostBindingIPv4: '0.0.0.0' }],
    ['unexpectedListeners', [{ host: '0.0.0.0', port: 5000 }]],
    ['storageVolumeExists', true],
    ['storageInitializerExists', true],
  ]) {
    assert.throws(() => validateStorageInitialPreflight({ ...base, [key]: value }));
  }
});

test('resume preflight accepts only the exact failed Storage pair and protected inventory', () => {
  const protectedIds = Array.from({ length: 7 }, (_, index) => String(index + 1).repeat(64));
  const protectedVolumes = Array.from({ length: 236 }, (_, index) => `protected-volume-${index}`);
  const taskIds = [
    'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966',
    'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603',
    '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b',
    '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4',
  ];
  const base = {
    expectedProtectedContainerIds: protectedIds,
    expectedProtectedVolumeNames: protectedVolumes,
    observedContainerIds: [...protectedIds, ...taskIds, STORAGE_RUNTIME_IDENTITY.existingInitializerId, STORAGE_RUNTIME_IDENTITY.existingServiceId],
    observedVolumeNames: [...protectedVolumes, 'supabase_db_jt-studio-blog-tests', runtime.volumeName],
    observedTaskContainerIds: taskIds,
    storage: {
      initializerId: STORAGE_RUNTIME_IDENTITY.existingInitializerId,
      serviceId: STORAGE_RUNTIME_IDENTITY.existingServiceId,
      initializerName: 'supabase_storage_jt-studio-blog-tests-volume-init',
      serviceName: 'supabase_storage_jt-studio-blog-tests',
      volumeName: runtime.volumeName,
      initializerStatus: 'exited', initializerExitCode: 0, initializerOOMKilled: false,
      serviceStatus: 'exited', serviceExitCode: 1, serviceOOMKilled: false,
      initializerVolumeNoCopy: undefined, serviceVolumeNoCopy: undefined,
    },
    network: {
      id: runtime.networkId,
      name: 'jt-studio-blog-tests-network',
      driver: 'bridge',
      hostBindingIPv4: '127.0.0.1',
      labels: { 'org.jt-studio.project': 'jt-studio-blog-tests' },
      attachedIds: [...taskIds],
    },
    unexpectedListeners: [],
    volume: {
      name: runtime.volumeName,
      driver: 'local',
      labels: { 'org.jt-studio.project': 'jt-studio-blog-tests', 'org.jt-studio.task': 'blog-editorial-task5' },
    },
  };
  assert.equal(validateStorageResumePreflight(base), true);
  const restart = structuredClone(base);
  restart.restartService = true;
  restart.storage.serviceExitCode = 255;
  assert.equal(validateStorageResumePreflight(restart), true);
  assert.throws(() => validateStorageResumePreflight({ ...restart, storage: { ...restart.storage, serviceOOMKilled: true } }), /resume-service-state/);
  const running = structuredClone(base);
  running.expectServiceRunning = true;
  running.storage.serviceStatus = 'running';
  running.storage.serviceHealthy = true;
  running.network.attachedIds = [...taskIds, STORAGE_RUNTIME_IDENTITY.existingServiceId];
  assert.equal(validateStorageResumePreflight(running), true);
  const invalid = [
    { ...base, network: { ...base.network, attachedIds: [...taskIds, STORAGE_RUNTIME_IDENTITY.existingServiceId] } },
    { ...base, network: { ...base.network, attachedIds: [...taskIds, 'e'.repeat(64)] } },
    { ...running, network: { ...running.network, attachedIds: [...running.network.attachedIds, 'e'.repeat(64)] } },
    { ...base, observedContainerIds: base.observedContainerIds.map((id) => id === STORAGE_RUNTIME_IDENTITY.existingServiceId ? 'f'.repeat(64) : id) },
    { ...base, observedContainerIds: [...base.observedContainerIds, 'e'.repeat(64)] },
    { ...base, observedVolumeNames: base.observedVolumeNames.filter((name) => name !== runtime.volumeName) },
    { ...base, network: { ...base.network, attachedIds: [...base.network.attachedIds, 'e'.repeat(64)] } },
    { ...base, storage: { ...base.storage, serviceStatus: 'running' } },
    { ...base, storage: { ...base.storage, serviceVolumeNoCopy: true } },
    { ...base, storage: { ...base.storage, initializerVolumeNoCopy: true } },
    { ...base, volume: { ...base.volume, labels: {} } },
  ];
  for (const candidate of invalid) assert.throws(() => validateStorageResumePreflight(candidate));
});

test('resume inspection accepts only legacy guarded containers and a raw empty root-owned mount', () => {
  const imageId = 'sha256:pinned-image-id';
  const common = {
    imageRef: runtime.image,
    imageId,
    labels: { 'org.jt-studio.project': 'jt-studio-blog-tests', 'org.jt-studio.task': 'blog-editorial-task5' },
    status: 'exited',
    oomKilled: false,
    mounts: [{ type: 'volume', name: runtime.volumeName, destination: '/mnt', rw: true, noCopy: undefined }],
    publishedPorts: 0,
    noNewPrivileges: true,
    readOnlyRootfs: true,
    capDrop: ['ALL'],
    restartPolicy: 'no',
  };
  const base = {
    imageId,
    imageDefaults: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0'],
    expectedServiceEnv: { DATABASE_URL: 'postgres://private', SERVICE_KEY: 'sensitive-local-key' },
    service: {
      ...common,
      id: STORAGE_RUNTIME_IDENTITY.existingServiceId,
      name: 'supabase_storage_jt-studio-blog-tests',
      user: '1000:1000',
      networkId: runtime.networkId,
      networkAlias: true,
      networkNames: ['jt-studio-blog-tests-network'],
      commandMatches: true,
      tmpfsMatches: true,
      capAdd: [],
      environment: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0', 'DATABASE_URL=postgres://private', 'SERVICE_KEY=sensitive-local-key'],
      exitCode: 1,
      nanoCpus: 1_000_000_000,
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 256,
    },
    initializer: {
      ...common,
      id: STORAGE_RUNTIME_IDENTITY.existingInitializerId,
      name: 'supabase_storage_jt-studio-blog-tests-volume-init',
      user: '0:0',
      networkMode: 'none',
      networkNames: ['none'],
      exitCode: 0,
      nanoCpus: 1_000_000_000,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      pidsLimit: 16,
      capAdd: ['CHOWN'],
      commandMatches: true,
      environment: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0'],
    },
    archive: { rootName: 'mnt/', entryCount: 1, rootIsDirectory: true, rootUid: 0, rootGid: 0, rootMode: 0o755 },
  };
  assert.equal(validateStorageResumeContainerInspection(base), true);
  const runningInspection = structuredClone(base);
  runningInspection.service.status = 'running';
  runningInspection.service.healthy = true;
  runningInspection.service.exitCode = 0;
  runningInspection.archive = { rootName: 'mnt/', entryCount: 2, rootIsDirectory: true, rootUid: 1000, rootGid: 1000, rootMode: 0o755 };
  assert.equal(validateStorageResumeContainerInspection(runningInspection, { serviceRunning: true }), true);
  assert.throws(() => validateStorageResumeContainerInspection(runningInspection), /resume-service-state/);
  const restartInspection = structuredClone(runningInspection);
  restartInspection.service.status = 'exited';
  restartInspection.service.exitCode = 255;
  assert.equal(validateStorageResumeContainerInspection(restartInspection, { restartService: true }), true);
  assert.throws(() => validateStorageResumeContainerInspection({ ...restartInspection, archive: base.archive }, { restartService: true }), /resume-volume-owner/);

  const unhealthyRunning = structuredClone(runningInspection);
  unhealthyRunning.service.healthy = false;
  assert.throws(() => validateStorageResumeContainerInspection(unhealthyRunning, { serviceRunning: true }), /resume-service-identity/);
  for (const [path, value] of [
    ['service.id', 'f'.repeat(64)],
    ['service.user', '0:0'],
    ['service.networkId', 'other-network'],
    ['service.nanoCpus', 0],
    ['service.publishedPorts', 1],
    ['service.restartPolicy', 'always'],
    ['service.capAdd', ['SYS_ADMIN']],
    ['service.mounts', []],
    ['service.mounts', [{ ...common.mounts[0], noCopy: true }]],
    ['service.networkNames', ['jt-studio-blog-tests-network', 'other-network']],
    ['service.environment', ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0', 'DATABASE_URL=postgres://private', 'SERVICE_KEY=attacker-value']],
    ['service.environment', ['PATH=/usr/local/bin', 'PATH=/usr/local/bin', 'NODE_VERSION=24.11.0', 'DATABASE_URL=postgres://private', 'SERVICE_KEY=sensitive-local-key']],
    ['initializer.environment', ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0', 'EXTRA=unexpected']],
    ['initializer.networkMode', 'bridge'],
    ['initializer.networkNames', []],
    ['initializer.networkNames', ['none', 'unapproved-network']],
    ['initializer.capAdd', []],
    ['initializer.commandMatches', false],
    ['archive.rootUid', 1000],
    ['archive.rootName', 'elsewhere/'],
    ['archive.rootMode', 0o777],
    ['archive.entryCount', 2],
  ]) {
    const changed = structuredClone(base);
    const [object, property] = path.split('.');
    changed[object][property] = value;
    assert.throws(() => validateStorageResumeContainerInspection(changed));
  }
});

test('an extra network attachment blocks the exact Storage start callback', async () => {
  const imageId = 'sha256:pinned-image-id';
  const common = {
    imageRef: runtime.image,
    imageId,
    labels: { 'org.jt-studio.project': 'jt-studio-blog-tests', 'org.jt-studio.task': 'blog-editorial-task5' },
    status: 'exited', oomKilled: false,
    mounts: [{ type: 'volume', name: runtime.volumeName, destination: '/mnt', rw: true }],
    publishedPorts: 0, nanoCpus: 1_000_000_000, noNewPrivileges: true,
    readOnlyRootfs: true, capDrop: ['ALL'], restartPolicy: 'no',
  };
  const inspection = {
    imageId,
    imageDefaults: ['PATH=/usr/local/bin'],
    expectedServiceEnv: { TOKEN: 'sensitive-fixture' },
    service: {
      ...common, id: STORAGE_RUNTIME_IDENTITY.existingServiceId,
      name: 'supabase_storage_jt-studio-blog-tests', user: '1000:1000',
      networkId: runtime.networkId, networkNames: ['jt-studio-blog-tests-network'], networkAlias: true,
      exitCode: 1, commandMatches: true, tmpfsMatches: true, capAdd: [],
      memoryBytes: 768 * 1024 * 1024, memorySwapBytes: 768 * 1024 * 1024, pidsLimit: 256,
      environment: ['PATH=/usr/local/bin', 'TOKEN=sensitive-fixture'],
    },
    initializer: {
      ...common, id: STORAGE_RUNTIME_IDENTITY.existingInitializerId,
      name: 'supabase_storage_jt-studio-blog-tests-volume-init', user: '0:0', networkMode: 'none',
      networkNames: ['none'], exitCode: 0, commandMatches: true, capAdd: ['CHOWN'],
      memoryBytes: 128 * 1024 * 1024, memorySwapBytes: 128 * 1024 * 1024, pidsLimit: 16,
      environment: ['PATH=/usr/local/bin'],
    },
    archive: { rootName: 'mnt/', entryCount: 1, rootIsDirectory: true, rootUid: 0, rootGid: 0, rootMode: 0o755 },
  };
  const starts = [];
  const start = async (id) => { starts.push(id); };
  const extraServiceNetwork = structuredClone(inspection);
  extraServiceNetwork.service.networkNames.push('unapproved-network');
  await assert.rejects(() => startVerifiedStorageContainer(extraServiceNetwork, 'service', start), /resume-service-network/);
  assert.deepEqual(starts, []);

  const extraInitializerNetwork = structuredClone(inspection);
  extraInitializerNetwork.initializer.networkNames.push('unapproved-network');
  await assert.rejects(() => startVerifiedStorageContainer(extraInitializerNetwork, 'initializer', start), /resume-initializer-network/);
  assert.deepEqual(starts, []);

  await startVerifiedStorageContainer(inspection, 'initializer', start);
  assert.deepEqual(starts, [STORAGE_RUNTIME_IDENTITY.existingInitializerId]);
});

test('runtime inspection requires the actual process identity and every security/resource guard', () => {
  const expected = {
    configUser: '1000:1000',
    processUid: 1000,
    processGid: 1000,
    publishedPorts: [],
    networkId: runtime.networkId,
    volumeName: runtime.volumeName,
    nanoCpus: 1_000_000_000,
    memoryBytes: 805_306_368,
    memorySwapBytes: 805_306_368,
    pidsLimit: 256,
    capDrop: ['ALL'],
    volumeNoCopy: true,
    noNewPrivileges: true,
    readOnlyRootfs: true,
  };
  assert.equal(validateStorageServiceInspection(expected), true);
  assert.throws(() => validateStorageServiceInspection({ ...expected, volumeNoCopy: false }, { allowKnownLegacyNoCopy: true }), /volumeNoCopy/);
  assert.equal(validateStorageServiceInspection(
    { ...expected, volumeNoCopy: false },
    { allowKnownLegacyNoCopy: true, containerId: STORAGE_RUNTIME_IDENTITY.existingServiceId },
  ), true);
  assert.throws(() => validateStorageServiceInspection(
    { ...expected, volumeNoCopy: undefined },
    { allowKnownLegacyNoCopy: true, containerId: 'f'.repeat(64) },
  ), /volumeNoCopy/);
  for (const [key, value] of [
    ['processUid', 0],
    ['configUser', '0:0'],
    ['publishedPorts', [{ hostIp: '0.0.0.0', hostPort: 54321 }]],
    ['memoryBytes', 0],
    ['memorySwapBytes', 1_610_612_736],
    ['capDrop', []],
    ['volumeNoCopy', false],
  ]) {
    assert.throws(() => validateStorageServiceInspection({ ...expected, [key]: value }), new RegExp(key));
  }
});
