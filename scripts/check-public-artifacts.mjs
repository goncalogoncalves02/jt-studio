import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.resolve(projectRoot, process.argv[2] ?? 'dist/fixture/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.mode, 'fixture', 'artifact checker expects an explicitly selected fixture build');
const siteDir = path.resolve(manifest.siteDir);

function visit(node, callback) {
  callback(node);
  for (const child of node.childNodes ?? []) visit(child, callback);
  if (node.content) visit(node.content, callback);
}

function attr(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function text(node) {
  return (node.childNodes ?? []).map((child) => child.value ?? text(child)).join('');
}

const outputs = [
  ...manifest.routes.map((route) => ({ route, file: route === '/' ? 'index.html' : `${route.slice(1)}.html` })),
  ...(manifest.aliases ?? []).map((route) => ({ route, file: path.join(route.slice(1), 'index.html') })),
];

for (const { route, file } of outputs) {
  const htmlPath = path.join(siteDir, file);
  assert.ok(existsSync(htmlPath), `${route} has a pre-rendered HTML file`);
  const document = parse(readFileSync(htmlPath, 'utf8'));
  const nodes = [];
  visit(document, (node) => nodes.push(node));
  const head = nodes.find((node) => node.tagName === 'head');
  const titles = nodes.filter((node) => node.tagName === 'title');
  const descriptions = nodes.filter((node) => node.tagName === 'meta' && attr(node, 'name') === 'description');
  const canonicals = nodes.filter((node) => node.tagName === 'link' && attr(node, 'rel') === 'canonical');
  const salonSchemas = nodes.filter((node) => {
    if (node.tagName !== 'script' || attr(node, 'type') !== 'application/ld+json') return false;
    try { return JSON.parse(text(node))['@type'] === 'BeautySalon'; } catch { return false; }
  });
  const root = nodes.find((node) => node.tagName === 'div' && attr(node, 'id') === 'root');
  const bootstrap = nodes.find((node) => node.tagName === 'script' && attr(node, 'id') === 'public-page-data');
  assert.ok(head && root && attr(root, 'data-prerendered') === 'true', `${route} has a server-rendered root`);
  assert.equal(titles.length, 1, `${route} has one title`);
  assert.equal(descriptions.length, 1, `${route} has one description`);
  assert.equal(canonicals.length, 1, `${route} has one canonical`);
  assert.equal(salonSchemas.length, 1, `${route} has one BeautySalon schema`);
  assert.ok(attr(canonicals[0], 'href')?.startsWith('https://'), `${route} canonical is absolute`);
  assert.ok(bootstrap, `${route} includes hydration data`);
  JSON.parse(text(bootstrap));

  const assets = nodes.flatMap((node) => {
    if (node.tagName === 'script' && attr(node, 'src')) return [attr(node, 'src')];
    if (node.tagName === 'link' && ['stylesheet', 'icon', 'manifest', 'apple-touch-icon'].includes(attr(node, 'rel'))) return [attr(node, 'href')];
    if (node.tagName === 'img' && attr(node, 'src')) return [attr(node, 'src')];
    return [];
  });
  for (const asset of assets) {
    if (asset.startsWith('/')) assert.ok(existsSync(path.join(siteDir, asset.slice(1))), `${route} references existing asset ${asset}`);
  }
}

console.log(`Checked ${outputs.length} pre-rendered route documents and their local assets.`);
