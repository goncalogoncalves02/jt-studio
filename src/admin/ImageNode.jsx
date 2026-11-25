import { Node, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useContext } from 'react';
import { DraftMediaContext } from './draft-media.js';

function ImageView({ node, selected }) {
  const media = useContext(DraftMediaContext).get(node.attrs.mediaId);
  const image = media?.variants.at(-1);
  return (
    <NodeViewWrapper as="figure" className={'editor-inline-image' + (selected ? ' is-selected' : '')} contentEditable={false}>
      {image ? <img src={image.url} width={image.width} height={image.height} alt={node.attrs.alt} loading="lazy" /> : <span>Imagem indisponível</span>}
      {node.attrs.caption && <figcaption>{node.attrs.caption}</figcaption>}
    </NodeViewWrapper>
  );
}

export const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { mediaId: { default: null }, alt: { default: '' }, caption: { default: '' } };
  },
  renderHTML() { return ['figure', { 'data-editor-image': '' }]; },
  addNodeView() { return ReactNodeViewRenderer(ImageView); },
});
