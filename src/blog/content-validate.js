import {
  CONTENT_LIMITS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_NODES,
  MAX_ARTICLE_EXCERPT_LENGTH,
  MAX_ARTICLE_SLUG_LENGTH,
  MAX_ARTICLE_TITLE_LENGTH,
} from './content-schema.js';

const DRAFT_KEYS = new Set(['title', 'slug', 'excerpt', 'serviceId', 'coverMediaId', 'document']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) {
  throw new TypeError(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} has an unknown field or attribute: ${key}`);
  }
}

function textValue(value, label, maxLength) {
  if (typeof value !== 'string') fail(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length > maxLength) fail(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function normalizeLink(href) {
  if (typeof href !== 'string' || !href
      || Array.from(href).some((character) => character === '\\' || character.codePointAt(0) <= 0x20)) {
    fail('link URL is invalid');
  }
  if (href.startsWith('/') && !href.startsWith('//')) return href;

  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    fail('link URL must use an approved scheme or a root-relative path');
  }
  if (['http:', 'https:'].includes(parsed.protocol)) {
    if (!parsed.hostname || parsed.username || parsed.password) fail('HTTP(S) links must not contain credentials');
    return parsed.toString();
  }
  if (parsed.protocol === 'mailto:' && !parsed.hostname && /^[^/?#@]+@[^/?#@]+$/u.test(parsed.pathname)) return parsed.toString();
  if (parsed.protocol === 'tel:' && !parsed.hostname && /^\+?[0-9().-]+$/u.test(parsed.pathname)) return parsed.toString();
  fail('link URL must use HTTP, HTTPS, mailto, tel, or a root-relative path');
}

function normalizeMarks(marks, label) {
  if (marks === undefined) return undefined;
  if (!Array.isArray(marks)) fail(`${label}.marks must be an array`);
  const seen = new Set();
  return marks.map((mark) => {
    assertObject(mark, `${label} mark`);
    if (!['bold', 'italic', 'link'].includes(mark.type)) fail(`${label} has an unsupported mark`);
    if (seen.has(mark.type)) fail(`${label} repeats a mark`);
    seen.add(mark.type);
    if (mark.type === 'link') {
      assertKeys(mark, new Set(['type', 'attrs']), `${label} link mark`);
      assertObject(mark.attrs, `${label} link attributes`);
      assertKeys(mark.attrs, new Set(['href']), `${label} link attributes`);
      return { type: 'link', attrs: { href: normalizeLink(mark.attrs.href) } };
    }
    assertKeys(mark, new Set(['type']), `${label} mark`);
    return { type: mark.type };
  });
}

function normalizeNode(node, state, depth = 0) {
  assertObject(node, 'DocumentV1 node');
  if (depth > 32) fail('DocumentV1 nesting is too deep');
  state.nodes += 1;
  if (state.nodes > MAX_DOCUMENT_NODES) fail('DocumentV1 contains too many nodes');

  const childNodes = (allowedTypes, label) => {
    if (!Array.isArray(node.content)) fail(`${label}.content must be an array`);
    return node.content.map((child) => {
      if (!allowedTypes.includes(child?.type)) fail(`${label} contains an unsupported child node`);
      return normalizeNode(child, state, depth + 1);
    });
  };

  switch (node.type) {
    case 'doc':
      assertKeys(node, new Set(['type', 'content']), 'doc');
      return { type: 'doc', content: childNodes(['paragraph', 'heading', 'bulletList', 'orderedList', 'image'], 'doc') };
    case 'paragraph':
      assertKeys(node, new Set(['type', 'content']), 'paragraph');
      return { type: 'paragraph', content: childNodes(['text', 'hardBreak'], 'paragraph') };
    case 'heading':
      assertKeys(node, new Set(['type', 'attrs', 'content']), 'heading');
      assertObject(node.attrs, 'heading attributes');
      assertKeys(node.attrs, new Set(['level']), 'heading attributes');
      if (!CONTENT_LIMITS.headingLevels.includes(node.attrs.level)) fail('heading level must be H2 or H3');
      return { type: 'heading', attrs: { level: node.attrs.level }, content: childNodes(['text', 'hardBreak'], 'heading') };
    case 'bulletList':
    case 'orderedList':
      assertKeys(node, new Set(['type', 'content']), node.type);
      return { type: node.type, content: childNodes(['listItem'], node.type) };
    case 'listItem':
      assertKeys(node, new Set(['type', 'content']), 'listItem');
      return { type: 'listItem', content: childNodes(['paragraph', 'bulletList', 'orderedList'], 'listItem') };
    case 'text': {
      assertKeys(node, new Set(['type', 'text', 'marks']), 'text');
      if (typeof node.text !== 'string' || node.text.length > MAX_DOCUMENT_BYTES) fail('text node must be bounded text');
      const text = node.text;
      if (!text) fail('text nodes cannot be empty');
      state.textCharacters += text.length;
      state.meaningfulTextCharacters += text.trim().length;
      return { type: 'text', text, ...(node.marks === undefined ? {} : { marks: normalizeMarks(node.marks, 'text node') }) };
    }
    case 'hardBreak':
      assertKeys(node, new Set(['type']), 'hardBreak');
      return { type: 'hardBreak' };
    case 'image': {
      assertKeys(node, new Set(['type', 'attrs']), 'image');
      assertObject(node.attrs, 'image attributes');
      assertKeys(node.attrs, new Set(['mediaId', 'alt', 'caption']), 'image attributes');
      const mediaId = textValue(node.attrs.mediaId, 'image mediaId', 128);
      const alt = textValue(node.attrs.alt, 'image alt', 500);
      const caption = node.attrs.caption === undefined ? undefined : textValue(node.attrs.caption, 'image caption', 500);
      if (!mediaId || !alt) fail('image mediaId and alt text are required');
      state.mediaIds.add(mediaId);
      return { type: 'image', attrs: { mediaId, alt, ...(caption === undefined ? {} : { caption }) } };
    }
    default:
      fail(`DocumentV1 has an unsupported node: ${String(node.type)}`);
  }
}

function normalizeDocument(document) {
  const state = { nodes: 0, textCharacters: 0, meaningfulTextCharacters: 0, mediaIds: new Set() };
  if (document?.type !== 'doc') fail('document must use DocumentV1 doc root');
  const normalized = normalizeNode(document, state);
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_DOCUMENT_BYTES) fail('DocumentV1 exceeds the byte limit');
  return {
    document: normalized,
    mediaIds: state.mediaIds,
    textCharacters: state.textCharacters,
    meaningfulTextCharacters: state.meaningfulTextCharacters,
  };
}

export function validateDraft(input) {
  assertObject(input, 'draft');
  assertKeys(input, DRAFT_KEYS, 'draft');

  const title = textValue(own(input, 'title') ? input.title : '', 'title', MAX_ARTICLE_TITLE_LENGTH);
  const slug = textValue(own(input, 'slug') ? input.slug : '', 'slug', MAX_ARTICLE_SLUG_LENGTH);
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) fail('slug must contain lowercase letters, digits and single hyphens');
  const excerpt = textValue(own(input, 'excerpt') ? input.excerpt : '', 'excerpt', MAX_ARTICLE_EXCERPT_LENGTH);
  const serviceId = input.serviceId ?? null;
  if (serviceId !== null && (!Number.isInteger(serviceId) || !CONTENT_LIMITS.serviceIds.includes(serviceId))) fail('serviceId is invalid');
  const coverMediaId = input.coverMediaId ?? null;
  if (coverMediaId !== null && (typeof coverMediaId !== 'string' || !coverMediaId.trim() || coverMediaId.length > 128)) fail('coverMediaId is invalid');
  const { document } = normalizeDocument(input.document ?? { type: 'doc', content: [] });

  return {
    title,
    slug,
    excerpt,
    serviceId,
    coverMediaId: coverMediaId?.trim() ?? null,
    document,
  };
}

function validateMediaGroup(media, ownerId) {
  if (!media || media.ownerId !== ownerId) fail('media group belongs to another owner');
  if (media.state !== 'complete' || media.pipelineVersion !== 1) fail('media group must be complete at pipeline version 1');
  if (!Array.isArray(media.variants) || media.variants.length === 0) fail('complete media requires public variants');
  const widths = new Set();
  for (const variant of media.variants) {
    assertObject(variant, 'media variant');
    assertKeys(variant, new Set(['width', 'height', 'mime', 'byteLength', 'sha256', 'objectKey']), 'media variant');
    if (!Number.isInteger(variant.width) || variant.width < 1 || variant.width > 1600
      || !Number.isInteger(variant.height) || variant.height < 1 || variant.height > 1600) fail('media variant dimensions must stay within the 1600-pixel output bound');
    if (!Number.isInteger(variant.byteLength) || variant.byteLength < 1 || variant.byteLength > 1_048_576) fail('media variant size is invalid');
    if (variant.mime !== 'image/webp' || !/^[a-f0-9]{64}$/u.test(variant.sha256 ?? '')) fail('media variant format or digest is invalid');
    if (typeof variant.objectKey !== 'string' || !variant.objectKey.startsWith('public/')) fail('media variant must have a fixed public object key');
    if (widths.has(variant.width)) fail('media variant widths must be unique');
    widths.add(variant.width);
  }
}

export function validateReadyArticle(input, media, { ownerId } = {}) {
  if (typeof ownerId !== 'string' || !ownerId) fail('owner authorization context is required');
  const draft = validateDraft(input);
  if (!draft.title || !draft.slug || !draft.excerpt) {
    fail('ready article is missing a required field');
  }
  const { mediaIds, meaningfulTextCharacters } = normalizeDocument(draft.document);
  if (!draft.document.content.length || meaningfulTextCharacters === 0) fail('ready article requires body text');
  if (!Array.isArray(media)) fail('media groups are required to validate a ready article');

  const groups = new Map();
  for (const group of media) {
    if (!group || typeof group.id !== 'string' || groups.has(group.id)) fail('media group identity is invalid');
    validateMediaGroup(group, ownerId);
    groups.set(group.id, group);
  }
  const referencedIds = new Set([...mediaIds, ...(draft.coverMediaId === null ? [] : [draft.coverMediaId])]);
  for (const id of referencedIds) {
    if (!groups.has(id)) fail(`media group is missing or outside the authorized owner: ${id}`);
  }

  return { ...draft, document: structuredClone(draft.document) };
}
