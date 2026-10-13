import { emptyPublicPageData, PublicDataContext } from './PublicDataContext.js';
import { createPublicDataApi } from './public-data.js';
import { useEffect, useMemo, useState } from 'react';

/** @param {{ value?: import('./PublicDataContext.js').PublicPageData, children: import('react').ReactNode }} props */
export function PublicDataProvider({ value, children }) {
  const pageData = value ?? emptyPublicPageData;
  const [hydrated, setHydrated] = useState(false);
  const api = useMemo(() => createPublicDataApi(pageData.releaseId), [pageData.releaseId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setHydrated(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <PublicDataContext.Provider value={{ ...pageData, notFound: pageData.notFound && !hydrated, api }}>{children}</PublicDataContext.Provider>;
}
