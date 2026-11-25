export default function PublicImageFigure({ media, alt, caption, figure = false, eager = false, sizes = '(max-width: 720px) 100vw, 760px', className = '' }) {
  const variants = media?.variants;
  if (!Array.isArray(variants) || variants.length === 0) throw new TypeError('The published image is unavailable.');
  const largest = variants.at(-1);
  const image = (
    <img
      src={largest.url}
      srcSet={variants.map((variant) => `${variant.url} ${variant.width}w`).join(', ')}
      sizes={figure ? '(max-width: 720px) calc(100vw - 44px), 760px' : sizes}
      width={largest.width}
      height={largest.height}
      alt={alt}
      loading={figure ? 'lazy' : eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      decoding="async"
      className={figure ? 'block h-auto w-full rounded-md' : className}
    />
  );
  if (!figure) return image;
  return <figure className="my-8">{image}{caption ? <figcaption className="mt-2 text-sm text-muted">{caption}</figcaption> : null}</figure>;
}
