import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BlogMediaError, promoteMedia, readPrivateVariant, uploadVariant, validateWebpVariant } from '../../server/blog/media.mjs';

async function webp(options = {}) {
  return sharp({ create: { width: options.width ?? 40, height: options.height ?? 20, channels: 4, background: '#c04070' } })
    .webp({ quality: 80 })
    .toBuffer();
}

function mediaInvalid(error) { return error?.code === 'BLOG_MEDIA_INVALID' && error.status === 400; }

test('valid WebP is fully decoded and returns canonical dimensions, exact byte length and SHA-256', async () => {
  const bytes = await webp();
  const result = await validateWebpVariant(bytes, { width: 40, height: 20 });
  assert.deepEqual({ width: result.width, height: result.height, byteLength: result.byteLength }, {
    width: 40, height: 20, byteLength: bytes.length,
  });
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.mime, 'image/webp');
});

test('rejects a falsified MIME, truncated bytes, or an upload larger than one MiB', async () => {
  const bytes = await webp();
  await assert.rejects(validateWebpVariant(bytes, { width: 40, height: 20, contentType: 'image/png' }), mediaInvalid);
  await assert.rejects(validateWebpVariant(bytes.subarray(0, bytes.length - 3), { width: 40, height: 20 }), mediaInvalid);
  await assert.rejects(validateWebpVariant(Buffer.alloc(1024 * 1024 + 1), { width: 40, height: 20 }), mediaInvalid);
});

test('rejects declared metadata chunks and claimed dimensions that differ from the decoded image', async () => {
  const bytes = await webp();
  const exif = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#c04070' } })
    .withMetadata({ exif: { IFD0: { ImageDescription: 'private fixture' } } }).webp().toBuffer();
  const xmp = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#c04070' } })
    .withXmp('<x:xmpmeta>private fixture</x:xmpmeta>').webp().toBuffer();
  await assert.rejects(validateWebpVariant(exif, { width: 40, height: 20 }), mediaInvalid);
  await assert.rejects(validateWebpVariant(xmp, { width: 40, height: 20 }), mediaInvalid);
  await assert.rejects(validateWebpVariant(bytes, { width: 41, height: 20 }), mediaInvalid);
});

test('rejects the WebP animation feature bit before accepting a single decoded page', async () => {
  const bytes = await webp();
  const extended = Buffer.alloc(8 + 10);
  extended.write('VP8X', 0, 4, 'ascii');
  extended.writeUInt32LE(10, 4);
  extended[8] = 0x02;
  extended.writeUIntLE(39, 12, 3);
  extended.writeUIntLE(19, 15, 3);
  const chunks = Buffer.concat([extended, bytes.subarray(12)]);
  const animated = Buffer.alloc(12 + chunks.length);
  animated.write('RIFF', 0, 4, 'ascii');
  animated.writeUInt32LE(animated.length - 8, 4);
  animated.write('WEBP', 8, 4, 'ascii');
  chunks.copy(animated, 12);
  await assert.rejects(validateWebpVariant(animated, { width: 40, height: 20 }), mediaInvalid);
});

test('rejects dimensions above the optimized-variant 1600-pixel long-side bound', async () => {
  const bytes = await webp({ width: 1601, height: 1 });
  await assert.rejects(validateWebpVariant(bytes, { width: 1601, height: 1 }), mediaInvalid);
});

test('upload does not report success unless the record-variant RPC returns literal true', async () => {
  const bytes = await webp();
  const auth = {
    userId: '3010b4ba-15c6-4826-a0df-e7f10fc3ca76',
    sessionId: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7',
    generation: 1,
    userSdk: { storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) } },
    serviceClient: { rpc: async () => ({ data: { ok: true }, error: null }) },
  };
  await assert.rejects(uploadVariant(auth, '00000000-0000-4000-8000-000000000305', { width: 40, height: 20 }, bytes, { contentType: 'image/webp' }),
    error => error instanceof BlogMediaError && error.status === 503 && error.code === 'BLOG_MEDIA_UNAVAILABLE');
});

test('private preview revalidates its original app session after the physical download and decode', async () => {
  const bytes = await webp();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const events = [];
  const auth = {
    userId: '3010b4ba-15c6-4826-a0df-e7f10fc3ca76',
    sessionId: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7',
    generation: 3,
    userSdk: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { state: 'complete', variants: [{ width: 40, height: 20, mime: 'image/webp', byteLength: bytes.length, sha256: digest }] }, error: null,
      }) }) }) }),
      storage: { from: bucket => ({ download: async key => {
        events.push(['download', bucket, key]);
        return { data: new Blob([bytes]), error: null };
      } }) },
    },
    serviceClient: { rpc: async (name, parameters) => {
      events.push(['rpc', name, parameters]);
      return { data: false, error: { code: '42501' } };
    } },
  };
  await assert.rejects(readPrivateVariant(auth, '00000000-0000-4000-8000-000000000305', 40), error => error instanceof BlogMediaError && error.status === 403);
  assert.deepEqual(events, [
    ['download', 'blog-drafts', `draft/${auth.userId}/00000000-0000-4000-8000-000000000305/40.webp`],
    ['rpc', 'blog_media_revalidate_session', { p_user_id: auth.userId, p_session_id: auth.sessionId, p_generation: 3 }],
  ]);
});

test('internal promotion writes immutable bytes to the approved public bucket path', async () => {
  const bytes = await webp();
  const mediaId = '00000000-0000-4000-8000-000000000305';
  const userId = '3010b4ba-15c6-4826-a0df-e7f10fc3ca76';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const objectKey = `public/${mediaId}/40-${digest}.webp`;
  const variant = { width: 40, height: 20, mime: 'image/webp', byteLength: bytes.length, sha256: digest, objectKey };
  const uploads = [];
  const serviceClient = {
    rpc: async (name, parameters) => {
      assert.equal(name, 'blog_media_promotion_manifest');
      assert.deepEqual(parameters.p_media_ids, [mediaId]);
      return { data: [{ id: mediaId, owner_id: userId, state: 'complete', variants: [variant] }], error: null };
    },
    storage: { from: bucket => ({
      download: async key => {
        assert.equal(bucket, 'blog-drafts');
        assert.equal(key, `draft/${userId}/${mediaId}/40.webp`);
        return { data: new Blob([bytes]), error: null };
      },
      upload: async (key, body, options) => {
        uploads.push({ bucket, key, bytes: Buffer.from(body), options });
        return { data: {}, error: null };
      },
    }) },
  };
  const result = await promoteMedia({
    userId, sessionId: '2f313aa4-5d8c-4be2-a5ce-e7ed3b577ad7', generation: 1, userSdk: {}, serviceClient,
    config: { supabaseUrl: 'https://project.example.test' },
  }, [mediaId]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bucket, 'blog-public');
  assert.equal(uploads[0].key, objectKey);
  assert.equal(uploads[0].options.upsert, false);
  assert.deepEqual(uploads[0].bytes, bytes);
  assert.equal(result[mediaId][0].url, `https://project.example.test/storage/v1/object/public/blog-public/${objectKey}`);
});
