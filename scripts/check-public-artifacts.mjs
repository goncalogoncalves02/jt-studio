import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function visit(node, callback) {
  callback(node);
  for (const child of node.childNodes ?? []) visit(child, callback);
  if (node.content) visit(node.content, callback);
}
function attr(node, name) { return node.attrs?.find((entry) => entry.name === name)?.value; }
function text(node) { return (node.childNodes ?? []).map((child) => child.value ?? text(child)).join(''); }
function routeFile(route) {
  if (route === '/') return 'index.html';
  if (route === '/blog') return 'blog.html';
  if (route === '/admin') return 'admin.html';
  if (route === '/404') return '404.html';
  if (route.startsWith('/blog/')) return `${route.slice(1)}.html`;
  return `${route.slice(1)}.html`;
}
function listFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(path.join(root, entry.name), relative) : [relative];
  });
}

export function checkPublicArtifacts(outDir, expectedReleaseId) {
  const siteDir = path.resolve(outDir);
  const releaseManifest = JSON.parse(readFileSync(path.join(siteDir, 'blog-release.json'), 'utf8'));
  assert.deepEqual(Object.keys(releaseManifest).sort(), ['deployId', 'digest', 'releaseId', 'schema']);
  assert.equal(releaseManifest.schema, 1);
  assert.match(releaseManifest.releaseId, /^[0-9a-f-]{36}$/iu);
  assert.match(releaseManifest.digest, /^[a-f0-9]{64}$/u);
  if (expectedReleaseId) assert.equal(releaseManifest.releaseId, expectedReleaseId);

  const indexPath = path.join(siteDir, 'blog-data', releaseManifest.releaseId, 'index.json');
  const indexText = readFileSync(indexPath, 'utf8');
  const index = JSON.parse(indexText);
  assert.ok(Array.isArray(index));
  assert.doesNotMatch(indexText, /"document"\s*:/u, 'the versioned index must not contain article bodies');
  const routes = ['/', '/servicos', '/info', '/galeria', '/contactos', '/blog', '/admin', '/404', ...index.map((post) => `/blog/${post.slug}`)];
  const aliases = ['/servicos/', '/info/', '/galeria/', '/contactos/'];
  const schemaCounts = new Map();
  for (const route of routes) {
    const htmlPath = path.join(siteDir, routeFile(route));
    assert.ok(existsSync(htmlPath), `${route} has a pre-rendered HTML document`);
    const source = readFileSync(htmlPath, 'utf8');
    assert.doesNotMatch(source, /<script>alert\(1\)<\/script>/iu, `${route} cannot terminate an inline script`);
    const document = parse(source);
    const nodes = [];
    visit(document, (node) => nodes.push(node));
    const head = nodes.find((node) => node.tagName === 'head');
    const headNodes = [];
    visit(head, (node) => headNodes.push(node));
    const titles = headNodes.filter((node) => node.tagName === 'title');
    const descriptions = headNodes.filter((node) => node.tagName === 'meta' && attr(node, 'name') === 'description');
    const canonicals = headNodes.filter((node) => node.tagName === 'link' && attr(node, 'rel') === 'canonical');
    const roots = nodes.filter((node) => node.tagName === 'div' && attr(node, 'id') === 'root');
    const bootstraps = nodes.filter((node) => node.tagName === 'script' && attr(node, 'id') === 'public-page-data');
    const schemas = headNodes.filter((node) => node.tagName === 'script' && attr(node, 'type') === 'application/ld+json').map((node) => JSON.parse(text(node)));
    assert.equal(titles.length, 1, `${route} has one title in head`);
    assert.equal(descriptions.length, 1, `${route} has one description in head`);
    assert.equal(canonicals.length, 1, `${route} has one canonical in head`);
    assert.equal(roots.length, 1, `${route} has one app root`);
    assert.equal(attr(roots[0], 'data-prerendered'), 'true');
    assert.equal(bootstraps.length, 1, `${route} has one hydration bootstrap`);
    assert.equal(attr(canonicals[0], 'href'), `https://jaquelinetakiutistudio.com${route === '/' ? '' : route.replace(/\/$/u, '')}`);
    const bootstrap = JSON.parse(text(bootstraps[0]));
    assert.equal(bootstrap.releaseId, releaseManifest.releaseId, `${route} uses the pinned release`);
    if (route === '/blog') {
      assert.deepEqual(bootstrap.index.map((post) => post.slug), index.map((post) => post.slug));
      assert.equal(bootstrap.post, null);
      assert.equal(schemas.filter((schema) => schema['@type'] === 'Blog').length, 1);
    }
    if (route.startsWith('/blog/')) {
      const slug = route.slice('/blog/'.length);
      assert.equal(bootstrap.post?.slug, slug, `${route} bootstraps only its routed post`);
      assert.equal(bootstrap.index.length, 0, `${route} does not bootstrap the full index`);
      assert.equal(schemas.filter((schema) => schema['@type'] === 'BlogPosting').length, 1);
    }
    if (route === '/admin' || route === '/404') assert.equal(headNodes.filter((node) => node.tagName === 'meta' && attr(node, 'name') === 'robots' && attr(node, 'content')?.includes('noindex')).length, 1);
    const types = schemas.map((schema) => schema['@type']);
    assert.equal(new Set(types).size, types.length, `${route} has no duplicate JSON-LD types`);
    for (const type of types) schemaCounts.set(type, (schemaCounts.get(type) ?? 0) + 1);
    const assets = nodes.flatMap((node) => {
      if (node.tagName === 'script' && attr(node, 'src')) return [attr(node, 'src')];
      if (node.tagName === 'link' && ['stylesheet', 'icon', 'manifest', 'apple-touch-icon'].includes(attr(node, 'rel'))) return [attr(node, 'href')];
      if (node.tagName === 'img' && attr(node, 'src')) return [attr(node, 'src')];
      return [];
    });
    for (const asset of assets) if (asset.startsWith('/')) assert.ok(existsSync(path.join(siteDir, asset.slice(1))), `${route} asset ${asset} exists`);
  }
  for (const route of aliases) assert.ok(existsSync(path.join(siteDir, route.slice(1), 'index.html')), `${route} alias exists`);

  for (const summary of index) {
    assert.ok(!Object.hasOwn(summary, 'document'));
    const postText = readFileSync(path.join(siteDir, 'blog-data', releaseManifest.releaseId, 'posts', `${summary.slug}.json`), 'utf8');
    const post = JSON.parse(postText);
    assert.equal(post.slug, summary.slug);
    assert.ok(Object.hasOwn(post, 'document'));
    assert.doesNotMatch(postText, /blog-drafts|\/object\/sign\/|[?&]token=/iu);
  }
  const sitemap = readFileSync(path.join(siteDir, 'sitemap.xml'), 'utf8');
  for (const route of ['/', '/servicos', '/info', '/galeria', '/contactos', '/blog', ...index.map((post) => `/blog/${post.slug}`)]) {
    assert.ok(sitemap.includes(`https://jaquelinetakiutistudio.com${route === '/' ? '' : route}`), `sitemap includes ${route}`);
  }
  assert.doesNotMatch(sitemap, /\/admin|\/404|draft|preview/iu);
  const publicFiles = listFiles(siteDir);
  assert.ok(!publicFiles.some((file) => file.endsWith('.wasm')));
  const clientAssets = publicFiles.filter((file) => file.startsWith('assets/') && /\.(?:js|css)$/u.test(file));
  const banned = /@supabase\/supabase-js|supabase-js|@tiptap|blog-drafts|\/storage\/v1\/object\/sign\/|SUPABASE_SERVICE_ROLE_KEY|INCOMING_HOOK_BODY|\.wasm/iu;
  for (const asset of clientAssets) assert.doesNotMatch(readFileSync(path.join(siteDir, asset), 'utf8'), banned, `${asset} must not contain editorial SDK, private media, server keys, editor or WASM`);
  const redirectRules = readFileSync(path.join(projectRoot, 'public/_redirects'), 'utf8');
  assert.match(redirectRules, /^\/blog\/\* \/404\.html 404$/mu);
  assert.doesNotMatch(redirectRules, /^\/blog\/\* .*404!$/mu);
  const headers = readFileSync(path.join(projectRoot, 'public/_headers'), 'utf8');
  assert.match(headers, /^\/blog-data\/\*\n[ ]{2}Cache-Control: public, max-age=31536000, immutable$/mu);
  assert.doesNotMatch(headers, /max-age=0[^\n]*\n[^\n]*max-age=31536000/u);
  return { routes: routes.length, aliases: aliases.length, posts: index.length, schemas: Object.fromEntries(schemaCounts) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = path.resolve(projectRoot, process.argv[2] ?? 'dist/fixture/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.mode, 'fixture', 'artifact checker expects an explicit fixture build');
  const report = checkPublicArtifacts(manifest.siteDir, manifest.releaseId);
  process.stdout.write(`Checked ${report.routes} prerendered routes, ${report.aliases} aliases, ${report.posts} public posts, versioned data, SEO, sitemap, and browser artifact boundaries.\n`);
}
