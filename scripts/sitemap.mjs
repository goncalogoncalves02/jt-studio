import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_ORIGIN } from './public-files.mjs';

export const legacySitemapRoutes = ['/', '/servicos', '/info', '/galeria', '/contactos'];

export function renderSitemap(routes, origin = CANONICAL_ORIGIN) {
  const urls = routes.map((route) => `${origin}${route === '/' ? '' : route}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`;
}

export async function writeSitemap(directory, routes) {
  await writeFile(path.join(directory, 'sitemap.xml'), renderSitemap(routes));
}
