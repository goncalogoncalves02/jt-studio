import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import SEO from '../components/SEO.jsx';
import { usePublicPageData } from '../blog/PublicDataContext.js';
import PublicImageFigure from '../blog/PublicImage.jsx';
import { renderDocument } from '../blog/ContentRenderer.jsx';
import NotFound from './NotFound.jsx';

const serviceAnchors = new Map([
  [1, '/servicos#servico-1'], [2, '/servicos#servico-2'], [3, '/servicos#servico-3'],
  [4, '/servicos#servico-4'], [5, '/servicos#servico-5'], [6, '/servicos#servico-6'],
]);
const formatDate = (date) => new Intl.DateTimeFormat('pt-PT', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date));

export default function BlogPost() {
  const { slug = '' } = useParams();
  const pageData = usePublicPageData();
  const { pathname } = useLocation();
  const [state, setState] = useState(() => pageData.post?.slug === slug
    ? { slug, post: pageData.post, missing: false, error: false }
    : pageData.notFound && pathname === '/404' ? { slug, post: null, missing: true, error: false }
      : { slug: null, post: null, missing: false, error: false });
  useEffect(() => {
    if (pageData.notFound && pathname === '/404') return undefined;
    if (pageData.post?.slug === slug) return undefined;
    const controller = new AbortController();
    pageData.api.loadPublicPost(slug, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setState({ slug, post: result, missing: !result, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ slug, post: null, missing: false, error: true });
    });
    return () => controller.abort();
  }, [pageData.api, pageData.notFound, pageData.post, pathname, slug]);

  const current = state.slug === slug ? state
    : pageData.post?.slug === slug ? { slug, post: pageData.post, missing: false, error: false }
      : null;
  const { post, missing, error } = current ?? { post: null, missing: false, error: false };
  if (missing) return <NotFound />;
  if (error) return <section className="min-h-[60vh] bg-cream px-6 pt-36 text-center"><SEO title="Artigo indisponível" description="Não foi possível carregar o artigo." noindex /><h1 className="font-serif text-4xl text-ink">Não foi possível carregar o artigo.</h1><p className="mt-4 text-muted">Tente novamente mais tarde.</p></section>;
  if (!post) return <section className="min-h-[60vh] bg-cream px-6 pt-36 text-center" aria-live="polite"><p className="text-muted">A carregar artigo…</p></section>;

  const cover = post.coverMedia?.variants?.at(-1);
  const mediaMap = new Map([...post.media, ...(post.coverMedia ? [post.coverMedia] : [])].map((media) => [media.id, media]));
  const serviceHref = serviceAnchors.get(post.serviceId) ?? '/servicos';
  const canonical = `https://jaquelinetakiutistudio.com/blog/${post.slug}`;
  const description = post.excerpt;
  const schema = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title,
    description, url: canonical, datePublished: post.publishedAt, dateModified: post.modifiedAt,
    author: { '@type': 'Person', name: 'Jaqueline Takiuti' },
    ...(cover ? { image: [{ '@type': 'ImageObject', url: cover.url, width: cover.width, height: cover.height }] } : {}),
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
  };
  return (
    <article className="min-h-screen bg-cream px-[22px] pb-24 pt-32 sm:px-12">
      <SEO title={post.title} description={description} url={canonical} type="article" image={cover?.url} imageWidth={cover?.width} imageHeight={cover?.height} structuredData={schema} />
      <div className="mx-auto max-w-3xl">
        <Link to="/blog" className="font-mono text-xs uppercase tracking-[0.15em] text-rose">← Blog</Link>
        <header className="mt-8">
          <p className="font-mono text-xs uppercase tracking-[0.15em] text-muted">Por Jaqueline Takiuti</p>
          <h1 className="mt-4 font-serif text-4xl font-light leading-tight text-ink sm:text-6xl">{post.title}</h1>
          <p className="mt-5 text-xl leading-8 text-muted">{post.excerpt}</p>
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-muted">
            <span>Publicado a <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time></span>
            {post.modifiedAt !== post.publishedAt ? <span>Atualizado a <time dateTime={post.modifiedAt}>{formatDate(post.modifiedAt)}</time></span> : null}
          </div>
        </header>
        {post.coverMedia ? <PublicImageFigure media={post.coverMedia} alt={post.title} eager sizes="(max-width: 720px) calc(100vw - 44px), 760px" className="mt-10 max-h-[36rem] w-full rounded-md object-cover" /> : null}
        <div className="mt-10 text-lg leading-8 text-ink">{renderDocument(post.document, mediaMap)}</div>
        <aside className="mt-14 border-t border-ink/15 pt-8">
          <p className="text-muted">Artigo de Jaqueline Takiuti</p>
          <Link to={serviceHref} className="mt-4 inline-flex min-h-11 items-center rounded-full bg-ink px-6 text-cream">Conhecer serviço relacionado →</Link>
        </aside>
      </div>
    </article>
  );
}
