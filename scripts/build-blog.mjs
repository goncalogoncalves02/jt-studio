import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { composeHtml } from './render-html.mjs';
import { createHash } from 'node:crypto';
import { createPublicPageData, publicRoutePaths, writePublicFiles, CANONICAL_ORIGIN } from './public-files.mjs';
import { renderSitemap } from './sitemap.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = ['/', '/servicos', '/info', '/galeria', '/contactos'];
const aliases = routes.filter((route) => route !== '/').map((route) => `${route}/`);
const FIXTURE_STORAGE_ORIGIN = 'https://project.supabase.co';

/** Build only an explicit test fixture release. Confirmed production sourcing is added in Task 8. */
export async function buildBlog({ mode, release, outDir } = {}) {
  if (mode !== 'fixture') {
    throw new Error('Confirmed-release sourcing is not installed; use the legacy build or an explicit fixture build');
  }
  if (!release) throw new Error('Fixture mode requires an explicit release path or release object');
  const rawPayload = typeof release === 'string' ? await readFile(path.resolve(projectRoot, release), 'utf8') : undefined;
  const releaseData = rawPayload === undefined ? release : JSON.parse(rawPayload);
  const payload = typeof releaseData?.payload === 'string' ? releaseData.payload : rawPayload ?? JSON.stringify(releaseData);
  const releaseEnvelope = {
    releaseId: releaseData?.releaseId,
    payload,
    digest: releaseData?.digest ?? createHash('sha256').update(payload, 'utf8').digest('hex'),
  };
  const publicStorageOrigin = process.env.PUBLIC_STORAGE_ORIGIN || FIXTURE_STORAGE_ORIGIN;
  const blogRoutes = publicRoutePaths(releaseEnvelope, publicStorageOrigin);
  const target = path.resolve(projectRoot, outDir ?? 'dist/fixture');
  const siteDir = path.join(target, 'site');
  const clientDir = siteDir;
  const serverDir = path.join(target, 'ssr');

  await build({ configFile: path.join(projectRoot, 'vite.config.js'), root: projectRoot, base: '/', build: { outDir: clientDir, emptyOutDir: true } });
  await build({ configFile: path.join(projectRoot, 'vite.config.js'), root: projectRoot, base: '/', build: { outDir: serverDir, emptyOutDir: true, ssr: path.join(projectRoot, 'src/entry-server.jsx') } });

  const template = await readFile(path.join(clientDir, 'index.html'), 'utf8');
  const serverEntry = await import(pathToFileURL(path.join(serverDir, 'entry-server.js')).href);
  const outputs = [
    ...routes.map((route) => ({ route, file: route === '/' ? 'index.html' : `${route.slice(1)}.html` })),
    ...aliases.map((route) => ({ route, file: path.join(route.slice(1), 'index.html') })),
    { route: '/blog', file: 'blog.html' },
    ...blogRoutes.map((route) => ({ route, file: `${route.slice(1)}.html` })),
    { route: '/admin', file: 'admin.html' },
    { route: '/404', file: '404.html' },
  ];
  for (const { route, file } of outputs) {
    const routeData = createPublicPageData(releaseEnvelope, route, publicStorageOrigin);
    const rendered = serverEntry.renderRoute(route, routeData);
    const html = composeHtml(template, rendered.markup, routeData, rendered.jsonLd);
    await mkdir(siteDir, { recursive: true });
    const outputPath = path.join(siteDir, file);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html);
  }

  const publicManifest = await writePublicFiles(releaseEnvelope, siteDir, { deployId: process.env.DEPLOY_ID || 'fixture', publicStorageOrigin });
  const sitemapRoutes = [...routes, '/blog', ...blogRoutes];
  const sitemap = renderSitemap(sitemapRoutes, CANONICAL_ORIGIN);
  await writeFile(path.join(siteDir, 'sitemap.xml'), sitemap);

  const manifest = { mode, releaseId: releaseEnvelope.releaseId, routes: [...routes, '/blog', ...blogRoutes, '/admin', '/404'], aliases, clientDir, serverDir, siteDir, publicManifest };
  await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function argumentValue(name, args) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = argumentValue('--mode', args);
  const release = argumentValue('--release', args);
  const outDir = argumentValue('--outDir', args);
  await buildBlog({ mode, release, outDir });
}
