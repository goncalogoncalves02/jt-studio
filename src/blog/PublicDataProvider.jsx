import { emptyPublicPageData, PublicDataContext } from './PublicDataContext.js';
import { createPublicDataApi } from './public-data.js';
import { useMemo } from 'react';

/** @param {{ value?: import('./PublicDataContext.js').PublicPageData, children: import('react').ReactNode }} props */
export function PublicDataProvider({ value, children }) {
  const pageData = value ?? emptyPublicPageData;
  const api = useMemo(() => createPublicDataApi(pageData.releaseId), [pageData.releaseId]);
  return <PublicDataContext.Provider value={{ ...pageData, api }}>{children}</PublicDataContext.Provider>;
}
