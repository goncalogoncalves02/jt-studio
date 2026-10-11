import { useEffect, useRef, useState } from 'react';
import { adminFetch, subscribeSession } from './api.js';
import { optimizeImage } from '../blog/image-processing.js';

export default function MediaPicker({ onComplete, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [media, setMedia] = useState(null);
  const controllerRef = useRef(null);

  useEffect(() => {
    const unsubscribe = subscribeSession(() => controllerRef.current?.abort());
    return () => {
      unsubscribe();
      controllerRef.current?.abort();
    };
  }, []);

  async function upload(file) {
    if (!file || busy || disabled) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setBusy(true);
    setMedia(null);
    setStatus('A preparar a imagem…');
    try {
      const result = await optimizeImage(file, { signal: controller.signal });
      const mediaId = crypto.randomUUID();
      const variants = [...result.variants].sort((left, right) => right.width - left.width);
      for (const variant of variants) {
        const query = new URLSearchParams({ mediaId, width: String(variant.width), height: String(variant.height) });
        await adminFetch(`/api/admin/media/upload?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'image/webp' },
          body: variant.blob,
          signal: controller.signal,
        }, { signal: controller.signal });
      }
      const completed = await adminFetch('/api/admin/media/complete', {
        method: 'POST', body: { mediaId }, signal: controller.signal,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setMedia(completed.media);
      setStatus('Imagem privada pronta para usar.');
      onComplete?.(completed.media);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setStatus(error?.message ?? 'Não foi possível carregar a imagem.');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
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
      {busy && <p role="status">A preparar e a carregar versões privadas…</p>}
      {!busy && status && <p role="status">{status}</p>}
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
