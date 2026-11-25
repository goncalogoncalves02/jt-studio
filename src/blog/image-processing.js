export { validateInputImage } from './media-header.js';

export function optimizeImage(file, options = {}) {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(new DOMException('Processamento cancelado.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      fn(value);
    };
    const abort = () => finish(reject, new DOMException('Processamento cancelado.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') {
        try { onProgress?.(data.value); } catch { /* Callback errors do not change worker lifetime. */ }
      } else if (data.type === 'result') finish(resolve, data.result);
      else if (data.type === 'error') finish(reject, data.name === 'AbortError' ? new DOMException(data.message, 'AbortError') : new Error(data.message));
    };
    worker.onerror = () => finish(reject, new Error('Não foi possível processar esta imagem. Tente uma cópia diferente.'));
    worker.onmessageerror = () => finish(reject, new Error('Não foi possível ler os dados desta imagem.'));
    try {
      worker.postMessage({ type: 'process', file });
    } catch {
      finish(reject, new Error('Não foi possível preparar esta imagem para processamento.'));
    }
  });
}
