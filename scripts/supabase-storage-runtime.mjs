const STORAGE_IMAGE = 'supabase/storage-api:v1.79.36@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154';
const STORAGE_NETWORK_ID = '4a414b5db8a0304cff2b69a0bddb391614d409125f9981ab8202f6685d805585';
const STORAGE_VOLUME = 'supabase_storage_jt-studio-blog-tests';
const STORAGE_NAME = 'supabase_storage_jt-studio-blog-tests';
const INIT_NAME = `${STORAGE_NAME}-volume-init`;
const PROJECT_LABEL = 'jt-studio-blog-tests';
const TASK_LABEL = 'blog-editorial-task5';
const STORAGE_UID = 1000;
const STORAGE_GID = 1000;
const MIB = 1024 * 1024;
// These are the only pre-NoCopy containers eligible for the one-time recovery path.
const STORAGE_SERVICE_ID = '64db731c94b829cd30427a0b30630e5979e17f15d157d297ac13d7fe0a5910e1';
const STORAGE_INITIALIZER_ID = 'fc07c13392c9b099a44ac67f3d175dd87980513a907596b62c71fd01774417bc';

const STORAGE_COMMAND = Object.freeze(['node', 'dist/start/server.js']);
const TASK_CONTAINERS = Object.freeze({
  db: Object.freeze({ id: 'bf0489cbc54c05f4471c27ea5ffdf46f550f2bfc130435ceaeddb81832374966', name: 'supabase_db_jt-studio-blog-tests' }),
  rest: Object.freeze({ id: 'fe6fe45271cc83e2a8e313368cf164e808b42ed5f483aa7c95891f14620c6603', name: 'supabase_rest_jt-studio-blog-tests' }),
  auth: Object.freeze({ id: '74b1a1b7a663d91e1e528acd627dd4567fb1404f3879a30a6903236e42c52f5b', name: 'supabase_auth_jt-studio-blog-tests' }),
  kong: Object.freeze({ id: '41acd76b29e5249a183b3da844de522b6ec7d9f54769c06a50b11c8d8efb8bb4', name: 'supabase_kong_jt-studio-blog-tests' }),
});
const STORAGE_ENV_KEYS = new Set([
  'DB_MIGRATIONS_FREEZE_AT', 'ANON_KEY', 'SERVICE_KEY', 'AUTH_JWT_SECRET', 'JWT_JWKS',
  'DATABASE_URL', 'FILE_SIZE_LIMIT', 'STORAGE_BACKEND', 'FILE_STORAGE_BACKEND_PATH',
  'TENANT_ID', 'STORAGE_S3_REGION', 'GLOBAL_S3_BUCKET', 'ENABLE_IMAGE_TRANSFORMATION',
  'IMAGE_TRANSFORMATION_ENABLED', 'IMGPROXY_URL', 'TUS_URL_PATH', 'S3_PROTOCOL_ENABLED',
  'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'S3_PROTOCOL_PREFIX',
  'UPLOAD_FILE_SIZE_LIMIT', 'UPLOAD_FILE_SIZE_LIMIT_STANDARD', 'SIGNED_UPLOAD_URL_EXPIRATION_TIME',
  'VECTOR_ENABLED', 'VECTOR_BUCKET_PROVIDER', 'VECTOR_STORE_MIGRATIONS_ENABLED',
  'VECTOR_DATABASE_URL', 'TMPDIR',
]);

export const STORAGE_RUNTIME_IDENTITY = Object.freeze({
  image: STORAGE_IMAGE,
  networkId: STORAGE_NETWORK_ID,
  networkName: 'jt-studio-blog-tests-network',
  volumeName: STORAGE_VOLUME,
  serviceName: STORAGE_NAME,
  initializerName: INIT_NAME,
  storageUid: STORAGE_UID,
  storageGid: STORAGE_GID,
  existingServiceId: STORAGE_SERVICE_ID,
  existingInitializerId: STORAGE_INITIALIZER_ID,
});

function invariant(condition, reason) {
  if (!condition) throw new Error(`storage-runtime-${reason}`);
}

