import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedNodeVersion = '24.21.0';
const allowedModes = new Set(['local', 'authorized-preview']);

const requiredFixtures = [
  'tests/fixtures/empty-release.json',
  'tests/fixtures/published-release.json',
  'tests/fixtures/media/iphone-xr-original.HEIC',
  'tests/fixtures/media/oriented.jpg',
  'tests/fixtures/media/alpha.png',
];

function buildSteps(nodeExec) {
  return [
    { name: 'lint', prereqs: [], commands: [['npm', 'run', 'lint']] },
    {
      name: 'fixture-build',
      prereqs: ['fixtures'],
      commands: [
        ['npm', 'run', 'build:fixture'],
        [nodeExec, 'scripts/check-public-artifacts.mjs'],
      ],
    },
    { name: 'unit', prereqs: [], commands: [['npm', 'run', 'test:unit']] },
    {
      name: 'db',
      prereqs: ['daemon'],
      commands: [
        ['npm', 'run', 'test:db'],
        [nodeExec, 'scripts/test-backend.mjs'],
        [nodeExec, 'tests/db/concurrency.mjs'],
        [nodeExec, 'tests/db/admin-session-logout-concurrency.mjs'],
        [nodeExec, 'tests/db/admin-session-refresh-expiry-concurrency.mjs'],
        [nodeExec, 'tests/db/media-session-lock-expiry-concurrency.mjs'],
      ],
    },
    {
      name: 'published-fixtures',
      prereqs: ['fixtures'],
      commands: [
        ['npm', 'run', 'build:fixture:published'],
        [nodeExec, 'scripts/check-public-artifacts.mjs', 'dist/published-fixture/manifest.json'],
      ],
    },
    {
      name: 'legacy',
      prereqs: [],
      commands: [
        ['npm', 'run', 'build:legacy'],
        ['npm', 'run', 'test:legacy'],
      ],
    },
    {
      name: 'browser',
      prereqs: ['browser', 'fixtures'],
      commands: [
        ['npm', 'run', 'test:browser'],
        ['npm', 'run', 'build:fixture:browser'],
        [nodeExec, 'scripts/check-public-artifacts.mjs', 'dist/fixture/manifest.json'],
      ],
    },
    {
      name: 'e2e-full-flow',
      prereqs: ['daemon', 'browser', 'fixtures'],
      commands: [['npm', 'run', 'test:e2e', '--', 'tests/e2e/full-flow.spec.js']],
    },
    {
      name: 'e2e-existing',
      prereqs: ['daemon', 'browser', 'fixtures'],
      commands: [[
        'npm', 'run', 'test:e2e', '--',
        'tests/e2e/session.spec.js',
        'tests/e2e/media.spec.js',
        'tests/e2e/publication.spec.js',
        'tests/e2e/editor.spec.js',
        'tests/e2e/accessibility.spec.js',
      ]],
    },
  ];
}

