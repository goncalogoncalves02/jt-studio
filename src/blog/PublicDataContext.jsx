/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react';

/** @typedef {{ releaseId: string | null, index: object[], post: object | null }} PublicPageData */

const emptyPageData = Object.freeze({ releaseId: null, index: [], post: null });
const PublicDataContext = createContext(emptyPageData);

/** @param {{ value?: PublicPageData, children: import('react').ReactNode }} props */
export function PublicDataProvider({ value, children }) {
  return <PublicDataContext.Provider value={value ?? emptyPageData}>{children}</PublicDataContext.Provider>;
}

export function usePublicPageData() {
  return useContext(PublicDataContext);
}

export { PublicDataContext };
