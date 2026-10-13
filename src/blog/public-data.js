import { validateDraft } from './content-validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SUMMARY_KEYS = new Set(['id', 'slug', 'title', 'excerpt', 'coverMedia', 'serviceId', 'publishedAt', 'modifiedAt']);
const POST_KEYS = new Set([...SUMMARY_KEYS, 'document', 'media']);

function assertReleaseId(releaseId) {
  if (typeof releaseId !== 'string' || !UUID.test(releaseId)) throw new TypeError('Public release identity is invalid.');
}

function assertResponse(ok, status, resource) {
  if (!ok) throw new Error(`Public ${resource} could not be loaded (HTTP ${status}).`);
  return true;
}

function assertIndex(value) {
  if (!Array.isArray(value)) throw new TypeError('Public blog index has an unsupported schema.');
  const slugs = new Set();
  return value.map((post) => {
    if (!post || typeof post !== 'object' || Array.isArray(post)
        || Object.keys(post).some((key) => !SUMMARY_KEYS.has(key))
        || typeof post.id !== 'string' || !UUID.test(post.id)
        || typeof post.slug !== 'string' || !SLUG.test(post.slug)
        || typeof post.title !== 'string' || typeof post.excerpt !== 'string'
        || (post.serviceId !== null && (!Number.isInteger(post.serviceId) || post.serviceId < 1 || post.serviceId > 6))
        || !isIsoDate(post.publishedAt) || !isIsoDate(post.modifiedAt)
        || !Object.hasOwn(post, 'coverMedia') || slugs.has(post.slug)) {
      throw new TypeError('Public blog index has an unsupported schema.');
    }
    assertPublicMedia(post.coverMedia);
    slugs.add(post.slug);
    return post;
  });
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function assertPublicMedia(value) {
  if (value === null) return;
  const mediaKeys = new Set(['id', 'variants']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !mediaKeys.has(key))
      || typeof value.id !== 'string' || !UUID.test(value.id) || !Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 3) {
    throw new TypeError('Public blog post has an unsupported schema.');
  }
  const widths = [];
  for (const variant of value.variants) {
    const expectedKeys = new Set(['width', 'height', 'mime', 'byteLength', 'sha256', 'objectKey', 'url']);
    if (!variant || typeof variant !== 'object' || Array.isArray(variant) || Object.keys(variant).some((key) => !expectedKeys.has(key))
        || !Number.isInteger(variant.width) || variant.width < 1 || variant.width > 1600
        || !Number.isInteger(variant.height) || variant.height < 1 || variant.height > 1600
        || variant.mime !== 'image/webp' || !Number.isInteger(variant.byteLength) || variant.byteLength < 1 || variant.byteLength > 1_048_576
        || typeof variant.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(variant.sha256)
        || variant.objectKey !== `public/${value.id}/${variant.width}-${variant.sha256}.webp`) throw new TypeError('Public blog media has an unsupported schema.');
    let url;
    try { url = new URL(variant.url); } catch { throw new TypeError('Public blog media URL is invalid.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || url.pathname !== `/storage/v1/object/public/blog-public/${variant.objectKey}`
        || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new TypeError('Public blog media URL is unsafe.');
    widths.push(variant.width);
  }
  if (widths.some((width, index) => index > 0 && width <= widths[index - 1])) throw new TypeError('Public blog media variants are unordered.');
  const master = value.variants.at(-1);
  if (value.variants.some((variant) => variant.height !== Math.max(1, Math.round(master.height * variant.width / master.width)))) {
    throw new TypeError('Public blog media dimensions are inconsistent.');
  }
}

function assertPost(value, slug, releaseId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !POST_KEYS.has(key))
      || typeof value.id !== 'string' || !UUID.test(value.id)
      || value.slug !== slug || value.releaseId && value.releaseId !== releaseId
      || typeof value.title !== 'string' || typeof value.excerpt !== 'string'
      || !Array.isArray(value.media) || !Object.hasOwn(value, 'coverMedia')
      || (value.serviceId !== null && (!Number.isInteger(value.serviceId) || value.serviceId < 1 || value.serviceId > 6))
      || !isIsoDate(value.publishedAt) || !isIsoDate(value.modifiedAt)) {
    throw new TypeError('Public blog post has an unsupported schema.');
  }
  validateDraft({ title: value.title, slug: value.slug, excerpt: value.excerpt, serviceId: value.serviceId, document: value.document });
  assertPublicMedia(value.coverMedia);
  value.media.forEach(assertPublicMedia);
  const allMedia = [...value.media, ...(value.coverMedia ? [value.coverMedia] : [])];
  if (new Set(value.media.map((media) => media?.id)).size !== value.media.length
      || new Set(allMedia.map((media) => media?.id)).size !== allMedia.length) throw new TypeError('Public post media identities are duplicated.');
  const mediaIds = new Set([...value.media, ...(value.coverMedia ? [value.coverMedia] : [])].map((media) => media?.id));
  const verifyReferences = (node) => {
    if (node.type === 'image' && !mediaIds.has(node.attrs?.mediaId)) throw new TypeError('Public post references missing media.');
    (node.content ?? []).forEach(verifyReferences);
  };
  verifyReferences(value.document);
  return value;
}

/** Create loaders pinned to one immutable release selected by the routed HTML. */
export function createPublicDataApi(releaseId) {
  if (!releaseId) return Object.freeze({
    async loadPublicIndex() { throw new Error('No public release is available.'); },
    async loadPublicPost() { throw new Error('No public release is available.'); },
  });
  assertReleaseId(releaseId);
  const base = `/blog-data/${encodeURIComponent(releaseId)}`;
  return Object.freeze({
    async loadPublicIndex({ signal } = {}) {
      const response = await fetch(`${base}/index.json`, { signal, cache: 'force-cache', headers: { accept: 'application/json' } });
      assertResponse(response.ok, response.status, 'blog index');
      return assertIndex(await response.json());
    },
    async loadPublicPost(slug, { signal } = {}) {
      if (typeof slug !== 'string' || !SLUG.test(slug)) return null;
      const response = await fetch(`${base}/posts/${encodeURIComponent(slug)}.json`, { signal, cache: 'force-cache', headers: { accept: 'application/json' } });
      if (response.status === 404) return null;
      assertResponse(response.ok, response.status, 'blog post');
      return assertPost(await response.json(), slug, releaseId);
    },
  });
}
