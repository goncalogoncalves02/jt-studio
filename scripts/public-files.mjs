import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateDraft } from '../src/blog/content-validate.js';

const RELEASE_KEYS = new Set(['schemaVersion', 'releaseId', 'posts']);
const POST_KEYS = new Set(['id', 'slug', 'title', 'excerpt', 'document', 'coverMedia', 'media', 'serviceId', 'publishedAt', 'modifiedAt']);
const MEDIA_KEYS = new Set(['id', 'variants']);
const VARIANT_KEYS = new Set(['width', 'height', 'mime', 'byteLength', 'sha256', 'objectKey']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_ORIGIN = 'https://jaquelinetakiutistudio.com';
const BLOG_DATA_PREFIX = 'blog-data';

function fail(message) { throw new TypeError(`Invalid public release: ${message}`); }
function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}
function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains an unknown field: ${key}`);
}
function assertIsoDate(value, label) {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)
    : null;
  if (!match || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) fail(`${label} is invalid`);
  return value;
}
function checkedStorageOrigin(value) {
  let origin;
  try { origin = new URL(value); } catch { fail('public Storage origin is invalid'); }
  if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) fail('public Storage origin must be an explicit HTTPS origin');
  return origin.origin;
}
function validatePublicVariant(variant, mediaId, publicStorageOrigin) {
  assertObject(variant, 'media variant');
  assertKeys(variant, VARIANT_KEYS, 'media variant');
  const { width, height, mime, byteLength, sha256, objectKey } = variant;
  if (!Number.isInteger(width) || width < 1 || width > 1600 || !Number.isInteger(height) || height < 1 || height > 1600
      || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > 1_048_576 || mime !== 'image/webp'
      || typeof sha256 !== 'string' || !SHA256.test(sha256)) fail('media variant metadata is invalid');
  if (typeof objectKey !== 'string' || objectKey !== `public/${mediaId}/${width}-${sha256}.webp`) fail('media object key is invalid');
  const url = new URL(`/storage/v1/object/public/blog-public/${objectKey}`, publicStorageOrigin);
  const expectedPath = `/storage/v1/object/public/blog-public/${objectKey}`;
  if (url.pathname !== expectedPath) {
    fail('media URL must be an immutable public blog Storage URL');
  }
  return { width, height, mime, byteLength, sha256, objectKey, url: url.toString() };
}
function validateMedia(media, label, publicStorageOrigin) {
  if (media === null) return null;
  assertObject(media, label);
  assertKeys(media, MEDIA_KEYS, label);
  if (typeof media.id !== 'string' || !UUID.test(media.id) || !Array.isArray(media.variants) || media.variants.length < 1 || media.variants.length > 3) {
    fail(`${label} identity or variants are invalid`);
  }
  const variants = media.variants.map((variant) => validatePublicVariant(variant, media.id, publicStorageOrigin));
  const widths = variants.map((variant) => variant.width);
  if (widths.some((width, index) => index > 0 && width <= widths[index - 1])) fail(`${label} widths must be unique and ascending`);
  const master = variants.at(-1);
  for (const variant of variants) {
    if (variant.height !== Math.max(1, Math.round(master.height * variant.width / master.width))) fail(`${label} aspect ratios are inconsistent`);
  }
  return { id: media.id, variants };
}
function validatePost(post, publicStorageOrigin) {
  assertObject(post, 'post');
  assertKeys(post, POST_KEYS, 'post');
  if (typeof post.id !== 'string' || !UUID.test(post.id)) fail('post id is invalid');
  if (typeof post.slug !== 'string' || !SLUG.test(post.slug) || post.slug.length > 120) fail('post slug is invalid');
  const checked = validateDraft({
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    serviceId: post.serviceId,
    document: post.document,
  });
  const coverMedia = validateMedia(post.coverMedia ?? null, 'cover media', publicStorageOrigin);
  if (post.coverMedia === undefined) fail('cover media must be explicit');
  if (!Array.isArray(post.media)) fail('post media must be an array');
  const media = post.media.map((item) => validateMedia(item, 'post media', publicStorageOrigin));
  const mediaMap = new Map([...media, ...(coverMedia ? [coverMedia] : [])].map((item) => [item.id, item]));
  if (new Set(media.map((item) => item.id)).size !== media.length) fail('post media ids must be unique');
  const checkDocumentMedia = (node) => {
    if (node.type === 'image' && !mediaMap.has(node.attrs.mediaId)) fail('document references missing public media');
    for (const child of node.content ?? []) checkDocumentMedia(child);
  };
  checkDocumentMedia(checked.document);
  return {
    id: post.id,
    slug: checked.slug,
    title: checked.title,
    excerpt: checked.excerpt,
    document: checked.document,
    coverMedia,
    media,
    serviceId: checked.serviceId,
    publishedAt: assertIsoDate(post.publishedAt, 'publishedAt'),
    modifiedAt: assertIsoDate(post.modifiedAt, 'modifiedAt'),
  };
}
function parseRelease(envelope, rawStorageOrigin) {
  assertObject(envelope, 'release envelope');
  if (typeof envelope.releaseId !== 'string' || !UUID.test(envelope.releaseId)
      || typeof envelope.payload !== 'string' || typeof envelope.digest !== 'string' || !SHA256.test(envelope.digest)) fail('release envelope is invalid');
  if (createHash('sha256').update(envelope.payload, 'utf8').digest('hex') !== envelope.digest) fail('stored payload digest does not match the exact payload text');
  let payload;
  try { payload = JSON.parse(envelope.payload); } catch { fail('payload is not JSON'); }
  assertObject(payload, 'payload');
  assertKeys(payload, RELEASE_KEYS, 'payload');
  if (payload.schemaVersion !== 1 || payload.releaseId !== envelope.releaseId || !Array.isArray(payload.posts)) fail('payload schema or release identity is invalid');
  const publicStorageOrigin = checkedStorageOrigin(rawStorageOrigin);
  const posts = payload.posts.map((post) => validatePost(post, publicStorageOrigin));
  if (new Set(posts.map((post) => post.id)).size !== posts.length || new Set(posts.map((post) => post.slug)).size !== posts.length) fail('post ids and slugs must be unique');
  posts.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.slug.localeCompare(b.slug));
  return { posts };
}
function summary(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    coverMedia: post.coverMedia,
    serviceId: post.serviceId,
    publishedAt: post.publishedAt,
    modifiedAt: post.modifiedAt,
  };
}
function safeDeployId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) fail('deploy id is invalid');
  return value;
}

/** Write public JSON from the exact digest-checked SQL payload and separately supplied Storage origin. */
export async function writePublicFiles(release, outDir, deployMeta) {
  const { posts } = parseRelease(release, deployMeta?.publicStorageOrigin);
  const deployId = safeDeployId(deployMeta?.deployId);
  const releaseDir = path.resolve(outDir, BLOG_DATA_PREFIX, release.releaseId);
  const base = path.resolve(outDir, BLOG_DATA_PREFIX);
  if (!releaseDir.startsWith(`${base}${path.sep}`)) fail('release output path is unsafe');
  await mkdir(path.join(releaseDir, 'posts'), { recursive: true });
  const index = posts.map(summary);
  await writeFile(path.join(releaseDir, 'index.json'), `${JSON.stringify(index)}\n`);
  for (const post of posts) {
    const postPath = path.resolve(releaseDir, 'posts', `${post.slug}.json`);
    if (!postPath.startsWith(`${path.join(releaseDir, 'posts')}${path.sep}`)) fail('post output path is unsafe');
    await writeFile(postPath, `${JSON.stringify(post)}\n`);
  }
  const manifest = { releaseId: release.releaseId, deployId, digest: release.digest, schema: 1 };
  await writeFile(path.resolve(outDir, 'blog-release.json'), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

export function publicRoutePaths(release, publicStorageOrigin) {
  const { posts } = parseRelease(release, publicStorageOrigin);
  return posts.map((post) => `/blog/${post.slug}`);
}

export function createPublicPageData(release, route = '/', publicStorageOrigin) {
  const { posts } = parseRelease(release, publicStorageOrigin);
  const index = posts.map(summary);
  if (route === '/blog') return { releaseId: release.releaseId, index, post: null };
  const match = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(route);
  if (match) return { releaseId: release.releaseId, index: [], post: posts.find((post) => post.slug === match[1]) ?? null };
  if (route === '/404') return { releaseId: release.releaseId, index: [], post: null, notFound: true };
  return { releaseId: release.releaseId, index: [], post: null };
}

export { CANONICAL_ORIGIN };
