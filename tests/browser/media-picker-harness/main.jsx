import React from 'react';
import { createRoot } from 'react-dom/client';
import MediaPicker from '../../../src/admin/MediaPicker.jsx';
import { login } from '../../../src/admin/api.js';
import { clearSession, sessionEpoch, setSession } from '../../../src/admin/session.js';

class ControlledWorker {
  constructor() {
    window.__task5Workers.push(this);
  }

  postMessage() {
    queueMicrotask(() => this.onmessage?.({ data: { type: 'progress', value: { stage: 'decode', format: 'JPEG' } } }));
  }

  terminate() { this.terminated = true; }

  complete(id) {
    this.onmessage?.({ data: { type: 'progress', value: { stage: 'encode', completed: 1, total: 2 } } });
    this.onmessage?.({ data: { type: 'result', result: { variants: [
      { width: 480, height: 320, blob: new Blob([`variant-${id}-480`], { type: 'image/webp' }) },
      { width: 960, height: 640, blob: new Blob([`variant-${id}-960`], { type: 'image/webp' }) },
    ] } } });
  }
}

window.__task5Workers = [];
window.Worker = ControlledWorker;
window.__task5Counts = { upload: 0, complete: 0, onComplete: 0 };
window.__task5SettledUploads = 0;
window.__task5Held = [];
window.__task5HoldNextUpload = false;
window.__task5IgnoreNextUploadAbort = false;
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
  if (url.pathname === '/api/admin/session' && init.method === 'POST') {
    return Response.json({ authenticated: true, user: { id: 'test-user' }, csrfToken: 'test-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
  }
  if (url.pathname.endsWith('/media/upload')) {
    window.__task5Counts.upload += 1;
    if (window.__task5HoldNextUpload) {
      window.__task5HoldNextUpload = false;
      return new Promise((resolve, reject) => {
        const release = () => resolve(Response.json({ variant: { width: 960, height: 640 } }));
        window.__task5Held.push(release);
        if (!window.__task5IgnoreNextUploadAbort) {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        } else window.__task5IgnoreNextUploadAbort = false;
      }).finally(() => { window.__task5SettledUploads += 1; });
    }
    window.__task5SettledUploads += 1;
    return Response.json({ variant: { width: 960, height: 640 } });
  }
  if (url.pathname.endsWith('/media/complete')) {
    window.__task5Counts.complete += 1;
    const mediaId = JSON.parse(init.body).mediaId;
    return Response.json({ media: { id: mediaId, variants: [{ width: 960, height: 640 }, { width: 480, height: 320 }] } });
  }
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};

setSession({ user: { id: 'test-user' }, csrfToken: 'test-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
window.__task5Session = {
  logout: () => clearSession(sessionEpoch(), 'logout'),
  login: () => login({ email: 'fixture@example.test', password: 'not-used-by-fixture' }),
  publishSuccessor: () => setSession({ user: { id: 'successor-user' }, csrfToken: 'successor-csrf', expiresAt: '2099-01-01T00:00:00.000Z' }),
};
export function App() {
  return <main>
    <article>Rascunho do artigo preservado durante o carregamento.</article>
    <MediaPicker onComplete={() => { window.__task5Counts.onComplete += 1; }} />
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