function assertTaskIdentity(input) {
  invariant(input && input.image === STORAGE_IMAGE, 'image');
  invariant(input.networkId === STORAGE_NETWORK_ID, 'network');
  invariant(input.volumeName === STORAGE_VOLUME, 'volume');
}

function copyStorageEnv(env = {}) {
  invariant(env && typeof env === 'object' && !Array.isArray(env), 'env');
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    invariant(STORAGE_ENV_KEYS.has(key), 'env-key');
    invariant(typeof value === 'string' && !/[\0\r\n]/.test(value), 'env-value');
    result[key] = value;
  }
  return result;
}

export function buildStorageServiceSpec(input) {
  assertTaskIdentity(input);
  const env = copyStorageEnv(input.env);
  return Object.freeze({
    name: STORAGE_NAME,
    image: STORAGE_IMAGE,
    user: `${STORAGE_UID}:${STORAGE_GID}`,
    networkId: STORAGE_NETWORK_ID,
    networkAliases: Object.freeze(['storage']),
    ports: Object.freeze([]),
    mounts: Object.freeze([{ type: 'volume', source: STORAGE_VOLUME, target: '/mnt', noCopy: true }]),
    env: Object.freeze(env),
    resources: Object.freeze({
      nanoCpus: 1_000_000_000,
      memoryBytes: 768 * MIB,
      memorySwapBytes: 768 * MIB,
      pidsLimit: 256,
    }),
    security: Object.freeze({
      capDrop: Object.freeze(['ALL']),
      securityOpt: Object.freeze(['no-new-privileges:true']),
      readOnlyRootfs: true,
      tmpfs: Object.freeze({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000' }),
      command: STORAGE_COMMAND,
    }),
  });
}

const OWNERSHIP_ONLY_COMMAND = [
  'node', '-e',
  "const fs=require('node:fs');const node=fs.readFileSync('/etc/passwd','utf8').split('\\n').map(x=>x.split(':')).find(x=>x[0]==='node');if(!node||node[2]!=='1000'||node[3]!=='1000')process.exit(41);const p='/mnt';const before=fs.lstatSync(p);if(!before.isDirectory()||before.uid!==0||before.gid!==0||fs.readdirSync(p).length!==0)process.exit(42);fs.chownSync(p,1000,1000);const after=fs.lstatSync(p);if(after.uid!==1000||after.gid!==1000)process.exit(43);",
];

function labelsForTask() {
  return { 'org.jt-studio.project': PROJECT_LABEL, 'org.jt-studio.task': TASK_LABEL };
}

export function buildStorageInitializerSpec(input) {
  assertTaskIdentity(input);
  return Object.freeze({
    name: INIT_NAME,
    image: STORAGE_IMAGE,
    user: '0:0',
    networkMode: 'none',
    ports: Object.freeze([]),
    mounts: Object.freeze([{ type: 'volume', source: STORAGE_VOLUME, target: '/mnt', noCopy: true }]),
    env: Object.freeze({}),
    resources: Object.freeze({
      nanoCpus: 1_000_000_000,
      memoryBytes: 128 * MIB,
      memorySwapBytes: 128 * MIB,
      pidsLimit: 16,
    }),
    security: Object.freeze({
      capDrop: Object.freeze(['ALL']),
      capAdd: Object.freeze(['CHOWN']),
      securityOpt: Object.freeze(['no-new-privileges:true']),
      readOnlyRootfs: true,
      command: Object.freeze([...OWNERSHIP_ONLY_COMMAND]),
    }),
  });
}

export function assertStorageVolumeAbsent(observed) {
  invariant(observed?.exists === false, 'volume-already-exists');
  invariant(observed?.name === STORAGE_VOLUME, 'volume-name');
  return true;
}

export function validateStorageInitialPreflight(input) {
  invariant(input && typeof input === 'object', 'preflight-input');
  const protectedIds = input.expectedProtectedContainerIds;
  const protectedVolumes = input.expectedProtectedVolumeNames;
  invariant(Array.isArray(protectedIds) && protectedIds.length === 7
    && protectedIds.every((id) => /^[0-9a-f]{64}$/.test(id)), 'protected-container-baseline');
  invariant(Array.isArray(protectedVolumes) && protectedVolumes.length === 236
    && protectedVolumes.every((name) => typeof name === 'string' && name.length > 0), 'protected-volume-baseline');
  const expectedIds = [...protectedIds, ...Object.values(TASK_CONTAINERS).map(({ id }) => id)];
  invariant(sameMembers(expectedIds, input.observedContainerIds), 'container-inventory');
  const expectedVolumes = [...protectedVolumes, 'supabase_db_jt-studio-blog-tests'];
  invariant(sameMembers(expectedVolumes, input.observedVolumeNames), 'volume-inventory');
  invariant(sameMembers(Object.values(TASK_CONTAINERS).map(({ id }) => id), input.observedTaskContainerIds), 'task-container-ids');
  invariant(input.network?.id === STORAGE_NETWORK_ID
    && input.network?.name === 'jt-studio-blog-tests-network'
    && input.network?.driver === 'bridge'
    && input.network?.hostBindingIPv4 === '127.0.0.1'
    && input.network?.labels?.['org.jt-studio.project'] === PROJECT_LABEL, 'network-inventory');
  invariant(Array.isArray(input.unexpectedListeners) && input.unexpectedListeners.length === 0, 'listener-inventory');
  assertStorageVolumeAbsent({ exists: input.storageVolumeExists, name: STORAGE_VOLUME });
  invariant(input.storageServiceExists === false && input.storageInitializerExists === false, 'storage-containers-exist');
  return true;
}

export function validateStorageResumePreflight(input) {
  invariant(input && typeof input === 'object', 'resume-preflight-input');
  const protectedIds = input.expectedProtectedContainerIds;
  const protectedVolumes = input.expectedProtectedVolumeNames;
  invariant(Array.isArray(protectedIds) && protectedIds.length >= 7
    && protectedIds.every((id) => /^[0-9a-f]{64}$/.test(id)), 'protected-container-baseline');
  invariant(Array.isArray(protectedVolumes) && protectedVolumes.length >= 236
    && protectedVolumes.every((name) => typeof name === 'string' && name.length > 0), 'protected-volume-baseline');
  const taskIds = Object.values(TASK_CONTAINERS).map(({ id }) => id);
  invariant(sameMembers([...protectedIds, ...taskIds, STORAGE_INITIALIZER_ID, STORAGE_SERVICE_ID], input.observedContainerIds), 'resume-container-inventory');
  invariant(sameMembers([...protectedVolumes, 'supabase_db_jt-studio-blog-tests', STORAGE_VOLUME], input.observedVolumeNames), 'resume-volume-inventory');
  invariant(sameMembers(taskIds, input.observedTaskContainerIds), 'task-container-ids');
  invariant(input.storage?.initializerId === STORAGE_INITIALIZER_ID
    && input.storage?.serviceId === STORAGE_SERVICE_ID, 'resume-storage-ids');
  invariant(input.storage?.initializerName === INIT_NAME && input.storage?.serviceName === STORAGE_NAME, 'resume-storage-names');
  invariant(input.storage?.volumeName === STORAGE_VOLUME, 'resume-storage-volume-name');
  invariant(input.storage?.initializerStatus === 'exited' && input.storage?.initializerExitCode === 0
    && input.storage?.initializerOOMKilled === false, 'resume-initializer-state');
  if (input.expectServiceRunning === true) {
    invariant(input.storage?.serviceStatus === 'running' && input.storage?.serviceHealthy === true
      && input.storage?.serviceOOMKilled === false, 'resume-service-state');
  } else {
    invariant(input.storage?.serviceStatus === 'exited' && (input.restartService ? [0, 255].includes(input.storage?.serviceExitCode) : input.storage?.serviceExitCode === 1)
      && input.storage?.serviceOOMKilled === false, 'resume-service-state');
  }
  invariant(input.storage?.serviceVolumeNoCopy === undefined || input.storage?.serviceVolumeNoCopy === false, 'resume-service-nocopy');
  invariant(input.storage?.initializerVolumeNoCopy === undefined || input.storage?.initializerVolumeNoCopy === false, 'resume-initializer-nocopy');
  invariant(input.network?.id === STORAGE_NETWORK_ID
    && input.network?.name === 'jt-studio-blog-tests-network'
    && input.network?.driver === 'bridge'
    && input.network?.hostBindingIPv4 === '127.0.0.1'
    && input.network?.labels?.['org.jt-studio.project'] === PROJECT_LABEL, 'network-inventory');
  const expectedAttachedIds = input.expectServiceRunning === true ? [...taskIds, STORAGE_SERVICE_ID] : taskIds;
  invariant(sameMembers(expectedAttachedIds, input.network.attachedIds), 'resume-network-attachments');
  invariant(Array.isArray(input.unexpectedListeners) && input.unexpectedListeners.length === 0, 'listener-inventory');
  invariant(input.volume?.name === STORAGE_VOLUME && input.volume?.driver === 'local'
    && input.volume?.labels?.['org.jt-studio.project'] === PROJECT_LABEL
    && input.volume?.labels?.['org.jt-studio.task'] === TASK_LABEL, 'resume-volume-identity');
  return true;
}

export function validateStorageResumeContainerInspection(input, { serviceRunning = false, restartService = false } = {}) {
  invariant(input?.service?.id === STORAGE_SERVICE_ID, 'resume-service-id');
  invariant(input?.initializer?.id === STORAGE_INITIALIZER_ID, 'resume-initializer-id');
  invariant(input?.imageId && input.service.imageId === input.imageId && input.initializer.imageId === input.imageId, 'resume-image-id');
  validateEffectiveEnvironment(input.service.environment, input.imageDefaults, input.expectedServiceEnv, 'resume-service-env');
  validateEffectiveEnvironment(input.initializer.environment, input.imageDefaults, {}, 'resume-initializer-env');
  for (const [kind, name, container] of [
    ['service', STORAGE_NAME, input.service],
    ['initializer', INIT_NAME, input.initializer],
  ]) {
    invariant(container.name === name, `resume-${kind}-name`);
    invariant(container.imageRef === STORAGE_IMAGE, `resume-${kind}-image`);
    invariant(container.labels?.['org.jt-studio.project'] === PROJECT_LABEL
      && container.labels?.['org.jt-studio.task'] === TASK_LABEL, `resume-${kind}-labels`);
    const expectedStatus = kind === 'service' && serviceRunning ? 'running' : 'exited';
    invariant(container.status === expectedStatus && container.oomKilled === false, `resume-${kind}-state`);
    invariant(Array.isArray(container.mounts) && container.mounts.length === 1
      && container.mounts[0].type === 'volume'
      && container.mounts[0].name === STORAGE_VOLUME
      && container.mounts[0].destination === '/mnt'
      && container.mounts[0].rw === true
      && (container.mounts[0].noCopy === undefined || container.mounts[0].noCopy === false), `resume-${kind}-mount`);
    invariant(container.publishedPorts === 0, `resume-${kind}-ports`);
    invariant(container.nanoCpus === 1_000_000_000, `resume-${kind}-cpus`);
    invariant(container.memoryBytes === (kind === 'service' ? 768 : 128) * MIB, `resume-${kind}-memory`);
    invariant(container.memorySwapBytes === container.memoryBytes, `resume-${kind}-swap`);
    invariant(container.pidsLimit === (kind === 'service' ? 256 : 16), `resume-${kind}-pids`);
    invariant(Array.isArray(container.capDrop) && container.capDrop.length === 1 && container.capDrop[0] === 'ALL', `resume-${kind}-cap-drop`);
    invariant(container.noNewPrivileges === true && container.readOnlyRootfs === true, `resume-${kind}-security`);
    invariant(container.restartPolicy === 'no', `resume-${kind}-restart-policy`);
  }
  invariant(input.service.user === '1000:1000' && input.service.networkId === STORAGE_NETWORK_ID
    && input.service.networkAlias === true && (serviceRunning ? input.service.healthy === true
      : restartService ? [0, 255].includes(input.service.exitCode) : input.service.exitCode === 1)
    && input.service.commandMatches === true && input.service.tmpfsMatches === true
    && (input.service.capAdd == null || (Array.isArray(input.service.capAdd) && input.service.capAdd.length === 0)), 'resume-service-identity');
  invariant(sameMembers(['jt-studio-blog-tests-network'], input.service.networkNames), 'resume-service-network');
  invariant(input.initializer.user === '0:0' && input.initializer.networkMode === 'none'
    && input.initializer.capAdd?.length === 1 && input.initializer.capAdd[0] === 'CHOWN'
    && input.initializer.exitCode === 0 && input.initializer.commandMatches === true, 'resume-initializer-identity');
  invariant(sameMembers(['none'], input.initializer.networkNames), 'resume-initializer-network');
  if (!serviceRunning && !restartService) {
    invariant(input.archive?.rootName === 'mnt/' && input.archive?.entryCount === 1
      && input.archive?.rootIsDirectory === true && input.archive?.rootUid === (input.expectedArchiveOwner ?? 0)
      && input.archive?.rootGid === (input.expectedArchiveOwner ?? 0) && input.archive?.rootMode === 0o755, 'resume-volume-not-empty-root-owned');
  } else {
    invariant(input.archive?.rootName === 'mnt/' && input.archive?.rootIsDirectory === true
      && input.archive?.rootUid === 1000 && input.archive?.rootGid === 1000 && input.archive?.rootMode === 0o755, 'resume-volume-owner');
  }
  return true;
}

export async function startVerifiedStorageContainer(inspection, kind, start) {
  validateStorageResumeContainerInspection(inspection);
  invariant(typeof start === 'function', 'resume-start-callback');
  if (kind === 'initializer') return start(STORAGE_INITIALIZER_ID);
  if (kind === 'service') return start(STORAGE_SERVICE_ID);
  invariant(false, 'resume-start-kind');
}

function sameMembers(expected, actual) {
  return Array.isArray(actual) && expected.length === actual.length
    && new Set(expected).size === expected.length
    && new Set(actual).size === actual.length
    && [...expected].sort().every((value, index) => value === [...actual].sort()[index]);
}

function parseEnvironmentEntries(entries, reason) {
  invariant(Array.isArray(entries), reason);
  const environment = new Map();
  for (const entry of entries) {
    invariant(typeof entry === 'string' && !/[\0\r\n]/.test(entry), reason);
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    invariant(separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !environment.has(key), reason);
    environment.set(key, entry.slice(separator + 1));
  }
  return environment;
}

function validateEffectiveEnvironment(actualEntries, imageDefaults, overrides, reason) {
  const expected = parseEnvironmentEntries(imageDefaults, reason);
  invariant(overrides && typeof overrides === 'object' && !Array.isArray(overrides), reason);
  for (const [key, value] of Object.entries(overrides)) {
    invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !/[\0\r\n]/.test(value), reason);
    expected.set(key, value);
  }
  const actual = parseEnvironmentEntries(actualEntries, reason);
  invariant(actual.size === expected.size && [...expected].every(([key, value]) => actual.get(key) === value), reason);
}

export function validateStorageVolume(observed) {
  invariant(observed?.name === STORAGE_VOLUME, 'volume-name');
  invariant(observed?.driver === 'local', 'volume-driver');
  invariant(observed?.labels?.['org.jt-studio.project'] === 'jt-studio-blog-tests', 'volume-project-label');
  invariant(observed?.labels?.['org.jt-studio.task'] === 'blog-editorial-task5', 'volume-task-label');
  return true;
}

function dockerServiceCreateBody(spec) {
  return {
    Image: spec.image,
    User: spec.user,
    Cmd: [...spec.security.command],
    Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
    Labels: labelsForTask(),
    Healthcheck: {
      Test: [
        'CMD', 'node', '-e',
        "fetch('http://127.0.0.1:5000/status',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
      ],
      Interval: 10_000_000_000,
      Timeout: 2_000_000_000,
      Retries: 3,
    },
    HostConfig: {
      NetworkMode: STORAGE_NETWORK_ID,
      NanoCpus: 1_000_000_000,
      Memory: 768 * MIB,
      MemorySwap: 768 * MIB,
      PidsLimit: 256,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000' },
      Mounts: [{ Type: 'volume', Source: STORAGE_VOLUME, Target: '/mnt', VolumeOptions: { NoCopy: true } }],
      PortBindings: {},
      PublishAllPorts: false,
      RestartPolicy: { Name: 'no' },
    },
    NetworkingConfig: {
      EndpointsConfig: { 'jt-studio-blog-tests-network': { Aliases: ['storage'] } },
    },
  };
}

function dockerInitializerCreateBody(spec) {
  const [entrypoint, evalFlag, command] = spec.security.command;
  return {
    Image: spec.image,
    User: spec.user,
    Entrypoint: [entrypoint],
    Cmd: [evalFlag, command],
    Env: [],
    Labels: labelsForTask(),
    HostConfig: {
      NetworkMode: 'none',
      NanoCpus: 1_000_000_000,
      Memory: 128 * MIB,
      MemorySwap: 128 * MIB,
      PidsLimit: 16,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Mounts: [{ Type: 'volume', Source: STORAGE_VOLUME, Target: '/mnt', VolumeOptions: { NoCopy: true } }],
      PortBindings: {},
      PublishAllPorts: false,
      RestartPolicy: { Name: 'no' },
    },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sameShape(actual, expected) {
  try { return JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)); }
  catch { return false; }
}

export function buildStorageContainerCreateBody(name, spec) {
  if (name === STORAGE_NAME) {
    invariant(spec?.name === STORAGE_NAME && spec.image === STORAGE_IMAGE, 'create-body-service');
    return dockerServiceCreateBody(spec);
  }
  if (name === INIT_NAME) {
    invariant(spec?.name === INIT_NAME && spec.image === STORAGE_IMAGE, 'create-body-initializer');
    return dockerInitializerCreateBody(spec);
  }
  throw new Error('storage-runtime-create-name');
}

export function validateStorageContainerCreateRequest(name, document, env = {}) {
  try {
    if (name === STORAGE_NAME) {
      const spec = buildStorageServiceSpec({ image: STORAGE_IMAGE, networkId: STORAGE_NETWORK_ID, volumeName: STORAGE_VOLUME, env });
      return sameShape(document, buildStorageContainerCreateBody(name, spec));
    }
    if (name === INIT_NAME) {
      const spec = buildStorageInitializerSpec({ image: STORAGE_IMAGE, networkId: STORAGE_NETWORK_ID, volumeName: STORAGE_VOLUME, env: {} });
      return sameShape(document, buildStorageContainerCreateBody(name, spec));
    }
  } catch { return false; }
  return false;
}

export function validateStorageVolumeCreateRequest(document) {
  return sameShape(document, {
    Name: STORAGE_VOLUME,
    Driver: 'local',
    Labels: labelsForTask(),
  });
}

export function validateStorageServiceInspection(observed, { allowKnownLegacyNoCopy = false, containerId } = {}) {
  invariant(observed?.configUser === '1000:1000', 'configUser');
  invariant(observed?.processUid === STORAGE_UID, 'processUid');
  invariant(observed?.processGid === STORAGE_GID, 'processGid');
  invariant(Array.isArray(observed?.publishedPorts) && observed.publishedPorts.length === 0, 'publishedPorts');
  invariant(observed?.networkId === STORAGE_NETWORK_ID, 'networkId');
  invariant(observed?.volumeName === STORAGE_VOLUME, 'volumeName');
  if (allowKnownLegacyNoCopy && containerId === STORAGE_SERVICE_ID) {
    invariant(observed?.volumeNoCopy === undefined || observed?.volumeNoCopy === false, 'volumeNoCopy');
  } else {
    invariant(observed?.volumeNoCopy === true, 'volumeNoCopy');
  }
  invariant(observed?.nanoCpus === 1_000_000_000, 'nanoCpus');
  invariant(observed?.memoryBytes === 768 * MIB, 'memoryBytes');
  invariant(observed?.memorySwapBytes === 768 * MIB, 'memorySwapBytes');
  invariant(observed?.pidsLimit === 256, 'pidsLimit');
  invariant(Array.isArray(observed?.capDrop) && observed.capDrop.length === 1 && observed.capDrop[0] === 'ALL', 'capDrop');
  invariant(observed?.noNewPrivileges === true, 'noNewPrivileges');
  invariant(observed?.readOnlyRootfs === true, 'readOnlyRootfs');
  return true;
}
