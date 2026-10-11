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

if (rootElement?.dataset.prerendered === 'true') hydrateRoot(rootElement, application);
else createRoot(rootElement).render(application);
