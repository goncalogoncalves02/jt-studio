import { createContext } from 'react';

export const DraftMediaContext = createContext(new Map());

export function previewMedia(media) {
  return {
    id: media.id,
    variants: media.variants.map(({ width, height }) => ({
      width, height, url: '/api/admin/media/preview?' + new URLSearchParams({ mediaId: media.id, width: String(width) }),
    })),
  };
}
