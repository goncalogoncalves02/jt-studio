import { useEffect, useRef, useState } from 'react';
import { adminFetch } from './api.js';
import { sessionEpoch, subscribeSession } from './session.js';
import { AutosaveController } from './autosave.js';

export function draftFields(post = {}) {
  return {
    title: post.title ?? '',
    slug: post.slug ?? '',
    excerpt: post.excerpt ?? '',
    document: post.document ?? { type: 'doc', content: [] },
    coverMediaId: post.coverMediaId ?? null,
    serviceId: post.serviceId ?? null,
  };
}

export function useEditorDraft(initialPost, epoch, onSaved) {
  const [post, setPost] = useState(initialPost);
  const [draft, setDraft] = useState(() => draftFields(initialPost ?? undefined));
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState(null);
  const draftRef = useRef(draft);
  const postRef = useRef(initialPost);
  const controller = useRef(null);

  useEffect(() => {
    const autosave = new AutosaveController({
      onState(state, error) {
        if (epoch !== sessionEpoch()) return;
        setSaveState(state);
        setSaveError(error?.code ?? null);
      },
      async save(fields) {
        const previous = postRef.current;
        const result = await adminFetch('/api/admin/posts', {
          method: 'PUT',
          body: {
            post: previous?.id ? { ...fields, id: previous.id } : fields,
            expectedRevision: previous?.revision ?? 0,
          },
        }, { epoch });
        if (epoch !== sessionEpoch() || controller.current !== autosave) return;
        const saved = result.post;
        postRef.current = saved;
        setPost(saved);
        onSaved(saved);
      },
    });
    controller.current = autosave;
    const unsubscribe = subscribeSession(() => autosave.dispose());
    return () => {
      unsubscribe();
      autosave.dispose();
      controller.current = null;
    };
  }, [epoch, onSaved]);

  function update(fields) {
    if (epoch !== sessionEpoch()) return;
    const next = { ...draftRef.current, ...fields };
    draftRef.current = next;
    setDraft(next);
    controller.current?.change(next);
  }

  async function markReady(action) {
    if (!await controller.current?.flush() || !postRef.current?.id) return false;
    const current = postRef.current;
    const result = await adminFetch('/api/admin/posts', {
      method: 'POST',
      body: { postId: current.id, expectedRevision: current.revision, action },
    }, { epoch });
    if (epoch !== sessionEpoch()) return false;
    postRef.current = result.post;
    setPost(result.post);
    onSaved(result.post);
    return true;
  }

  async function retryWithRevision(reviewedPost) {
    if (reviewedPost) {
      const latest = await readRemote();
      if (latest.revision !== reviewedPost.revision) return latest;
      postRef.current = latest;
      setPost(latest);
      if (latest.firstConfirmedAt && draftRef.current.slug !== latest.slug) update({ slug: latest.slug });
    }
    await controller.current?.retry();
    return null;
  }

  async function readRemote() {
    const { post: remote } = await adminFetch('/api/admin/posts?id=' + encodeURIComponent(postRef.current.id), {}, { epoch });
    return remote;
  }

  return {
    post, draft, saveState, saveError, update, markReady, readRemote, retryWithRevision,
    saveNow: () => controller.current?.flush() ?? Promise.resolve(false),
  };
}
