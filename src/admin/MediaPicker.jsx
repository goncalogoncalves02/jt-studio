import { useEffect, useRef, useState } from 'react';
import { AdminApiError, adminFetch, subscribeSession } from './api.js';
import { sessionEpoch } from './session.js';
import { optimizeImage } from '../blog/image-processing.js';

export default function MediaPicker({ onComplete, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [media, setMedia] = useState(null);
  const [progress, setProgress] = useState(null);
  const controllerRef = useRef(null);

  useEffect(() => {
    const unsubscribe = subscribeSession(() => {
      const active = controllerRef.current;
      controllerRef.current = null;
      active?.abort();
      setMedia(null);
      setStatus('');
      setProgress(null);
      setBusy(false);
    });
    return () => {
      unsubscribe();
      controllerRef.current?.abort();
    };
  }, []);

  async function upload(file) {
    if (!file || busy || disabled) return;
    const controller = new AbortController();
    const epoch = sessionEpoch();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    const ownsOperation = () => controllerRef.current === controller && epoch === sessionEpoch();
    const canUpdate = () => ownsOperation() && !controller.signal.aborted;
    setBusy(true);
    setMedia(null);
    setStatus('A processar imagem…');
    setProgress(null);
    try {
      const result = await optimizeImage(file, {
        signal: controller.signal,
        onProgress(value) {
          if (!canUpdate()) return;
          setProgress(value);
          if (value?.stage === 'decode') setStatus(`A processar imagem ${value.format ?? ''}…`.trim());
          else if (value?.stage === 'encode' && Number.isInteger(value.completed) && Number.isInteger(value.total)) {
            setStatus(`A preparar versão ${value.completed} de ${value.total}…`);
          }
        },
      });
      if (!canUpdate()) return;
      const mediaId = crypto.randomUUID();
      const variants = [...result.variants].sort((left, right) => right.width - left.width);
      for (const [index, variant] of variants.entries()) {
        if (!canUpdate()) return;
        setStatus(`A carregar versão ${index + 1} de ${variants.length}…`);
        const query = new URLSearchParams({ mediaId, width: String(variant.width), height: String(variant.height) });
        await adminFetch(`/api/admin/media/upload?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'image/webp' },
          body: variant.blob,
          signal: controller.signal,
        }, { epoch, signal: controller.signal });
        if (!canUpdate()) return;
      }
      if (!canUpdate()) return;
      setStatus('A concluir o carregamento…');
      const completed = await adminFetch('/api/admin/media/complete', {
        method: 'POST', body: { mediaId }, signal: controller.signal,
      }, { epoch, signal: controller.signal });
      if (!canUpdate()) return;
      setMedia(completed.media);
      setStatus('Imagem privada pronta para usar.');
      onComplete?.(completed.media);
    } catch (error) {
      if (!canUpdate()) return;
      if (error?.name === 'AbortError') setStatus('Carregamento cancelado.');
      else setStatus(error instanceof AdminApiError ? 'Não foi possível carregar a imagem. Tente novamente.' : error?.message ?? 'Não foi possível carregar a imagem.');
    } finally {
      if (ownsOperation()) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }

  function cancelUpload() {
    const active = controllerRef.current;
    if (!active) return;
    controllerRef.current = null;
    active.abort();
    setBusy(false);
    setProgress(null);
    setStatus('Carregamento cancelado.');
  }

  const preview = media?.variants?.at(-1);
  return (
    <section aria-label="Imagens do artigo" className="media-picker">
      <label>
        Escolher imagem
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif"
          disabled={disabled || busy}
          onChange={(event) => {
            const [file] = event.currentTarget.files ?? [];
            event.currentTarget.value = '';
            void upload(file);
          }}
        />
      </label>
      <a className="editor-text-link" href="/codec-notices/README.md" target="_blank" rel="noreferrer">Licenças de imagem</a>
      {status && <p role="status" aria-live="polite">{status}</p>}
      {progress?.stage === 'encode' && Number.isInteger(progress.completed) && Number.isInteger(progress.total) && (
        <progress aria-label="Progresso do processamento" max={progress.total} value={progress.completed} />
      )}
      {busy && <button type="button" onClick={cancelUpload}>Cancelar carregamento</button>}
      {media && preview && (
        <img
          src={`/api/admin/media/preview?${new URLSearchParams({ mediaId: media.id, width: String(preview.width) })}`}
          width={preview.width}
          height={preview.height}
          alt="Pré-visualização privada da imagem"
          loading="lazy"
        />
      )}
    </section>
  );
}
