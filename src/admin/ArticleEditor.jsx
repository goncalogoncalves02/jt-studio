import { useEffect, useImperativeHandle, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { FaBold, FaItalic, FaLink, FaListOl, FaListUl, FaImage } from 'react-icons/fa6';
import { renderDocument } from '../blog/ContentRenderer.jsx';
import { normalizeLink, validateDraft } from '../blog/content-validate.js';
import PublicImageFigure from '../blog/PublicImage.jsx';
import { servicesData } from '../data/servicesData.js';
import { useEditorDraft } from './useEditorDraft.js';
import MediaPicker from './MediaPicker.jsx';
import { ImageNode } from './ImageNode.jsx';
import { DraftMediaContext, previewMedia } from './draft-media.js';

const starter = StarterKit.extend({
  addExtensions() {
    return this.parent().map((extension) => extension.name === 'listItem'
      ? extension.extend({ content: 'paragraph (bulletList | orderedList)*' }) : extension);
  },
}).configure({
  blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false, underline: false,
  trailingNode: false, heading: { levels: [2, 3] },
  link: {
    openOnClick: false, autolink: false, linkOnPaste: false,
    isAllowedUri(href) {
      try { normalizeLink(href); return true; } catch { return false; }
    },
  },
});

const stateLabels = {
  idle: '', pending: 'Alterações por guardar', saving: 'A guardar…',
  saved: 'Guardado', conflict: 'Conflito de edição', error: 'Por guardar',
};

function slugFor(title) {
  return title.normalize('NFD').replace(/\p{Mark}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').slice(0, 120).replace(/^-+|-+$/gu, '');
}

function documentForSave(node) {
  if (node.type === 'text') {
    return {
      type: 'text', text: node.text,
      ...(node.marks?.length && { marks: node.marks.map((mark) => mark.type === 'link'
        ? { type: 'link', attrs: { href: mark.attrs.href } } : { type: mark.type }) }),
    };
  }
  if (node.type === 'image') return { type: 'image', attrs: node.attrs };
  if (node.type === 'hardBreak') return { type: 'hardBreak' };
  return {
    type: node.type, ...(node.type === 'heading' && { attrs: { level: node.attrs.level } }),
    content: (node.content ?? []).map(documentForSave),
  };
}

function actionError(error) {
  if (error?.code === 'BLOG_STALE_REVISION') return 'O artigo mudou noutra aba. O seu texto continua no editor.';
  if (error?.code === 'BLOG_SLUG_CONFLICT') return 'Este endereço já está a ser usado. Escolha outro.';
  if (error?.status === 400 || error?.code === 'BLOG_INVALID_INPUT') return 'Verifique o título, o endereço, o resumo e o texto do artigo.';
  return 'Não foi possível concluir a operação. O texto continua no editor.';
}

function Tool({ label, pressed, onClick, children }) {
  return (
    <button type="button" className="editor-tool" aria-label={label} title={label} aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

function Toolbar({ editor, onLink, onImage }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: source }) => ({
      bold: source.isActive('bold'), italic: source.isActive('italic'),
      h2: source.isActive('heading', { level: 2 }), h3: source.isActive('heading', { level: 3 }),
      bullets: source.isActive('bulletList'), numbers: source.isActive('orderedList'),
    }),
  });
  return (
    <div className="editor-toolbar" role="group" aria-label="Formatação do artigo">
      <Tool label="Negrito" pressed={active.bold} onClick={() => editor.chain().focus().toggleBold().run()}><FaBold aria-hidden /></Tool>
      <Tool label="Itálico" pressed={active.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><FaItalic aria-hidden /></Tool>
      <Tool label="Título de nível 2" pressed={active.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Tool>
      <Tool label="Título de nível 3" pressed={active.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Tool>
      <Tool label="Lista com marcadores" pressed={active.bullets} onClick={() => editor.chain().focus().toggleBulletList().run()}><FaListUl aria-hidden /></Tool>
      <Tool label="Lista numerada" pressed={active.numbers} onClick={() => editor.chain().focus().toggleOrderedList().run()}><FaListOl aria-hidden /></Tool>
      <Tool label="Inserir ligação" onClick={onLink}><FaLink aria-hidden /></Tool>
      <Tool label="Inserir imagem" onClick={onImage}><FaImage aria-hidden /></Tool>
    </div>
  );
}

export default function ArticleEditor({ initialPost, initialMedia, epoch, controlsRef, onSaved, onBack, locked }) {
  const work = useEditorDraft(initialPost, epoch, onSaved);
  const { draft, post, update, saveState, saveError } = work;
  const [media, setMedia] = useState(() => new Map(initialMedia.map((item) => [item.id, previewMedia(item)])));
  const [autoSlug, setAutoSlug] = useState(!initialPost?.slug);
  const [panel, setPanel] = useState(null);
  const [newImage, setNewImage] = useState(null);
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [href, setHref] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [remote, setRemote] = useState(null);

  const editor = useEditor({
    extensions: [starter, ImageNode],
    immediatelyRender: false,
    content: draft.document.content.length ? draft.document : { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Corpo do artigo', 'aria-multiline': 'true', class: 'public-article-content editor-writing' } },
    onUpdate: ({ editor: source }) => update({ document: documentForSave(source.getJSON()) }),
  });

  useEffect(() => { editor?.setEditable(!busy && !locked, false); }, [editor, busy, locked]);
  const dirty = ['pending', 'saving', 'error', 'conflict'].includes(saveState);
  useImperativeHandle(controlsRef, () => ({ flush: work.saveNow, dirty, busy }));
  useEffect(() => {
    if (!dirty) return undefined;
    const warning = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warning);
    return () => window.removeEventListener('beforeunload', warning);
  }, [dirty]);

  async function prepare(action) {
    setError('');
    setBusy(true);
    try {
      if (await work.markReady(action)) setNotice(action === 'remove' ? 'Retirada preparada.' : 'Artigo preparado para publicação.');
      else setError('Guarde as alterações antes de preparar o artigo.');
    } catch (failure) { if (failure?.name !== 'AbortError') setError(actionError(failure)); }
    finally { setBusy(false); }
  }

  async function resolveConflict(useMine) {
    setBusy(true);
    setError('');
    try {
      if (useMine) {
        const newer = await work.retryWithRevision(remote);
        setRemote(newer);
        if (newer) setError('A versão guardada voltou a mudar. Reveja-a novamente.');
      } else setRemote(await work.readRemote());
    } catch (failure) { if (failure?.name !== 'AbortError') setError(actionError(failure)); }
    finally { setBusy(false); }
  }

  function rememberImage(image) {
    const prepared = previewMedia(image);
    setMedia((previous) => new Map(previous).set(prepared.id, prepared));
    if (panel === 'cover') update({ coverMediaId: prepared.id });
    else setNewImage(prepared);
  }

  function applyLink() {
    if (!href.trim()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setPanel(null); return; }
    try {
      const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] }] };
      const normalized = validateDraft({ document }).document.content[0].content[0].marks[0].attrs.href;
      if (!editor.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run()) throw new Error('link');
      setPanel(null);
    } catch { setError('Introduza uma ligação HTTPS, HTTP, de email, telefone ou uma página do site.'); }
  }

  const cover = media.get(draft.coverMediaId);
  return (
    <section className="editor-panel editor-document" aria-labelledby="editor-heading">
      <button type="button" className="editor-back editor-button" onClick={onBack}>← Artigos</button>
      <header className="editor-document-head">
        <div>
          <h2 id="editor-heading">{post?.id ? 'Editar artigo' : 'Novo artigo'}</h2>
        </div>
        <p className="editor-status" role="status">{stateLabels[saveState]}</p>
      </header>
      {error && <p className="editor-error" role="alert">{error}</p>}
      {saveState === 'error' && <p className="editor-error" role="alert">{actionError({ code: saveError })}</p>}
      {saveState === 'conflict' && <div className="editor-conflict">
        <p role="alert">Este artigo mudou noutra aba. As suas alterações continuam no editor.</p>
        {remote ? <>
          <p>Versão guardada, revisão {remote.revision}</p>
          <h3>{remote.title || 'Artigo sem título'}</h3>
          {remote.excerpt && <p>{remote.excerpt}</p>}
          <button type="button" className="editor-button" disabled={busy} onClick={() => void resolveConflict(true)}>Aplicar as minhas alterações</button>
        </> : <button type="button" className="editor-button" disabled={busy} onClick={() => void resolveConflict(false)}>Rever versão guardada</button>}
      </div>}
      <fieldset disabled={busy || locked} className="editor-fields">
        <label className="editor-field">Título
          <input placeholder="Título do artigo" maxLength={160} value={draft.title} onChange={(event) => {
            const title = event.target.value;
            setNotice('');
            update({ title, ...(autoSlug && !post?.firstConfirmedAt && { slug: slugFor(title) }) });
          }} />
        </label>
        <div className="editor-field">
          <span>Corpo do artigo</span>
          <div className="editor-composer">
            {editor && <Toolbar editor={editor} onLink={() => {
              setError('');
              setHref(editor.getAttributes('link').href ?? '');
              setPanel('link');
            }} onImage={() => { setPanel('image'); setNewImage(null); setAlt(''); setCaption(''); }} />}
            <DraftMediaContext.Provider value={media}><EditorContent editor={editor} /></DraftMediaContext.Provider>
          </div>
        </div>
        {panel === 'link' && <div className="editor-inline-panel">
          <label className="editor-field">Endereço da ligação<input type="text" inputMode="url" value={href} placeholder="https://…" onChange={(event) => setHref(event.target.value)} /></label>
          <button type="button" className="editor-button primary" onClick={applyLink}>{href.trim() ? 'Aplicar ligação' : 'Remover ligação'}</button>
          <button type="button" className="editor-button" onClick={() => setPanel(null)}>Cancelar</button>
        </div>}
        {panel === 'image' && <div className="editor-inline-panel">
          <MediaPicker onComplete={rememberImage} />
          <label className="editor-field">Descrição alternativa<input value={alt} maxLength={500} onChange={(event) => setAlt(event.target.value)} /></label>
          <label className="editor-field">Legenda (opcional)<input value={caption} maxLength={500} onChange={(event) => setCaption(event.target.value)} /></label>
          <button type="button" className="editor-button primary" disabled={!newImage || !alt.trim()} onClick={() => {
            const inserted = editor.chain().focus().insertContent({ type: 'image', attrs: { mediaId: newImage.id, alt: alt.trim(), caption: caption.trim() } }).run();
            if (inserted) setPanel(null);
            else setError('Posicione o cursor fora da lista para inserir a imagem.');
          }}>Inserir no artigo</button>
          <button type="button" className="editor-button" onClick={() => setPanel(null)}>Cancelar</button>
        </div>}
        <div className="editor-field-grid">
          <label className="editor-field">Endereço no blog
            <span className="editor-address"><span aria-hidden>/blog/</span><input maxLength={120} value={draft.slug}
              readOnly={Boolean(post?.firstConfirmedAt)} placeholder="endereco-do-artigo" onChange={(event) => { setAutoSlug(false); update({ slug: event.target.value }); }} /></span>
          </label>
          <label className="editor-field">Serviço relacionado
            <select value={draft.serviceId ?? ''} onChange={(event) => update({ serviceId: Number(event.target.value) || null })}>
              <option value="">Sem serviço associado</option>
              {servicesData.map((service) => <option key={service.id} value={service.id}>{service.nameItalic}{service.nameRest}</option>)}
            </select>
          </label>
        </div>
        <label className="editor-field">Resumo
          <textarea rows={2} placeholder="Uma breve introdução para a lista do blog." maxLength={320} value={draft.excerpt} onChange={(event) => update({ excerpt: event.target.value })} />
        </label>
        <div className="editor-cover">
          {cover ? <PublicImageFigure media={cover} alt="Capa do artigo" className="editor-cover-image" /> : <span className="editor-cover-icon"><FaImage aria-hidden /></span>}
          <div><strong>Imagem de capa</strong><small>Opcional</small></div>
          <button type="button" className="editor-button" onClick={() => { setError(''); setPanel(panel === 'cover' ? null : 'cover'); }}>{cover ? 'Trocar capa' : 'Adicionar capa'}</button>
          {cover && <button type="button" className="editor-button" onClick={() => update({ coverMediaId: null })}>Remover capa</button>}
        </div>
        {panel === 'cover' && <MediaPicker onComplete={(image) => { rememberImage(image); setPanel(null); }} />}
      </fieldset>
      <footer className="editor-document-actions">
        <button type="button" className="editor-button" disabled={busy || locked || saveState === 'saving' || saveState === 'conflict'} onClick={() => {
          setError('');
          void (saveState === 'error' ? work.retryWithRevision() : work.saveNow());
        }}>Guardar agora</button>
        <button type="button" className="editor-button" disabled={busy} aria-expanded={panel === 'preview'} onClick={() => setPanel(panel === 'preview' ? null : 'preview')}>Pré-visualizar</button>
        <button type="button" className="editor-button primary" disabled={busy || locked || !draft.title.trim()} onClick={() => void prepare('upsert')}>Preparar publicação</button>
        {post?.firstConfirmedAt && <button type="button" className="editor-button" disabled={busy} onClick={() => void prepare('remove')}>Preparar retirada</button>}
      </footer>
      {notice && <p className="editor-status" role="status">{notice}</p>}
      {panel === 'preview' && <Preview draft={draft} media={media} cover={cover} />}
    </section>
  );
}

function Preview({ draft, media, cover }) {
  let content;
  try { content = renderDocument(validateDraft(draft).document, media); }
  catch { return <p role="alert">A pré-visualização precisa de um artigo e de imagens válidas.</p>; }
  return (
    <article className="editor-preview public-article-content" aria-label="Pré-visualização do artigo">
      <p className="editor-kicker">PRÉ-VISUALIZAÇÃO</p>
      <h3>{draft.title || 'Artigo sem título'}</h3>
      <p>{draft.excerpt}</p>
      {cover && <PublicImageFigure media={cover} alt="" figure />}
      {content}
    </article>
  );
}
