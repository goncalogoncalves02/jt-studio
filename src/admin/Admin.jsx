import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaArrowRight, FaFeatherPointed, FaPlus } from 'react-icons/fa6';
import { adminFetch, getSession, login, logout, subscribeSession } from './api.js';
import { getSessionState, sessionEpoch } from './session.js';
import PublicationReview from './PublicationReview.jsx';
import './admin.css';

const ArticleEditor = lazy(() => import('./ArticleEditor.jsx'));
const editDate = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Lisbon' });

function Login({ onLogin, error }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  async function signIn(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setFailure('');
    try { onLogin(await login({ email: fields.get('email'), password: fields.get('password') })); }
    catch (error) {
      setFailure(error?.status === 401 || error?.status === 403
        ? 'Não foi possível iniciar sessão com estes dados.'
        : 'O início de sessão está indisponível. Tente novamente.');
    } finally { setBusy(false); }
  }

  return (
    <div className="editor-login-layout">
      <div>
        <p className="editor-kicker">BLOG · JT STUDIO</p>
        <h1>Painel editorial</h1>
        <p className="editor-intro">Escreva, prepare e publique artigos para o blog do estúdio.</p>
        <Link className="editor-text-link" to="/blog">← Voltar ao blog</Link>
      </div>
      <form className="editor-panel editor-login" onSubmit={signIn}>
        <h2>Entrar</h2>
        <label className="editor-field">Email<input name="email" type="email" autoComplete="username" required /></label>
        <label className="editor-field">Palavra-passe<input name="password" type="password" autoComplete="current-password" required /></label>
        {(failure || error) && <p className="editor-error" role="alert">{failure || error}</p>}
        <button type="submit" className="editor-button primary" disabled={busy}>{busy ? 'A entrar…' : 'Iniciar sessão'} <FaArrowRight aria-hidden /></button>
      </form>
    </div>
  );
}

function describePost(post) {
  if (post.preparedAction === 'remove') return 'Retirada preparada';
  if (post.preparedAction === 'upsert') return 'Preparado';
  if (post.firstConfirmedAt) return 'Confirmado';
  return 'Rascunho';
}

