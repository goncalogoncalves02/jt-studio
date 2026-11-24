import { useEffect, useRef, useState } from 'react';
import { adminFetch } from './api.js';

const endpoint = '/api/admin/publication/';
const states = {
  confirmed: 'Publicação confirmada',
  promoting: 'A preparar as imagens',
  queued: 'A aguardar o build',
  building: 'A verificar a publicação',
  unknown: 'Resultado por confirmar',
  failed: 'A publicação falhou',
  live: 'Publicação online',
};

export default function PublicationReview({ epoch, onOnline }) {
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [check, setCheck] = useState(0);
  const [review, setReview] = useState(0);
  const requestId = useRef(null);
  const retryId = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const options = { epoch, signal: controller.signal };
    Promise.all([adminFetch(endpoint + 'review', {}, options), adminFetch(endpoint + 'current', {}, options)])
      .then(([details, { publication }]) => {
        if (controller.signal.aborted) return;
        setSummary(details);
        setStatus(publication);
        setBusy(false);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure?.name !== 'AbortError') setError('Não foi possível carregar a revisão. Tente novamente.');
        setBusy(false);
      });
    return () => controller.abort();
  }, [epoch, review]);

  useEffect(() => {
    if (!status || ['live', 'failed'].includes(status.state)) return undefined;
    const controller = new AbortController();
    const step = ['confirmed', 'promoting'].includes(status.state) ? 'progress' : 'reconcile';
    const timer = setTimeout(async () => {
      try {
        const next = await adminFetch(endpoint + step, { method: 'POST', body: { requestId: status.requestId } }, { epoch, signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.state === 'live') {
          setSummary(null);
          onOnline();
        }
      } catch (failure) {
        if (!controller.signal.aborted && failure?.name !== 'AbortError') {
          setError('A publicação mantém o último estado conhecido. Pode voltar a verificar.');
        }
      }
    }, step === 'progress' ? 350 : 4_000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [epoch, onOnline, status, check]);

  async function publish() {
    const id = requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      setStatus(await adminFetch(endpoint + 'confirm', { method: 'POST', body: { requestId: id, expectedDigest: summary.digest } }, { epoch }));
      requestId.current = null;
    } catch (failure) {
      if (failure?.name === 'AbortError') return;
      if (failure.status === 409) {
        requestId.current = null;
        setSummary(null);
        setError('O conjunto preparado mudou ou existe um build em curso. Volte a rever antes de publicar.');
      } else {
        setSummary(null);
        setError('O resultado da confirmação ficou por verificar. Consulte o estado antes de voltar a publicar.');
      }
    } finally { setBusy(false); }
  }

  async function retry() {
    const id = retryId.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      setStatus(await adminFetch(endpoint + 'retry', { method: 'POST', body: { requestId: status.requestId, retryId: id } }, { epoch }));
      retryId.current = null;
    } catch (failure) {
      if (failure?.name !== 'AbortError') setError('Não foi possível iniciar a repetição. Consulte o estado da publicação.');
    } finally { setBusy(false); }
  }

  const active = status && status.state !== 'live';
  return (
    <section className="editor-panel publication-review" aria-labelledby="publication-title">
      <h2 id="publication-title">Rever publicação</h2>
      {status && <p className="editor-status" role="status">{states[status.state]}</p>}
      {active && status.state === 'unknown' && <p>O envio ficou por confirmar. A publicação será verificada antes de qualquer nova tentativa.</p>}
      {active && status.state === 'failed' && <button type="button" className="editor-button primary" onClick={retry} disabled={busy}>Repetir esta publicação</button>}
      {active && error && status.state !== 'failed' && <button type="button" className="editor-button" onClick={() => { setError(''); setCheck(check + 1); }}>Verificar estado</button>}
      {error && <p className="editor-error" role="alert">{error}</p>}
      {!active && (summary ? (
        summary.changes.length ? (
          <>
            <p>Estas alterações serão aplicadas em conjunto.</p>
            <ul className="publication-list">
              {summary.changes.map((change) => <li key={change.postId}>
                <div><strong>{change.title || 'Artigo sem título'}</strong><small>/blog/{change.slug}</small></div>
                <span>{change.action === 'remove' ? 'Retirar do blog' : change.wasConfirmed ? 'Atualizar' : 'Publicar'}</span>
              </li>)}
            </ul>
            <button type="button" className="editor-button primary" onClick={publish} disabled={busy}>Confirmar publicação</button>
          </>
        ) : <p>Nenhum artigo preparado para publicação.</p>
      ) : busy ? <p role="status">A carregar a revisão…</p> : (
        <button type="button" className="editor-button" onClick={() => { setError(''); setBusy(true); setReview(review + 1); }}>Carregar a revisão</button>
      ))}
    </section>
  );
}
