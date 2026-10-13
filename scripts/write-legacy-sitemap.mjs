import { writeSitemap, legacySitemapRoutes } from './sitemap.mjs';

await writeSitemap('dist', legacySitemapRoutes);
