import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as storageLocal from '../../scripts/supabase-storage-local.mjs';
const { parseListeningSockets, parseStorageFileSizeLimit } = storageLocal;

test('runtime failure reporting exposes only a fixed stage identifier', () => {
  const stage = storageLocal.safeStorageFailureStage ?? (() => undefined);
  assert.equal(stage(new Error('storage-runtime-resume-initializer-network')), 'resume-initializer-network');
  assert.equal(stage(Object.assign(new Error('private-value'), { stage: 'auth-jwks-status' })), 'auth-jwks-status');
  assert.equal(stage(new Error('request failed for https://127.0.0.1/?token=secret')), 'storage-runtime-failed');
  assert.equal(stage(new Error('storage-runtime-DATABASE_URL=secret')), 'storage-runtime-failed');
});

test('service process verification requests PID and parses actual UID/GID without exposing command output', () => {
  const query = storageLocal.storageProcessQueryPath ?? (() => undefined);
  const parse = storageLocal.parseStorageProcessTop ?? (() => undefined);
  const id = '64db731c94b829cd30427a0b30630e5979e17f15d157d297ac13d7fe0a5910e1';
  assert.equal(query(id), `/containers/${id}/top?ps_args=-eo+pid%2Cuid%2Cgid%2Cargs`);
  const payload = {
    Titles: ['PID', 'UID', 'GID', 'COMMAND'],
    Processes: [['43732', '1000', '1000', 'node dist/start/server.js']],
  };
  assert.deepEqual(parse(payload), { processUid: 1000, processGid: 1000 });
  assert.deepEqual(parse({ Titles: ['PID', 'UID', 'GID', 'CMD'], Processes: [['43732', '1000', '1000', 'node dist/start/server.js']] }), { processUid: 1000, processGid: 1000 });
  for (const invalid of [
    { Titles: ['UID', 'GID', 'COMMAND'], Processes: [['1000', '1000', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'UID', 'GID', 'COMMAND'], Processes: [['43732', '1000', '1000', '1000', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'GID', 'COMMAND'], Processes: [['bad', '1000', '1000', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'GID', 'COMMAND'], Processes: [['43732', 'bad', '1000', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'GID', 'COMMAND'], Processes: [['43732', '1000', 'bad', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'GID', 'COMMAND'], Processes: [['43732', '0', '0', 'node dist/start/server.js']] },
    { Titles: ['PID', 'UID', 'GID', 'COMMAND'], Processes: [['43732', '1000', '1000', 'node other-process.js']] },
  ]) assert.throws(() => parse(invalid), /storage-process-inspect/);
  assert.equal(query('f'.repeat(64)), `/containers/${'f'.repeat(64)}/top?ps_args=-eo+pid%2Cuid%2Cgid%2Cargs`);
  for (const id of ['abc', 'A'.repeat(64), `${'a'.repeat(63)}/x`]) assert.throws(() => query(id), /storage-process-container-id/);
});

test('Storage runtime uses the exact configured bucket file-size limit', async () => {
  const source = await readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  assert.equal(parseStorageFileSizeLimit(source), 50 * 1024 * 1024);
  assert.equal(parseStorageFileSizeLimit('[storage]\nfile_size_limit = "8MiB"\n[storage.vector]\nfile_size_limit = "1GiB"'), 8 * 1024 * 1024);
  assert.throws(() => parseStorageFileSizeLimit('[storage]\nfile_size_limit = "bad"'), /storage-file-size-config/);
});

test('listener parser identifies local and wildcard binds for reserved Storage/API ports', () => {
  assert.deepEqual(parseListeningSockets([
    'LISTEN 0 4096 127.0.0.1:54341 0.0.0.0:*',
    'LISTEN 0 4096 0.0.0.0:5000 0.0.0.0:*',
    'LISTEN 0 4096 [::]:5001 [::]:*',
    'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*',
  ].join('\n')), [
    { host: '127.0.0.1', port: 54341 },
    { host: '0.0.0.0', port: 5000 },
    { host: '::', port: 5001 },
    { host: '127.0.0.53', port: 53 },
  ]);
});

test('capacity parser reads the single requested DB volume row when Docker Desktop reports its host mountpoint', () => {
  const output = [
    'Filesystem           1024-blocks    Used Available Capacity Mounted on',
    '/dev/vda1             65739412  44101348  18256240  71% /etc/hostname',
  ].join('\n');
  const parse = storageLocal.parseDataVolumeAvailableKiB ?? (() => undefined);
  assert.equal(parse(output), 18256240);
});

test('capacity gate keeps the two-GiB minimum and rejects malformed or ambiguous df output', () => {
  const parse = storageLocal.parseDataVolumeAvailableKiB ?? (() => undefined);
  const validate = storageLocal.validateStorageCapacityKiB ?? (() => undefined);
  const header = 'Filesystem           1024-blocks    Used Available Capacity Mounted on';
  assert.throws(() => validate(parse(`${header}\n/dev/vda1 65739412 64000000 1739412 98% /etc/hostname`)), /disk-capacity/);
  assert.throws(() => parse(header), /disk-capacity-output/);
  assert.throws(() => parse(`${header}\n/dev/vda1 65739412 44101348 nope 71% /etc/hostname`), /disk-capacity-output/);
  assert.throws(() => parse(`${header}\n/dev/vda1 65739412 44101348 18256240 71% /etc/hostname\n/dev/vda2 1 1 1 1% /tmp`), /disk-capacity-output/);
});

test('raw Docker archive parser proves the exact empty volume root metadata', () => {
  function header({ name = 'mnt/', mode = 0o755, uid = 0, gid = 0, size = 0, type = '5' } = {}) {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, 'utf8');
    block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    block.write(`${uid.toString(8).padStart(7, '0')}\0`, 108, 8, 'ascii');
    block.write(`${gid.toString(8).padStart(7, '0')}\0`, 116, 8, 'ascii');
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    block.fill(0x20, 148, 156);
    block[156] = type.charCodeAt(0);
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of block) checksum += byte;
    block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return block;
  }
  const parse = storageLocal.parseStorageMountArchive ?? (() => undefined);
  const valid = Buffer.concat([header(), Buffer.alloc(1024)]);
  assert.deepEqual(parse(valid), {
    rootName: 'mnt/', entryCount: 1, rootIsDirectory: true, rootUid: 0, rootGid: 0, rootMode: 0o755,
  });
  assert.equal(parse(Buffer.concat([header({ uid: 1000, gid: 1000 }), Buffer.alloc(1024)])).rootUid, 1000);
  assert.equal(parse(Buffer.concat([header(), header({ name: 'mnt/file', type: '0', size: 0 }), Buffer.alloc(1024)])).entryCount, 2);
  for (const invalid of [Buffer.alloc(512), Buffer.from('not a tar archive'), Buffer.concat([header(), Buffer.alloc(512)])]) {
    assert.throws(() => parse(invalid), /storage-volume-archive/);
  }
});

test('pinned Storage image inspection accepts an absent or empty optional Config.User', () => {
  const validate = storageLocal.validatePinnedImageInspection ?? (() => undefined);
  const base = {
    Id: 'sha256:image',
    Os: 'linux',
    Architecture: 'amd64',
    RepoDigests: ['supabase/storage-api@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154'],
    Config: { Entrypoint: ['docker-entrypoint.sh'], Cmd: ['node', 'dist/start/server.js'], Env: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0'] },
  };
  assert.deepEqual(validate(JSON.stringify(base)), {
    imageId: 'sha256:image',
    repoDigests: base.RepoDigests,
    platform: 'linux/amd64',
    configuredUser: '',
    defaultEnv: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0'],
  });
  assert.equal(validate(JSON.stringify({ ...base, Config: { ...base.Config, User: '' } })).configuredUser, '');
});

test('pinned Storage image inspection rejects nonempty user and malformed inspection JSON', () => {
  const validate = storageLocal.validatePinnedImageInspection ?? (() => undefined);
  const base = {
    Id: 'sha256:image',
    Os: 'linux',
    Architecture: 'amd64',
    RepoDigests: ['supabase/storage-api@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154'],
    Config: { Entrypoint: ['docker-entrypoint.sh'], Cmd: ['node', 'dist/start/server.js'], Env: ['PATH=/usr/local/bin', 'NODE_VERSION=24.11.0'] },
  };
  assert.throws(() => validate(JSON.stringify({ ...base, Config: { ...base.Config, User: 'root' } })), /image-identity/);
  assert.throws(() => validate('{'), /image-inspect-json/);
  assert.throws(() => validate(JSON.stringify({ ...base, Config: { ...base.Config, User: 1000 } })), /image-identity/);
});
