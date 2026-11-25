import assert from 'node:assert/strict';
import test from 'node:test';
import { AutosaveController } from '../../src/admin/autosave.js';

const deferred = () => Promise.withResolvers();

test('older_save_response_cannot_overwrite_newer_text or start a concurrent write', async () => {
  const first = deferred();
  const sent = [];
  const states = [];
  const autosave = new AutosaveController({
    debounceMs: 60_000,
    onState: (state) => states.push(state),
    save: (draft) => { sent.push(draft); return sent.length === 1 ? first.promise : Promise.resolve({ revision: 2 }); },
  });
  autosave.change('primeiro');
  const flush = autosave.flush();
  autosave.change('último');
  assert.deepEqual(sent, ['primeiro']);
  first.resolve({ revision: 1, text: 'primeiro' });
  assert.equal(await flush, true);
  assert.deepEqual(sent, ['primeiro', 'último']);
  assert.equal(states.filter((state) => state === 'saved').length, 1);
  autosave.dispose();
});

test('a conflict stops writes and retains the latest draft for an explicit retry', async () => {
  const sent = [];
  const states = [];
  const autosave = new AutosaveController({
    debounceMs: 60_000,
    onState: (state) => states.push(state),
    save: async (draft) => {
      sent.push(draft);
      if (sent.length === 1) throw Object.assign(new Error('conflict'), { code: 'BLOG_STALE_REVISION' });
    },
  });
  autosave.change('local');
  assert.equal(await autosave.flush(), false);
  autosave.change('local mais recente');
  assert.equal(states.at(-1), 'conflict');
  assert.equal(await autosave.flush(), false);
  assert.deepEqual(sent, ['local']);
  assert.equal(await autosave.retry(), true);
  assert.deepEqual(sent, ['local', 'local mais recente']);
  autosave.dispose();
});

test('disposal ignores in-flight completion and drops queued changes', async () => {
  const transport = deferred();
  const sent = [];
  const states = [];
  const autosave = new AutosaveController({
    debounceMs: 60_000,
    onState: (state) => states.push(state),
    save: (draft) => { sent.push(draft); return transport.promise; },
  });
  autosave.change('canal anterior');
  const flush = autosave.flush();
  autosave.change('ainda não enviado');
  autosave.dispose();
  const prior = states.length;
  transport.resolve({ revision: 1 });
  assert.equal(await flush, false);
  assert.deepEqual(sent, ['canal anterior']);
  assert.equal(states.length, prior);
});
