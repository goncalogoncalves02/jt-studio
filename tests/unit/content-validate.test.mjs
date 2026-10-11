import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARTICLE_SLUG_LENGTH, MAX_ARTICLE_TITLE_LENGTH, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NODES,
} from '../../src/blog/content-schema.js';

let validator;
try {
  validator = await import('../../src/blog/content-validate.js');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  validator = {};
}

const emptyDocument = { type: 'doc', content: [] };

const readyDraft = () => ({
  title: 'Cuidados depois da micropigmentação',
  slug: 'cuidados-micropigmentacao',
  excerpt: 'O que esperar e como cuidar da pele nos primeiros dias.',
  serviceId: 1,
  coverMediaId: 'cover-1',
  document: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Nos primeiros dias' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Siga as recomendações da profissional. ' },
          { type: 'text', text: 'Evite exposição solar.', marks: [{ type: 'bold' }] },
        ],
      },
      { type: 'image', attrs: { mediaId: 'inline-1', alt: 'Resultado cicatrizado', caption: 'Resultado após cicatrização' } },
    ],
  },
});

const completeMedia = [
  { id: 'cover-1', ownerId: 'owner-1', state: 'complete', pipelineVersion: 1, variants: [{ width: 480, height: 320, mime: 'image/webp', byteLength: 1200, sha256: 'a'.repeat(64), objectKey: 'public/cover-1.webp' }] },
  { id: 'inline-1', ownerId: 'owner-1', state: 'complete', pipelineVersion: 1, variants: [{ width: 480, height: 320, mime: 'image/webp', byteLength: 1400, sha256: 'b'.repeat(64), objectKey: 'public/inline-1.webp' }] },
];

test('validateDraft keeps incomplete work saveable and returns a normalized draft', () => {
  assert.equal(typeof validator.validateDraft, 'function', 'content draft validation must be implemented');
  const draft = validator.validateDraft({
    title: '  Notas por completar  ',
    slug: '',
    excerpt: '',
    serviceId: null,
    coverMediaId: null,
    document: emptyDocument,
  });

  assert.deepEqual(draft, {
    title: 'Notas por completar',
    slug: '',
    excerpt: '',
    serviceId: null,
    coverMediaId: null,
    document: emptyDocument,
  });
});

test('validateDraft rejects unknown fields and non-DocumentV1 attributes', () => {
  assert.equal(typeof validator.validateDraft, 'function', 'content draft validation must be implemented');
  assert.throws(() => validator.validateDraft({ ...readyDraft(), ownerId: 'attacker' }), /unknown|campo/i);
  assert.throws(() => validator.validateDraft({
    ...readyDraft(),
    document: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2, id: 'injected' }, content: [] }] },
  }), /attribute|atribut|heading/i);
});

test('validateDraft rejects executable links and unsupported document nodes', () => {
  assert.equal(typeof validator.validateDraft, 'function', 'content draft validation must be implemented');
  const executableLink = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'abre', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
    }],
  };
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: executableLink }), /link|URL|url/i);
  assert.throws(() => validator.validateDraft({
    ...readyDraft(),
    document: { type: 'doc', content: [{ type: 'html', attrs: { html: '<script>alert(1)</script>' } }] },
  }), /node|nó|document/i);
});

test('validateDraft rejects malformed strict attributes, duplicate marks, and non-text image metadata', () => {
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{
      type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 42 } }],
    }] }],
  } }), /link|URL|url/i);
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dupe', marks: [{ type: 'bold' }, { type: 'bold' }] }] }],
  } }), /repeat|repet/i);
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: {
    type: 'doc', content: [{ type: 'image', attrs: { mediaId: 7, alt: 'Imagem' } }],
  } }), /text|texto|media/i);
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: {
    type: 'doc', content: [{ type: 'image', attrs: { mediaId: 'img-1', alt: 'Imagem', caption: null } }],
  } }), /text|texto|caption|legenda/i);
});

test('validateDraft preserves whitespace-only text between differently marked spans', () => {
  const document = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'A', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'B', marks: [{ type: 'italic' }] },
    ] }],
  };
  assert.deepEqual(validator.validateDraft({ ...readyDraft(), document }).document, document);
});

test('DocumentV1 requires a doc root, matching the database trust boundary', () => {
  for (const document of [
    { type: 'paragraph', content: [{ type: 'text', text: 'root paragraph' }] },
    { type: 'text', text: 'root text' },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'root list' }] }] }] },
  ]) {
    assert.throws(() => validator.validateDraft({ ...readyDraft(), document }), /doc root|DocumentV1/i);
  }
});

test('ready title and excerpt reject the full ECMAScript trim whitespace set', () => {
  const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  assert.throws(() => validator.validateReadyArticle({ ...readyDraft(), title: whitespace }, completeMedia, { ownerId: 'owner-1' }), /required field/i);
  assert.throws(() => validator.validateReadyArticle({ ...readyDraft(), excerpt: whitespace }, completeMedia, { ownerId: 'owner-1' }), /required field/i);
});

test('ready content needs non-whitespace text across the document', () => {
  const document = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '  \n\t\u00a0' }] }],
  };
  assert.doesNotThrow(() => validator.validateDraft({ ...readyDraft(), document }));
  assert.throws(() => validator.validateReadyArticle({ ...readyDraft(), document }, completeMedia, { ownerId: 'owner-1' }), /body text/i);
});

