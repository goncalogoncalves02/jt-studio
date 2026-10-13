import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicDataApi } from '../../src/blog/public-data.js';

const releaseId = '00000000-0000-4000-8000-000000000006';
const postId = '00000000-0000-4000-8000-000000000010';
function validPost() {
  return {
    id: postId, slug: 'cuidados', title: 'Cuidados', excerpt: 'Resumo', serviceId: 1,
    publishedAt: '2026-10-10T12:00:00.000Z', modifiedAt: '2026-10-11T12:00:00.000Z',
    coverMedia: null, media: [], document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto' }] }] },
  };
}
async function withFetch(response, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('a missing pinned index is an error, not a successful empty blog', async () => {
  await withFetch({ ok: false, status: 404 }, async () => {
    await assert.rejects(createPublicDataApi(releaseId).loadPublicIndex(), /could not be loaded \(HTTP 404\)/u);
  });
});

test('public post payloads reject malformed DocumentV1 and unsafe media URLs', async () => {
  const api = createPublicDataApi(releaseId);
  await withFetch({ ok: true, status: 200, async json() { return { ...validPost(), document: { type: 'doc', content: [{ type: 'script' }] } }; } }, async () => {
    await assert.rejects(api.loadPublicPost('cuidados'), /unsupported child node/u);
  });
  const mediaId = '00000000-0000-4000-8000-000000000020';
  const digest = 'b'.repeat(64);
  const media = { id: mediaId, variants: [{ width: 480, height: 320, mime: 'image/webp', byteLength: 1024, sha256: digest,
    objectKey: `public/${mediaId}/480-${digest}.webp`, url: 'https://example.com\\\\evil' }] };
  await withFetch({ ok: true, status: 200, async json() { return { ...validPost(), coverMedia: media }; } }, async () => {
    await assert.rejects(api.loadPublicPost('cuidados'), /unsafe|invalid|unsupported schema/u);
  });
});
