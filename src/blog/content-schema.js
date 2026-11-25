export const DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_ARTICLE_TITLE_LENGTH = 160;
export const MAX_ARTICLE_SLUG_LENGTH = 120;
export const MAX_ARTICLE_EXCERPT_LENGTH = 320;
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_DOCUMENT_NODES = 5_000;

export const DOCUMENT_V1_NODES = Object.freeze([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'hardBreak',
  'image',
]);

export const DOCUMENT_V1_MARKS = Object.freeze(['bold', 'italic', 'link']);

export const CONTENT_LIMITS = Object.freeze({
  title: MAX_ARTICLE_TITLE_LENGTH,
  slug: MAX_ARTICLE_SLUG_LENGTH,
  excerpt: MAX_ARTICLE_EXCERPT_LENGTH,
  documentBytes: MAX_DOCUMENT_BYTES,
  documentNodes: MAX_DOCUMENT_NODES,
  headingLevels: Object.freeze([2, 3]),
  serviceIds: Object.freeze([1, 2, 3, 4, 5, 6]),
});
