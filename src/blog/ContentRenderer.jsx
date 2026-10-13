import PublicImageFigure from './PublicImage.jsx';

function renderNode(node, mediaMap, key) {
  if (!node || typeof node !== 'object') throw new TypeError('The published document is invalid.');
  switch (node.type) {
    case 'text': {
      let content = node.text;
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') content = <strong key={`${key}-bold`}>{content}</strong>;
        else if (mark.type === 'italic') content = <em key={`${key}-italic`}>{content}</em>;
        else if (mark.type === 'link') {
          const href = mark.attrs?.href;
          if (typeof href !== 'string' || !/^(https?:|mailto:|tel:|\/[^/])/u.test(href)) throw new TypeError('The published link is unsafe.');
          const external = /^https?:/u.test(href);
          content = <a key={`${key}-link`} href={href} {...(external ? { rel: 'noreferrer noopener' } : {})}>{content}</a>;
        } else throw new TypeError('The published mark is unsupported.');
      }
      return content;
    }
    case 'hardBreak': return <br key={key} />;
    case 'image': {
      const media = mediaMap.get(node.attrs?.mediaId);
      if (!media) throw new TypeError('The published document references unavailable media.');
      return <PublicImageFigure key={key} media={media} alt={node.attrs.alt} caption={node.attrs.caption} figure />;
    }
    case 'paragraph':
    case 'heading':
    case 'bulletList':
    case 'orderedList':
    case 'listItem': {
      const tag = node.type === 'heading' ? `h${node.attrs?.level}`
        : ({ paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li' })[node.type];
      if (!['p', 'h2', 'h3', 'ul', 'ol', 'li'].includes(tag)) throw new TypeError('The published document node is unsupported.');
      const children = (node.content ?? []).map((child, index) => renderNode(child, mediaMap, `${key}-${index}`));
      const Tag = tag;
      return <Tag key={key} className={tag === 'p' ? 'my-5 leading-8 whitespace-pre-wrap' : undefined}>{children}</Tag>;
    }
    case 'doc':
      return node.content.map((child, index) => renderNode(child, mediaMap, `${key}-${index}`));
    default: throw new TypeError('The published document node is unsupported.');
  }
}

/** Render only validated DocumentV1 nodes. React escapes text and attributes. */
export function renderDocument(document, mediaMap) {
  if (document?.type !== 'doc' || !(mediaMap instanceof Map)) throw new TypeError('The published document is invalid.');
  return renderNode(document, mediaMap, 'document');
}
