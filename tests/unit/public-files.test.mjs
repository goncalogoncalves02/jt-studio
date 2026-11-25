import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writePublicFiles } from '../../scripts/public-files.mjs';

const releaseId = '00000000-0000-4000-8000-000000000006';
const publicVariant = {
  width: 480,
  height: 320,
  mime: 'image/webp',
  byteLength: 1024,
  sha256: 'b'.repeat(64),
  objectKey: 'public/00000000-0000-4000-8000-000000000010/480-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
};
function post(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    slug: 'cuidados-sobrancelha',
    title: 'Cuidados depois da sessão',
    excerpt: 'O que esperar e como cuidar.',
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Corpo sentinela único.' }] }] },
    coverMedia: { id: '00000000-0000-4000-8000-000000000010', variants: [publicVariant] },
    media: [],
    serviceId: 1,
    publishedAt: '2026-10-10T12:00:00.000Z',
    modifiedAt: '2026-10-11T12:00:00.000Z',
    ...overrides,
  };
}
function release(posts = [post()]) {
  const payload = JSON.stringify({ schemaVersion: 1, releaseId, posts });
  return { releaseId, digest: createHash('sha256').update(payload, 'utf8').digest('hex'), payload };
}

async function withOutput(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jt-public-files-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('writes a public index without article bodies and separate route posts from the exact release', async () => {
  await withOutput(async (outDir) => {
    const inputRelease = release([post(), post({
      id: '00000000-0000-4000-8000-000000000011', slug: 'nanoblading', title: '</script><script>alert(1)</script>',
      publishedAt: '2026-10-09T12:00:00.000Z', modifiedAt: '2026-10-12T12:00:00.000Z', coverMedia: null,
    })]);
    const manifest = await writePublicFiles(inputRelease, outDir, { deployId: 'local-fixture', publicStorageOrigin: 'https://project.supabase.co' });
    assert.deepEqual(manifest, { releaseId, deployId: 'local-fixture', digest: inputRelease.digest, schema: 1 });
    const index = JSON.parse(await readFile(path.join(outDir, 'blog-data', releaseId, 'index.json'), 'utf8'));
    assert.deepEqual(index.map((item) => item.slug), ['cuidados-sobrancelha', 'nanoblading']);
    assert.ok(index.every((item) => !('document' in item)));
    const article = JSON.parse(await readFile(path.join(outDir, 'blog-data', releaseId, 'posts', 'cuidados-sobrancelha.json'), 'utf8'));
    assert.equal(article.document.content[0].content[0].text, 'Corpo sentinela único.');
    assert.equal(article.coverMedia.variants[0].url, `https://project.supabase.co/storage/v1/object/public/blog-public/${publicVariant.objectKey}`);
    const exposed = await readFile(path.join(outDir, 'blog-release.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(exposed)).sort(), ['deployId', 'digest', 'releaseId', 'schema']);
    assert.ok(!exposed.includes('document'));
  });
});

test('fails closed for unsupported releases, unsafe slugs, and private media URLs', async () => {
  await withOutput(async (outDir) => {
    await assert.rejects(writePublicFiles({ ...release(), payload: '{broken' }, outDir, { deployId: 'test', publicStorageOrigin: 'https://project.supabase.co' }));
    const unsafeSlug = post({ slug: '../secrets' });
    await assert.rejects(writePublicFiles(release([unsafeSlug]), outDir, { deployId: 'test', publicStorageOrigin: 'https://project.supabase.co' }));
    const mediaId = '00000000-0000-4000-8000-000000000020';
    const privateMedia = post({ coverMedia: { id: mediaId, variants: [{ ...publicVariant,
      objectKey: `public/${mediaId}/480-${'b'.repeat(64)}.webp`,
      url: 'https://project.supabase.co/storage/v1/object/sign/blog-drafts/draft/file.webp?token=secret',
    }] } });
    await assert.rejects(writePublicFiles(release([privateMedia]), outDir, { deployId: 'test', publicStorageOrigin: 'https://project.supabase.co' }));
  });
});

test('derives public URLs outside the immutable SQL payload and preserves its exact digest', async () => {
  await withOutput(async (outDir) => {
    const snapshot = release([post()]);
    assert.equal(JSON.parse(snapshot.payload).posts[0].coverMedia.variants[0].url, undefined);
    const manifest = await writePublicFiles(snapshot, outDir, { deployId: 'local-fixture', publicStorageOrigin: 'https://project.supabase.co' });
    assert.equal(manifest.digest, createHash('sha256').update(snapshot.payload, 'utf8').digest('hex'));
    const article = JSON.parse(await readFile(path.join(outDir, 'blog-data', releaseId, 'posts', 'cuidados-sobrancelha.json'), 'utf8'));
    assert.equal(article.coverMedia.variants[0].url, `https://project.supabase.co/storage/v1/object/public/blog-public/${publicVariant.objectKey}`);
  });
});