test('validateReadyArticle requires complete owner media for cover and every inline image', () => {
  assert.equal(typeof validator.validateReadyArticle, 'function', 'ready article validation must be implemented');
  assert.deepEqual(
    validator.validateReadyArticle(readyDraft(), completeMedia, { ownerId: 'owner-1' }).document,
    readyDraft().document,
  );

  assert.throws(() => validator.validateReadyArticle(readyDraft(), completeMedia.slice(0, 1), { ownerId: 'owner-1' }), /media|imagem/i);
  assert.throws(() => validator.validateReadyArticle(readyDraft(), completeMedia, { ownerId: 'owner-2' }), /owner|autor|media/i);
});

test('validateReadyArticle rejects incomplete and cross-owner media groups', () => {
  assert.equal(typeof validator.validateReadyArticle, 'function', 'ready article validation must be implemented');
  const uploading = completeMedia.map((media) => ({ ...media }));
  uploading[1] = { ...uploading[1], state: 'uploading' };
  assert.throws(() => validator.validateReadyArticle(readyDraft(), uploading, { ownerId: 'owner-1' }), /complete|completa|upload/i);

  const foreign = completeMedia.map((media) => ({ ...media }));
  foreign[1] = { ...foreign[1], ownerId: 'owner-2' };
  assert.throws(() => validator.validateReadyArticle(readyDraft(), foreign, { ownerId: 'owner-1' }), /owner|autor|media/i);
});

test('validateReadyArticle rejects output variants larger than the approved 1600-pixel master bound', () => {
  const oversized = completeMedia.map((group, index) => index === 0 ? {
    ...group,
    variants: [{ ...group.variants[0], width: 1601, height: 1067 }],
  } : group);
  assert.throws(() => validator.validateReadyArticle(readyDraft(), oversized, { ownerId: 'owner-1' }), /1600|dimension|dimensão/i);
});

test('validateReadyArticle rejects duplicate variant widths and metadata fields outside the exact contract', () => {
  const duplicateWidths = completeMedia.map((group) => ({
    ...group,
    variants: [...group.variants, { ...group.variants[0], byteLength: group.variants[0].byteLength + 1 }],
  }));
  assert.throws(() => validator.validateReadyArticle(readyDraft(), duplicateWidths, { ownerId: 'owner-1' }), /width|largura/i);

  const privateVariant = completeMedia.map((group) => ({
    ...group,
    variants: [{ ...group.variants[0], signedUrl: 'https://storage.example/private?token=secret' }],
  }));
  assert.throws(() => validator.validateReadyArticle(readyDraft(), privateVariant, { ownerId: 'owner-1' }), /unknown|field|campo/i);
});

test('content limits match the approved title and slug lengths', () => {
  assert.equal(MAX_ARTICLE_TITLE_LENGTH, 160);
  assert.equal(MAX_ARTICLE_SLUG_LENGTH, 120);
  assert.equal(validator.validateDraft({ ...readyDraft(), title: 't'.repeat(160) }).title.length, 160);
  assert.throws(() => validator.validateDraft({ ...readyDraft(), title: 't'.repeat(161) }), /160/);
  assert.equal(validator.validateDraft({ ...readyDraft(), slug: `a${'-a'.repeat(59)}` }).slug.length, 119);
  assert.equal(validator.validateDraft({ ...readyDraft(), slug: `a${'-a'.repeat(59)}a` }).slug.length, 120);
  assert.throws(() => validator.validateDraft({ ...readyDraft(), slug: `a${'-a'.repeat(60)}` }), /120/);
});

test('DocumentV1 links accept approved mailto and tel schemes while rejecting executable schemes', () => {
  for (const href of ['mailto:hello@example.com', 'tel:+1-555-0100']) {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'contact', marks: [{ type: 'link', attrs: { href } }] }] }],
    };
    const normalized = validator.validateDraft({ ...readyDraft(), document });
    assert.equal(normalized.document.content[0].content[0].marks[0].attrs.href, href);
  }
});

test('ready article may use the approved general-services relationship', () => {
  const input = { ...readyDraft(), serviceId: null };
  assert.equal(validator.validateReadyArticle(input, completeMedia, { ownerId: 'owner-1' }).serviceId, null);
});

test('a text-only ready article may omit its cover and general-service link', () => {
  const input = {
    ...readyDraft(), serviceId: null, coverMediaId: null,
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto principal' }] }] },
  };
  const ready = validator.validateReadyArticle(input, [], { ownerId: 'owner-1' });
  assert.equal(ready.coverMediaId, null);
  assert.equal(ready.serviceId, null);
});

test('an optional cover still requires complete media belonging to the owner', () => {
  const input = { ...readyDraft(), document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texto' }] }] } };
  assert.throws(() => validator.validateReadyArticle(input, [], { ownerId: 'owner-1' }), /media|owner/i);
});

test('DocumentV1 enforces the approved 256 KiB and 5000-node bounds', () => {
  assert.equal(MAX_DOCUMENT_BYTES, 256 * 1024);
  assert.equal(MAX_DOCUMENT_NODES, 5000);
  const textDoc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  assert.doesNotThrow(() => validator.validateDraft({ ...readyDraft(), document: textDoc('x'.repeat(250_000)) }));
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: textDoc('x'.repeat(270_000)) }), /byte limit|256|DocumentV1|bounded text/i);
  const exactNodeDoc = { type: 'doc', content: Array.from({ length: 2499 }, (_, index) => ({
    type: 'paragraph', content: [{ type: 'text', text: `n${index}` }, ...(index === 0 ? [{ type: 'hardBreak' }] : [])],
  })) };
  assert.doesNotThrow(() => validator.validateDraft({ ...readyDraft(), document: exactNodeDoc }));
  assert.throws(() => validator.validateDraft({ ...readyDraft(), document: {
    type: 'doc', content: Array.from({ length: 2500 }, (_, index) => ({
      type: 'paragraph', content: [{ type: 'text', text: `n${index}` }],
    })),
  } }), /5000|nodes/i);
});
