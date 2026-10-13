import { createHash } from 'node:crypto';
import { buildBlog } from './build-blog.mjs';

const releaseId = '00000000-0000-4000-8000-000000000099';
const posts = Array.from({ length: 100 }, (_, index) => {
  const number = String(index).padStart(3, '0');
  const id = `00000000-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`;
  const body = `body-sentinel-post-${number}-unique`;
  const post = {
    id,
    slug: `post-${number}`,
    title: index === 50 ? `Post ${number} </script><script>alert(1)</script>` : `Artigo sintético ${number}`,
    excerpt: index === 50 ? `Resumo "especial" da Jaqueline's: </script><script>alert(1)</script> & cuidados.` : `Resumo público ${number}.`,
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    coverMedia: null,
    media: [],
    serviceId: index === 0 ? 1 : index % 7 === 0 ? null : (index % 6) + 1,
    publishedAt: new Date(Date.UTC(2026, 9, 13, 12, 0, index)).toISOString(),
    modifiedAt: new Date(Date.UTC(2026, 9, 13, 12, 0, index)).toISOString(),
  };
  if (index === 0) {
    const mediaId = '00000000-0000-4000-8000-000000000120';
    const sha = 'd'.repeat(64);
    post.coverMedia = { id: mediaId, variants: [{
      width: 480, height: 320, mime: 'image/webp', byteLength: 512, sha256: sha,
      objectKey: `public/${mediaId}/480-${sha}.webp`,
    }] };
    post.media = [post.coverMedia];
    post.document.content.push({ type: 'image', attrs: { mediaId, alt: 'Imagem partilhada na capa e no artigo' } });
  }
  return post;
});
const fixture = { schemaVersion: 1, releaseId, posts };
const payload = JSON.stringify(fixture);
await buildBlog({ mode: 'fixture', release: {
  releaseId,
  payload,
  digest: createHash('sha256').update(payload, 'utf8').digest('hex'),
}, outDir: 'dist/fixture' });
process.stdout.write('Generated an isolated 100-post browser fixture with unique body sentinels.\n');
