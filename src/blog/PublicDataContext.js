import { createContext, useContext } from 'react';

/** @typedef {{ releaseId: string | null, index: object[], post: object | null }} PublicPageData */

export const emptyPublicPageData = Object.freeze({ releaseId: null, index: [], post: null });

export const PublicDataContext = createContext(emptyPublicPageData);

export function usePublicPageData() {
  return useContext(PublicDataContext);
}
