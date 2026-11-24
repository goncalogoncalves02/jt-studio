import { assertEditorialSessionCurrent, BlogAuthError, requireAdmin } from '../../server/blog/auth.mjs';
import { BlogRepositoryError, markPrepared, savePost } from '../../server/blog/repositories.mjs';

export const config = { path: '/api/admin/posts', method: ['GET', 'PUT', 'POST'] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAGE_SIZE = 20;
const SUMMARY = 'id,revision,title,slug,prepared_action,prepared_revision,content_modified_at,first_confirmed_at';
const DETAIL = SUMMARY + ',excerpt,document,cover_media_id,service_id';

function json(status, body) {
  return Response.json(body, { status, headers: {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  } });
}

function apiPost(row) {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    slug: row.slug,
    preparedAction: row.prepared_action,
    preparedRevision: row.prepared_revision,
    contentModifiedAt: row.content_modified_at,
    firstConfirmedAt: row.first_confirmed_at,
    ...(Object.hasOwn(row, 'document') && {
      excerpt: row.excerpt, document: row.document, coverMediaId: row.cover_media_id, serviceId: row.service_id,
    }),
  };
}

async function readJson(request) {
  const reader = request.body?.getReader();
  const limit = 272 * 1024;
  if (!reader) throw new BlogRepositoryError(400, 'Invalid input', 'BLOG_INVALID_INPUT');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new BlogRepositoryError(413, 'Invalid input', 'BLOG_BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid input');
    return body;
  } catch (error) {
    if (error instanceof BlogRepositoryError) throw error;
    throw new BlogRepositoryError(400, 'Invalid input', 'BLOG_INVALID_INPUT');
  } finally { reader.releaseLock(); }
}

function imageIds(post) {
  const ids = new Set();
  if (post.coverMediaId) ids.add(post.coverMediaId);
  function walk(node) {
    if (node.type === 'image') ids.add(node.attrs.mediaId);
    for (const child of node.content ?? []) walk(child);
  }
  walk(post.document);
  return [...ids];
}

async function getPost(auth, id) {
  if (!UUID.test(id)) return json(400, { error: { code: 'BLOG_INVALID_INPUT' } });
  const { data, error } = await auth.userSdk.from('blog_posts').select(DETAIL).eq('owner_id', auth.userId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return json(404, { error: { code: 'BLOG_NOT_FOUND' } });
  const post = apiPost(data);
  const ids = imageIds(post);
  const media = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const results = await auth.userSdk.from('blog_media').select('id,variants').eq('owner_id', auth.userId).eq('state', 'complete').in('id', ids.slice(offset, offset + 50));
    if (results.error) throw results.error;
    media.push(...results.data.map(({ id: mediaId, variants }) => ({
      id: mediaId,
      variants: variants.map(({ width, height }) => ({ width, height })),
    })));
  }
  await assertEditorialSessionCurrent(auth);
  return json(200, { post, media });
}

export default async function blogPosts(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/admin/posts') return json(404, { error: { code: 'BLOG_NOT_FOUND' } });
    const mutation = request.method === 'PUT' || request.method === 'POST';
    if (!mutation && request.method !== 'GET') return json(405, { error: { code: 'BLOG_METHOD_NOT_ALLOWED' } });
    const auth = await requireAdmin(request, { mutation, csrfToken: request.headers.get('x-csrf-token') });
    if (mutation) {
      const body = await readJson(request);
      const keys = request.method === 'PUT' ? ['post', 'expectedRevision'] : ['postId', 'expectedRevision', 'action'];
      if (Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) {
        return json(400, { error: { code: 'BLOG_INVALID_INPUT' } });
      }
      const post = request.method === 'PUT'
        ? await savePost(auth, body.post, body.expectedRevision)
        : await markPrepared(auth, body.postId, body.expectedRevision, body.action);
      return json(200, { post });
    }

    const id = url.searchParams.get('id');
    if (id !== null) return await getPost(auth, id);
    const rawPage = url.searchParams.get('page') ?? '1';
    if (!/^[1-9]\d{0,4}$/u.test(rawPage)) return json(400, { error: { code: 'BLOG_INVALID_INPUT' } });
    const start = (Number(rawPage) - 1) * PAGE_SIZE;
    const { data, error } = await auth.userSdk.from('blog_posts').select(SUMMARY).eq('owner_id', auth.userId)
      .order('content_modified_at', { ascending: false }).order('id').range(start, start + PAGE_SIZE);
    if (error) throw error;
    await assertEditorialSessionCurrent(auth);
    return json(200, { posts: data.slice(0, PAGE_SIZE).map(apiPost), hasNext: data.length > PAGE_SIZE });
  } catch (error) {
    if (error instanceof BlogAuthError || error instanceof BlogRepositoryError) return json(error.status, { error: { code: error.code } });
    return json(503, { error: { code: 'BLOG_SERVICE_UNAVAILABLE' } });
  }
}
