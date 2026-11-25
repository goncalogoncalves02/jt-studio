import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as supabaseLocal from '../../scripts/supabase-local.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import test from 'node:test';

async function fakeDockerSocket() {
  const dir = await mkdtemp(join(tmpdir(), 'jt-blog-cli-capture-test-'));
  const socketPath = join(dir, 'docker.sock');
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
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

test('provides an asynchronous CLI capture helper for proxy-backed commands', () => {
  assert.equal(typeof supabaseLocal.runCliCapture, 'function');
});

test('classifies Docker query failures by a fixed safe operation and exit class', () => {
  assert.equal(supabaseLocal.dockerFactsStage(['container', 'inspect']), 'docker container inspect');
  assert.equal(supabaseLocal.dockerFactsStage(['volume', 'ls']), 'docker volume inventory');
  assert.equal(supabaseLocal.dockerFailureCode({ error: { code: 'ENOENT', message: 'private path' } }), 'DOCKER_ENOENT');
  assert.equal(supabaseLocal.dockerFailureCode({ error: { code: 'PRIVATE', message: 'private path' } }), 'DOCKER_SPAWN_ERROR');
  assert.equal(supabaseLocal.dockerFailureCode({ status: 17, stderr: 'private daemon output' }), 'DOCKER_EXIT_17');
  assert.equal(supabaseLocal.dockerFailureCode({ status: null, signal: 'SIGTERM' }), 'DOCKER_TERMINATED');
});

test('resume inspect projection tolerates REST containers without health metadata', () => {
  const format = supabaseLocal.resumeContainerInspectFormat();
  assert.match(format, /with index \.State "Health"/);
  assert.match(format, /with index \.Config "Healthcheck"/);
  assert.doesNotMatch(format, /\.State\.Health|\.Config\.Healthcheck/);
  const rest = supabaseLocal.parseResumeContainerProjection(
    'a'.repeat(64) + '|/supabase_rest_jt-studio-blog-tests|running|0|false|none|none|{}|{}|{}|[]',
  );
  assert.equal(rest.State.Health, undefined);
  assert.deepEqual(rest.Config, { Labels: {}, Healthcheck: undefined });
});

test('readiness inspect projection handles absent REST health keys and preserves required DB health', () => {
  const format = supabaseLocal.readinessInspectFormat();
  assert.match(format, /with index \.State "Health"/);
  assert.match(format, /with index \.Config "Healthcheck"/);
  assert.doesNotMatch(format, /\.State\.Health|\.Config\.Healthcheck/);
  assert.deepEqual(supabaseLocal.parseReadinessProjection('running|none|none'), {
    status: 'running', health: 'none', healthcheckConfigured: false,
  });
  assert.deepEqual(supabaseLocal.parseReadinessProjection('running|healthy|configured'), {
    status: 'running', health: 'healthy', healthcheckConfigured: true,
  });
});

test('targets only the local pending migration command without a URL or linked mode', () => {
  const args = supabaseLocal.localMigrationArgs('/task/supabase.js', '/task/project');
  assert.deepEqual(args, ['/task/supabase.js', 'migration', 'up', '--local', '--workdir', '/task/project']);
  assert.equal(args.includes('--linked'), false);
  assert.equal(args.includes('--db-url'), false);
});

test('captures a child Docker status response while its proxy shares the parent event loop', async (t) => {
  const upstream = await fakeDockerSocket();
  t.after(() => upstream.close());
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: upstream.socketPath,
    allowedNames: new Set(['supabase_db_jt-studio-blog-tests']),
  });
  t.after(() => proxy.close());
  const proxySocketPath = await proxy.listen();
  const childCode = `import {request} from 'node:http';const req=request({socketPath:process.env.DOCKER_HOST.slice('unix://'.length),path:'/v1.56/info'},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>process.stdout.write(body));});req.on('error',error=>{process.stderr.write(error.code||'request-failed');process.exitCode=1;});req.end();`;

  const result = await supabaseLocal.runCliCapture(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, DOCKER_HOST: `unix://${proxySocketPath}` },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"ok":true}');
  assert.equal(result.stderr, '');
});
