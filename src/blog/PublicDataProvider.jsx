import { emptyPublicPageData, PublicDataContext } from './PublicDataContext.js';

/** @param {{ value?: import('./PublicDataContext.js').PublicPageData, children: import('react').ReactNode }} props */
export function PublicDataProvider({ value, children }) {
  return <PublicDataContext.Provider value={value ?? emptyPublicPageData}>{children}</PublicDataContext.Provider>;
}