function checkTcpLoopback(port) {
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolveCheck(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function defaultCheckPrereqs(stage, { rootDir, env }) {
  if (stage === 'node') {
    if (process.versions.node !== expectedNodeVersion) {
      return { ok: false, code: 'missing-node-version' };
    }
    return { ok: true };
  }
  if (stage === 'fixtures') {
    const missing = requiredFixtures.some((rel) => !existsSync(join(rootDir, rel)));
    return missing ? { ok: false, code: 'missing-fixture' } : { ok: true };
  }
  if (stage === 'browser') {
    if (!env.PLAYWRIGHT_BROWSERS_PATH) {
      return { ok: false, code: 'missing-browser' };
    }
    try {
      const { chromium } = await import('@playwright/test');
      const exe = chromium.executablePath();
      if (!exe || !existsSync(exe)) return { ok: false, code: 'missing-browser' };
      return { ok: true };
    } catch {
      return { ok: false, code: 'missing-browser' };
    }
  }
  if (stage === 'daemon') {
    const info = spawnSync(
      'docker',
      ['--context', 'desktop-linux', 'info', '--format', '{{.ServerVersion}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (info.status !== 0 || !info.stdout.trim()) {
      return { ok: false, code: 'missing-daemon' };
    }
    const [apiUp, dbUp] = await Promise.all([checkTcpLoopback(54341), checkTcpLoopback(54342)]);
    if (!apiUp || !dbUp) {
      return { ok: false, code: 'missing-loopback-service' };
    }
    return { ok: true };
  }
  return { ok: true };
}

async function defaultRunStep(step, { rootDir, env }) {
  const startedAt = Date.now();
  for (const [cmd, ...args] of step.commands) {
    const exitCode = await new Promise((resolveExit) => {
      const child = spawn(cmd, args, { cwd: rootDir, env, stdio: 'inherit' });
      child.once('error', () => resolveExit(1));
      child.once('exit', (code) => resolveExit(code ?? 1));
    });
    if (exitCode !== 0) {
      return { ok: false, durationMs: Date.now() - startedAt, errorCode: `exit-${exitCode}` };
    }
  }
  return { ok: true, durationMs: Date.now() - startedAt };
}

function pendingForMode(mode) {
  const base = [
    'remote-ci',
    'iphone-safari-voiceover-manual',
    'production-deploy',
  ];
  if (mode === 'authorized-preview') {
    return ['authorized-https-preview-manual', 'whatsapp-preview-manual', ...base];
  }
  return ['authorized-https-preview', 'whatsapp-preview-manual', ...base];
}

export async function verifyBlog({
  mode = 'local',
  env = process.env,
  rootDir = defaultRoot,
  runStep = defaultRunStep,
  checkPrereqs = defaultCheckPrereqs,
} = {}) {
  const recordedAt = new Date().toISOString();
  const pending = pendingForMode(allowedModes.has(mode) ? mode : 'local');
  if (!allowedModes.has(mode)) {
    return {
      schema: 1,
      mode: String(mode),
      ok: false,
      status: 'invalid-mode',
      setupFailure: { code: 'invalid-mode', stage: 'init' },
      steps: [],
      pending,
      recordedAt,
    };
  }

  const nodeCheck = await checkPrereqs('node', { rootDir, env });
  if (!nodeCheck.ok) {
    return {
      schema: 1,
      mode,
      ok: false,
      status: 'setup-failed',
      setupFailure: { code: nodeCheck.code ?? 'missing-node-version', stage: 'init' },
      steps: [],
      pending,
      recordedAt,
    };
  }

  const steps = buildSteps(process.execPath);
  const results = [];
  const checkedStages = new Map();

  for (const step of steps) {
    let setupError = null;
    for (const prereq of step.prereqs) {
      if (!checkedStages.has(prereq)) {
        checkedStages.set(prereq, await checkPrereqs(prereq, { rootDir, env }));
      }
      const check = checkedStages.get(prereq);
      if (!check.ok) {
        setupError = check.code ?? `missing-${prereq}`;
        break;
      }
    }
    if (setupError) {
      results.push({ name: step.name, status: 'setup-failed', durationMs: 0, errorCode: setupError });
      return {
        schema: 1,
        mode,
        ok: false,
        status: 'setup-failed',
        setupFailure: { code: setupError, stage: step.name },
        steps: results,
        pending,
        recordedAt,
      };
    }

    const outcome = await runStep(step, { rootDir, env });
    if (!outcome.ok) {
      results.push({
        name: step.name,
        status: 'failed',
        durationMs: outcome.durationMs ?? 0,
        errorCode: outcome.errorCode ?? 'gate-failed',
      });
      return {
        schema: 1,
        mode,
        ok: false,
        status: 'failed',
        setupFailure: null,
        steps: results,
        pending,
        recordedAt,
      };
    }
    results.push({ name: step.name, status: 'passed', durationMs: outcome.durationMs ?? 0, errorCode: null });
  }

  return {
    schema: 1,
    mode,
    ok: true,
    status: 'passed',
    setupFailure: null,
    steps: results,
    pending,
    recordedAt,
  };
}

function parseCliMode(argv) {
  if (argv.includes('--authorized-preview')) return 'authorized-preview';
  const modeIndex = argv.indexOf('--mode');
  if (modeIndex >= 0 && argv[modeIndex + 1]) return argv[modeIndex + 1];
  return 'local';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = parseCliMode(process.argv.slice(2));
  const report = await verifyBlog({ mode });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
