import { lazy, Suspense, useEffect, useState } from 'react';
import SEO from '../components/SEO.jsx';

const Admin = import.meta.env.MODE === 'legacy' ? null : lazy(() => import('./Admin.jsx'));

function LoadingPanel() {
  return (
    <section className="min-h-[70vh] bg-cream px-[22px] pb-16 pt-28 sm:px-12">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-serif text-5xl font-light text-ink">Painel editorial</h1>
        <p className="mt-3 text-muted" role="status">A carregar o painel…</p>
      </div>
    </section>
  );
}

export default function AdminRoute() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      <SEO title="Painel editorial" description="Área editorial do JT Studio." noindex />
      {mounted ? <Suspense fallback={<LoadingPanel />}><Admin /></Suspense> : <LoadingPanel />}
    </>
  );
}
