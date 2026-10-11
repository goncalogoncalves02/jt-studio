import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { composeHtml } from './render-html.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = ['/', '/servicos', '/info', '/galeria', '/contactos'];
const aliases = routes.filter((route) => route !== '/').map((route) => `${route}/`);

function createPageData(release) {
  if (
    !release
    || release.schemaVersion !== 1
    || !Array.isArray(release.posts)
    || release.posts.length !== 0
    || typeof release.releaseId !== 'string'
    || !release.releaseId
  ) {
    throw new Error('Task 1 fixture build requires an explicit empty schemaVersion 1 release');
  }
  return { releaseId: release.releaseId, index: [], post: null };
}

/** Build an explicit fixture release. Confirmed production release sourcing is added in Task 8. */
export async function buildBlog({ mode, release, outDir } = {}) {
  if (mode !== 'fixture') {
    throw new Error('Confirmed-release sourcing is not installed; use the legacy build or an explicit fixture build');
  }
  if (!release) throw new Error('Fixture mode requires an explicit release path or release object');
  const releaseData = typeof release === 'string'
    ? JSON.parse(await readFile(path.resolve(projectRoot, release), 'utf8'))
    : release;
  const pageData = createPageData(releaseData);
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
  ];
  for (const { route, file } of outputs) {
    const html = composeHtml(template, serverEntry.renderRoute(route, pageData), pageData);
    await mkdir(siteDir, { recursive: true });
    const outputPath = path.join(siteDir, file);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html);
  }

  const manifest = { mode, releaseId: releaseData.releaseId, routes, aliases, clientDir, serverDir, siteDir };
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
