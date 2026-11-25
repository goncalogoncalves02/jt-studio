import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { composeHtml } from './render-html.mjs';
import { createHash } from 'node:crypto';
import { createPublicPageData, publicRoutePaths, writePublicFiles, CANONICAL_ORIGIN } from './public-files.mjs';
import { acquireBuild, assertBuildCurrent } from './production-release.mjs';
import { renderSitemap } from './sitemap.mjs';
import { publicClientAssets, writeEditorNotices } from './editor-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = ['/', '/servicos', '/info', '/galeria', '/contactos'];
const aliases = routes.filter((route) => route !== '/').map((route) => `${route}/`);
const FIXTURE_STORAGE_ORIGIN = 'https://project.supabase.co';

/** Build an explicit test fixture release or a slot-acquired confirmed production release. */
export async function buildBlog({ mode, release, outDir, env = process.env, rpc, fetchImpl, netlifyClient } = {}) {
  if (mode !== 'fixture' && mode !== 'production') {
    throw new Error('Build mode must be fixture or production');
  }
  let releaseEnvelope;
  let publicStorageOrigin;
  let deployId;
  let generation;
  let finalSiteDir;
  let siteDir;
  let serverDir;
  let tempSsrRoot = null;
  let stagingRoot = null;
  let target;

  if (mode === 'production') {
    const acquired = await acquireBuild({ env, rpc, fetchImpl, netlifyClient });
    releaseEnvelope = { releaseId: acquired.releaseId, payload: acquired.payload, digest: acquired.digest };
    publicStorageOrigin = acquired.publicStorageOrigin;
    deployId = acquired.deployId;
    generation = acquired.generation;
    finalSiteDir = path.resolve(projectRoot, outDir ?? 'dist');
    const ssrBase = path.join(projectRoot, 'dist-ssr');
    await mkdir(ssrBase, { recursive: true });
    await mkdir(path.dirname(finalSiteDir), { recursive: true });
    tempSsrRoot = await mkdtemp(path.join(ssrBase, 'run-'));
    stagingRoot = await mkdtemp(path.join(path.dirname(finalSiteDir), '.jt-stage-'));
    siteDir = path.join(stagingRoot, 'site');
    serverDir = tempSsrRoot;
  } else {
    if (!release) throw new Error('Fixture mode requires an explicit release path or release object');
    const rawPayload = typeof release === 'string' ? await readFile(path.resolve(projectRoot, release), 'utf8') : undefined;
    const releaseData = rawPayload === undefined ? release : JSON.parse(rawPayload);
    const payload = typeof releaseData?.payload === 'string' ? releaseData.payload : rawPayload ?? JSON.stringify(releaseData);
    releaseEnvelope = {
      releaseId: releaseData?.releaseId,
      payload,
      digest: releaseData?.digest ?? createHash('sha256').update(payload, 'utf8').digest('hex'),
    };
    publicStorageOrigin = env.PUBLIC_STORAGE_ORIGIN || FIXTURE_STORAGE_ORIGIN;
    deployId = env.DEPLOY_ID || 'fixture';
    target = path.resolve(projectRoot, outDir ?? 'dist/fixture');
    siteDir = path.join(target, 'site');
    serverDir = path.join(target, 'ssr');
  }

  try {
    const blogRoutes = publicRoutePaths(releaseEnvelope, publicStorageOrigin);
    const clientDir = siteDir;

    const clientBuild = await build({ configFile: path.join(projectRoot, 'vite.config.js'), root: projectRoot, base: '/', build: { outDir: clientDir, emptyOutDir: true } });
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

    const publicAssets = publicClientAssets(clientBuild);
    await writeEditorNotices(siteDir, projectRoot);
    const publicManifest = await writePublicFiles(releaseEnvelope, siteDir, { deployId, publicStorageOrigin });
    const sitemapRoutes = [...routes, '/blog', ...blogRoutes];
    const sitemap = renderSitemap(sitemapRoutes, CANONICAL_ORIGIN);
    await writeFile(path.join(siteDir, 'sitemap.xml'), sitemap);

    if (mode === 'production') {
      await assertBuildCurrent({ deployId, releaseId: releaseEnvelope.releaseId, generation, env, rpc, fetchImpl });
      await mkdir(path.dirname(finalSiteDir), { recursive: true });
      const backupDir = path.join(stagingRoot, 'backup');
      let hasBackup = false;
      try {
        await rename(finalSiteDir, backupDir);
        hasBackup = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        await rename(siteDir, finalSiteDir);
      } catch (err) {
        if (hasBackup) {
          try {
            await rename(backupDir, finalSiteDir);
          } catch (restoreError) {
            stagingRoot = null;
            throw new Error(`Previous build output retained at ${backupDir}.`, { cause: restoreError });
          }
        }
        throw err;
      }
      return { mode, releaseId: releaseEnvelope.releaseId, deployId, routes: [...routes, '/blog', ...blogRoutes, '/admin', '/404'], aliases, siteDir: finalSiteDir, publicManifest };
    }

    const manifest = { mode, releaseId: releaseEnvelope.releaseId, routes: [...routes, '/blog', ...blogRoutes, '/admin', '/404'], aliases, clientDir, serverDir, siteDir, publicManifest, publicAssets };
    await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    if (tempSsrRoot) await rm(tempSsrRoot, { recursive: true, force: true }).catch(() => {});
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function argumentValue(name, args) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args.includes('--production') ? 'production' : argumentValue('--mode', args);
  const release = argumentValue('--release', args);
  const outDir = argumentValue('--outDir', args);
  await buildBlog({ mode, release, outDir });
}
