import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import './index.css';
import App from './App.jsx';
import { PublicDataProvider } from './blog/PublicDataProvider.jsx';

const rootElement = document.getElementById('root');
const bootstrap = document.getElementById('public-page-data');
const pageData = bootstrap ? JSON.parse(bootstrap.textContent) : undefined;
const application = (
  <StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <PublicDataProvider value={pageData}>
          <App />
        </PublicDataProvider>
      </BrowserRouter>
    </HelmetProvider>
  </StrictMode>
);

function removeLegacyTemplateMetadata() {
  document.head.querySelectorAll('title, meta[name="description"], meta[name="theme-color"]').forEach((node) => node.remove());
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    try {
      if (JSON.parse(node.textContent)['@type'] === 'BeautySalon') node.remove();
    } catch {
      // Keep unrelated or invalid JSON-LD untouched.
    }
  });
}

if (rootElement?.dataset.prerendered === 'true') {
  hydrateRoot(rootElement, application);
} else {
  removeLegacyTemplateMetadata();
  createRoot(rootElement).render(application);
}
