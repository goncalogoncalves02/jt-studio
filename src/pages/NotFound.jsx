import SEO from '../components/SEO.jsx';

export default function NotFound() {
  return (
    <section className="min-h-[60vh] bg-cream px-6 pt-36 pb-24 text-center">
      <SEO title="Página não encontrada" description="Esta página já não está disponível no JT Studio." noindex />
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-rose">404</p>
      <h1 className="mt-3 font-serif text-5xl text-ink">Página não encontrada</h1>
      <p className="mx-auto mt-5 max-w-xl text-muted">O artigo pode ter sido retirado ou o endereço pode estar incorreto.</p>
      <a className="mt-8 inline-flex min-h-11 items-center rounded-full bg-ink px-6 text-cream" href="/blog">Voltar ao blog</a>
    </section>
  );
}
