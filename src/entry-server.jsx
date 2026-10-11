import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { HelmetProvider } from 'react-helmet-async';
import { StaticRouter } from 'react-router-dom';
import App from './App.jsx';
import { PublicDataProvider } from './blog/PublicDataContext.jsx';

/** @param {string} pathname @param {import('./blog/PublicDataContext.jsx').PublicPageData} pageData */
export function renderRoute(pathname, pageData) {
  return renderToString(
    <StrictMode>
      <HelmetProvider>
        <StaticRouter location={pathname}>
          <PublicDataProvider value={pageData}>
            <App />
          </PublicDataProvider>
        </StaticRouter>
      </HelmetProvider>
    </StrictMode>,
  );
}
