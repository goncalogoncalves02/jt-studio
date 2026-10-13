import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { HelmetProvider } from 'react-helmet-async';
import { StaticRouter } from 'react-router-dom';
import App from './App.jsx';
import { PublicDataProvider } from './blog/PublicDataProvider.jsx';
import { HeadDataContext } from './blog/HeadDataContext.js';

/** @param {string} pathname @param {import('./blog/PublicDataContext.js').PublicPageData} pageData */
export function renderRoute(pathname, pageData) {
  const jsonLd = [];
  const markup = renderToString(
    <StrictMode>
      <HelmetProvider>
        <StaticRouter location={pathname}>
          <HeadDataContext.Provider value={jsonLd}>
            <PublicDataProvider value={pageData}>
              <App />
            </PublicDataProvider>
          </HeadDataContext.Provider>
        </StaticRouter>
      </HelmetProvider>
    </StrictMode>,
  );
  return { markup, jsonLd };
}