function Workspace({ epoch }) {
  const [listing, setListing] = useState({ posts: [], hasNext: false });
  const [page, setPage] = useState(1);
  const [listStatus, setListStatus] = useState('loading');
  const [active, setActive] = useState(null);
  const [review, setReview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [exitBusy, setExitBusy] = useState(false);
  const [pendingPublication, setPendingPublication] = useState(false);
  const controls = useRef(null);
  const editorFocus = useRef(null);
  const primaryAction = useRef(null);
  const reviewButton = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    adminFetch('/api/admin/posts?page=' + page, {}, { epoch, signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) { setListing(data); setListStatus('ready'); }
    }).catch(() => { if (!controller.signal.aborted) setListStatus('error'); });
    return () => controller.abort();
  }, [epoch, page, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    adminFetch('/api/admin/publication/current', {}, { epoch, signal: controller.signal }).then(({ publication }) => {
      if (!controller.signal.aborted) setPendingPublication(Boolean(publication && publication.state !== 'live'));
    }).catch(() => {});
    return () => controller.abort();
  }, [epoch, review]);

  useEffect(() => {
    const followLink = (event) => {
      const link = event.target instanceof Element && event.target.closest('nav a[href], body > footer a[href], #root > div > footer a[href]');
      if (!link || !controls.current?.dirty || link.target === '_blank' || event.defaultPrevented) return;
      if (!window.confirm('Há alterações por guardar. Quer sair do painel?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('click', followLink, true);
    return () => document.removeEventListener('click', followLink, true);
  }, []);

  const onSaved = useCallback((post) => {
    const summary = {
      id: post.id, title: post.title, slug: post.slug, revision: post.revision, preparedAction: post.preparedAction,
      preparedRevision: post.preparedRevision, firstConfirmedAt: post.firstConfirmedAt, contentModifiedAt: post.contentModifiedAt,
    };
    setActive((current) => current ? { ...current, visibleId: post.id } : current);
    setListing((current) => ({
      ...current,
      posts: current.posts.some((item) => item.id === post.id)
        ? current.posts.map((item) => item.id === post.id ? { ...item, ...summary } : item)
        : [summary, ...current.posts].slice(0, 20),
    }));
  }, []);

  const onOnline = useCallback(() => { setRefresh((value) => value + 1); setPendingPublication(false); }, []);

  async function canLeave() {
    const current = controls.current;
    if (!current) return true;
    if (current.busy) return false;
    if (!current.dirty || await current.flush()) return epoch === sessionEpoch();
    return window.confirm('As alterações continuam por guardar. Quer sair deste artigo sem as guardar?');
  }

  async function choose(id) {
    if (changing || active?.visibleId === id) return;
    setChanging(true);
    setError('');
    try {
      if (!await canLeave()) return;
      const details = id === 'new' ? { post: null, media: [] } : await adminFetch('/api/admin/posts?id=' + encodeURIComponent(id), {}, { epoch });
      if (epoch !== sessionEpoch()) return;
      setReview(false);
      setActive({ key: id, visibleId: id, ...details });
      requestAnimationFrame(() => editorFocus.current?.focus());
    } catch (failure) {
      if (failure?.name !== 'AbortError') setError('Não foi possível abrir o artigo. Tente novamente.');
    } finally { setChanging(false); }
  }

  async function showReview() {
    if (changing || review) return;
    setChanging(true);
    try {
      if (!await canLeave()) return;
      setActive(null);
      setReview(true);
      requestAnimationFrame(() => editorFocus.current?.focus());
    } finally { setChanging(false); }
  }

  async function back() {
    if (!await canLeave()) return;
    setActive(null);
    setReview(false);
    requestAnimationFrame(() => (review ? reviewButton : primaryAction).current?.focus());
  }

  async function signOut() {
    setExitBusy(true);
    setError('');
    try { if (await canLeave()) await logout(); }
    catch { setError('Não foi possível terminar a sessão. Tente novamente.'); }
    finally { setExitBusy(false); }
  }

  function changePage(value) {
    setListStatus('loading');
    setPage(value);
  }

  return (
    <div className="editor-workspace">
      <header className="editor-workspace-head">
        <div>
          <p className="editor-kicker">BLOG · JT STUDIO</p>
          <h1>Painel editorial</h1>
        </div>
        <div className="editor-head-actions">
          <button type="button" className="editor-button" ref={reviewButton} disabled={changing} onClick={() => void showReview()}>
            {pendingPublication ? 'Ver publicação em curso' : 'Rever publicação'}
          </button>
          <button type="button" className="editor-button editor-quiet" disabled={exitBusy} onClick={() => void signOut()}>Terminar sessão</button>
        </div>
      </header>
      {error && <p className="editor-error" role="alert">{error}</p>}
      <div className={'editor-workspace-grid' + (active || review ? ' has-selection' : '')}>
        <aside className="editor-panel editor-article-list" aria-labelledby="articles-heading">
          <header>
            <h2 id="articles-heading">Artigos</h2>
            <button type="button" className="editor-button primary" ref={primaryAction} disabled={changing} onClick={() => void choose('new')}><FaPlus aria-hidden /> Novo artigo</button>
          </header>
          {listStatus === 'loading' && <p role="status">A carregar artigos…</p>}
          {listStatus === 'error' && <>
            <p className="editor-error" role="alert">Não foi possível carregar os artigos.</p>
            <button type="button" className="editor-button" onClick={() => { setListStatus('loading'); setRefresh(refresh + 1); }}>Tentar novamente</button>
          </>}
          {listStatus === 'ready' && (listing.posts.length ? (
            <ul>{listing.posts.map((post) => (
              <li key={post.id}>
                <button type="button" aria-current={active?.visibleId === post.id ? 'true' : undefined} onClick={() => void choose(post.id)} disabled={changing}>
                  <strong>{post.title || 'Artigo sem título'}</strong>
                  <span><small>{describePost(post)}</small>{post.contentModifiedAt && <time dateTime={post.contentModifiedAt}>{editDate.format(new Date(post.contentModifiedAt))}</time>}</span>
                </button>
              </li>
            ))}</ul>
          ) : <p>Ainda não tem artigos.</p>)}
          {listStatus === 'ready' && (page > 1 || listing.hasNext) && (
            <div className="editor-pagination" aria-label="Paginação de artigos">
              <button type="button" className="editor-button" disabled={page === 1} onClick={() => changePage(page - 1)}>Anterior</button>
              <span>Pág. {page}</span>
              <button type="button" className="editor-button" disabled={!listing.hasNext} onClick={() => changePage(page + 1)}>Seguinte</button>
            </div>
          )}
        </aside>
        <div className="editor-workspace-main" ref={editorFocus} tabIndex={-1}>
          {review ? <>
            <button type="button" className="editor-back editor-button" onClick={() => void back()}>← Artigos</button>
            <PublicationReview epoch={epoch} onOnline={onOnline} />
          </> : active ? (
            <Suspense fallback={<p className="editor-panel" role="status">A carregar o editor…</p>}>
              <ArticleEditor key={active.key} initialPost={active.post} initialMedia={active.media} epoch={epoch} controlsRef={controls} locked={changing || exitBusy} onSaved={onSaved} onBack={() => void back()} />
            </Suspense>
          ) : (
            <section className="editor-panel editor-empty">
              <span className="editor-empty-icon"><FaFeatherPointed aria-hidden /></span>
              <h2>Comece a escrever</h2>
              <p>Abra um artigo para continuar a edição ou crie um novo.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Admin() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    async function readSession() {
      try {
        const current = await getSession({ signal: controller.signal });
        if (!controller.signal.aborted) setSession(current);
      } catch {
        if (!controller.signal.aborted) setError('Não foi possível verificar a sessão.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    const unsubscribe = subscribeSession(({ reason }) => {
      setSession(getSessionState());
      if (reason === 'login' && !getSessionState()) void readSession();
    });
    void readSession();
    return () => { controller.abort(); unsubscribe(); };
  }, []);

  return (
    <section className="editor-surface">
      <div className="editor-container">
        {loading ? <div className="editor-workspace-head"><h1>Painel editorial</h1><p role="status">A verificar a sessão…</p></div>
          : session ? <Workspace key={sessionEpoch()} epoch={sessionEpoch()} />
            : <Login onLogin={setSession} error={error} />}
      </div>
    </section>
  );
}
