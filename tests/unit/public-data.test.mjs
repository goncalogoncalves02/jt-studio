import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writePublicFiles } from '../../scripts/public-files.mjs';
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

test('loads SQL-shaped posts whose cover is also used as an inline image', async () => {
  const mediaId = '00000000-0000-4000-8000-000000000020';
  const digest = 'b'.repeat(64);
  const sharedMedia = { id: mediaId, variants: [{ width: 480, height: 320, mime: 'image/webp', byteLength: 1024,
    sha256: digest, objectKey: `public/${mediaId}/480-${digest}.webp` }] };
  const post = {
    ...validPost(),
    coverMedia: sharedMedia,
    media: [sharedMedia],
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto' }] },
      { type: 'image', attrs: { mediaId, alt: 'Fotografia reutilizada' } }] },
  };
  const payload = JSON.stringify({ schemaVersion: 1, releaseId, posts: [post] });
  const release = { releaseId, payload, digest: createHash('sha256').update(payload, 'utf8').digest('hex') };
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'jt-task6-shared-cover-'));
  try {
    await writePublicFiles(release, outDir, { deployId: 'test', publicStorageOrigin: 'https://project.supabase.co' });
    const generated = JSON.parse(await readFile(path.join(outDir, 'blog-data', releaseId, 'posts', 'cuidados.json'), 'utf8'));
    assert.deepEqual(generated.media[0], generated.coverMedia);
    await withFetch({ ok: true, status: 200, async json() { return generated; } }, async () => {
      const loaded = await createPublicDataApi(releaseId).loadPublicPost('cuidados');
      assert.deepEqual(loaded.coverMedia, loaded.media[0]);
      assert.equal(loaded.document.content[1].attrs.mediaId, mediaId);
    });
  } finally { await rm(outDir, { recursive: true, force: true }); }
});

test('rejects duplicate body media and conflicting cover definitions', async () => {
  const mediaId = '00000000-0000-4000-8000-000000000020';
  const digest = 'b'.repeat(64);
  const media = { id: mediaId, variants: [{ width: 480, height: 320, mime: 'image/webp', byteLength: 1024,
    sha256: digest, objectKey: `public/${mediaId}/480-${digest}.webp`,
    url: `https://project.supabase.co/storage/v1/object/public/blog-public/public/${mediaId}/480-${digest}.webp` }] };
  const api = createPublicDataApi(releaseId);
  for (const post of [
    { ...validPost(), media: [media, media] },
    { ...validPost(), coverMedia: media, media: [{ ...media, variants: [{ ...media.variants[0], byteLength: 2048 }] }] },
  ]) {
    await withFetch({ ok: true, status: 200, async json() { return post; } }, async () => {
      await assert.rejects(api.loadPublicPost('cuidados'), /duplicated|conflict/u);
    });
  }
});
