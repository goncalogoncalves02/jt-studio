import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBlog } from '../../scripts/verify-blog.mjs';

test('verifyBlog rejects unsupported mode without running steps', async () => {
  const executed = [];
  const report = await verifyBlog({
    mode: 'remote-auto',
    runStep: async (step) => {
      executed.push(step.name);
      return { ok: true, durationMs: 1 };
    },
    checkPrereqs: async () => ({ ok: true }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'invalid-mode');
  assert.equal(report.setupFailure.code, 'invalid-mode');
  assert.deepEqual(executed, []);
});

test('verifyBlog runs all gates in exact order and records pending remote/device gates', async () => {
  const executed = [];
  const report = await verifyBlog({
    mode: 'local',
    runStep: async (step) => {
      executed.push(step.name);
      return { ok: true, durationMs: 5 };
    },
    checkPrereqs: async () => ({ ok: true }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, 'passed');
  assert.equal(report.setupFailure, null);
  assert.deepEqual(executed, [
    'lint',
    'fixture-build',
    'unit',
    'db',
    'published-fixtures',
    'legacy',
    'browser',
    'e2e-full-flow',
    'e2e-existing',
  ]);
  assert.ok(report.pending.includes('remote-ci'));
  assert.ok(report.pending.includes('whatsapp-preview-manual'));
  assert.ok(report.pending.includes('iphone-safari-voiceover-manual'));
  assert.ok(report.pending.includes('production-deploy'));
});

test('verifyBlog classifies local setup failure distinctly without skipping', async () => {
  const executed = [];
  const report = await verifyBlog({
    mode: 'local',
    runStep: async (step) => {
      executed.push(step.name);
      return { ok: true, durationMs: 2 };
    },
    checkPrereqs: async (stage) => {
      if (stage === 'daemon') return { ok: false, code: 'missing-daemon' };
      return { ok: true };
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, 'setup-failed');
  assert.deepEqual(report.setupFailure, { code: 'missing-daemon', stage: 'db' });
  assert.deepEqual(executed, ['lint', 'fixture-build', 'unit']);
  const dbStep = report.steps.find((s) => s.name === 'db');
  assert.equal(dbStep.status, 'setup-failed');
  assert.equal(dbStep.errorCode, 'missing-daemon');
});

test('verifyBlog authorized-preview mode never invokes remote CLI and records manual preview gates', async () => {
  const commands = [];
  const report = await verifyBlog({
    mode: 'authorized-preview',
    runStep: async (step) => {
      commands.push(...step.commands.map((c) => c.join(' ')));
      return { ok: true, durationMs: 1 };
    },
    checkPrereqs: async () => ({ ok: true }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'authorized-preview');
  assert.equal(commands.some((cmd) => /netlify\s+deploy|supabase\s+link|build_hooks/i.test(cmd)), false);
  assert.ok(report.pending.includes('authorized-https-preview-manual'));
  assert.ok(report.pending.includes('whatsapp-preview-manual'));
});
