import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import SEO from '../components/SEO.jsx';
import { usePublicPageData } from '../blog/PublicDataContext.js';
import PublicImageFigure from '../blog/PublicImage.jsx';

const serviceAnchors = new Map([
  [1, '/servicos#servico-1'], [2, '/servicos#servico-2'], [3, '/servicos#servico-3'],
  [4, '/servicos#servico-4'], [5, '/servicos#servico-5'], [6, '/servicos#servico-6'],
]);
const formatDate = (date) => new Intl.DateTimeFormat('pt-PT', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date));

export default function Blog() {
  const pageData = usePublicPageData();
  const { pathname } = useLocation();
  const [state, setState] = useState({ posts: pageData.index?.length ? pageData.index : null, error: false });
  const { posts, error } = state;
  useEffect(() => {
    if (posts) return undefined;
    const controller = new AbortController();
    pageData.api.loadPublicIndex({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState({ posts: result, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ posts: null, error: true });
    });
    return () => controller.abort();
  }, [pageData.api, pathname, posts]);

  const firstCover = posts?.find((post) => post.coverMedia)?.coverMedia?.variants?.at(-1);
  const schema = {
    '@context': 'https://schema.org', '@type': 'Blog', name: 'Blog JT Studio',
    url: 'https://jaquelinetakiutistudio.com/blog', inLanguage: 'pt-PT',
    author: { '@type': 'Person', name: 'Jaqueline Takiuti' },
  };
  return (
    <section className="min-h-screen bg-cream px-[22px] pb-24 pt-32 sm:px-12">
      <SEO title="Blog" description="Artigos da Jaqueline Takiuti sobre micropigmentação, cuidados e beleza natural em Setúbal." url="https://jaquelinetakiutistudio.com/blog" structuredData={schema} image={firstCover?.url} imageWidth={firstCover?.width} imageHeight={firstCover?.height} />
      <div className="mx-auto max-w-6xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-rose">JT · STUDIO</p>
        <h1 className="mt-3 font-serif text-5xl font-light text-ink sm:text-7xl">Notas de beleza</h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">Ideias, respostas e cuidados partilhados por Jaqueline Takiuti.</p>
        {error ? <p role="alert" className="mt-12 text-rose">Não foi possível carregar os artigos. Tente novamente mais tarde.</p> : null}
        {!posts && !error ? <p className="mt-12 text-muted" aria-live="polite">A carregar artigos…</p> : null}
        {posts?.length === 0 ? <p className="mt-12 text-muted">Ainda não há artigos publicados.</p> : null}
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          {posts?.map((post, index) => {
            const variant = post.coverMedia?.variants?.at(-1);
            const serviceHref = serviceAnchors.get(post.serviceId) ?? '/servicos';
            return (
              <article key={post.id} className="overflow-hidden rounded-lg bg-white shadow-sm">
                {variant ? <Link to={`/blog/${post.slug}`} aria-label={`Ler ${post.title}`} className="block aspect-[3/2] overflow-hidden bg-cream-2"><PublicImageFigure media={post.coverMedia} alt="" eager={index === 0} sizes="(max-width: 720px) calc(100vw - 44px), 560px" className="h-full w-full object-cover" /></Link> : null}
                <div className="p-6 sm:p-8">
                  <time className="font-mono text-xs uppercase tracking-[0.12em] text-muted" dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
                  <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink"><Link to={`/blog/${post.slug}`} className="text-inherit no-underline hover:text-rose">{post.title}</Link></h2>
                  <p className="mt-4 leading-7 text-muted">{post.excerpt}</p>
                  <div className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-sm">
                    <Link to={`/blog/${post.slug}`} className="font-semibold text-rose">Ler artigo →</Link>
                    <Link to={serviceHref} className="text-ink">Ver serviço relacionado</Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
