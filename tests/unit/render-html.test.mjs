import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'parse5';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'dist/fixture/site');
const routes = ['/', '/servicos', '/info', '/galeria', '/contactos'];
const routeFiles = routes.map((route) =>
  path.join(output, route === '/' ? 'index.html' : `${route.slice(1)}.html`),
);

function walk(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  for (const child of node.childNodes ?? []) walk(child, predicate, matches);
  if (node.content) walk(node.content, predicate, matches);
  return matches;
}

function attr(node, name) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

test('render_html_keeps_assets_and_moves_metadata_to_head', () => {
  const file = path.join(output, 'index.html');
  assert.ok(existsSync(file), 'build output should exist before inspecting rendered HTML');
  const document = parse(readFileSync(file, 'utf8'));
  const head = walk(document, (node) => node.tagName === 'head')[0];
  const titles = walk(head, (node) => node.tagName === 'title');
  const descriptions = walk(head, (node) => node.tagName === 'meta' && attr(node, 'name') === 'description');
  const canonicals = walk(head, (node) => node.tagName === 'link' && attr(node, 'rel') === 'canonical');
  const openGraphUrl = walk(head, (node) => node.tagName === 'meta' && attr(node, 'property') === 'og:url');
  const openGraphTitle = walk(head, (node) => node.tagName === 'meta' && attr(node, 'property') === 'og:title');
  const openGraphDescription = walk(head, (node) => node.tagName === 'meta' && attr(node, 'property') === 'og:description');
  const businessData = walk(document, (node) => node.tagName === 'script' && attr(node, 'type') === 'application/ld+json')
    .filter((node) => {
      try { return JSON.parse(node.childNodes?.map((child) => child.value ?? '').join(''))['@type'] === 'BeautySalon'; } catch { return false; }
    });
  const assets = walk(document, (node) =>
    (node.tagName === 'script' && attr(node, 'type') === 'module')
    || (node.tagName === 'link' && attr(node, 'rel') === 'stylesheet'),
  ).map((node) => attr(node, node.tagName === 'script' ? 'src' : 'href')).filter(Boolean);

  assert.equal(titles.length, 1, 'exactly one page title belongs in head');
  assert.equal(descriptions.length, 1, 'exactly one description belongs in head');
  assert.equal(canonicals.length, 1, 'exactly one canonical belongs in head');
  assert.equal(businessData.length, 1, 'BeautySalon structured data must appear exactly once');
  assert.match(titles[0].childNodes[0]?.value ?? '', /JT Studio/);
  assert.match(attr(descriptions[0], 'content') ?? '', /Setúbal/);
  assert.equal(attr(canonicals[0], 'href'), 'https://jaquelinetakiutistudio.com');
  assert.equal(attr(openGraphUrl[0], 'content'), attr(canonicals[0], 'href'));
  assert.equal(attr(openGraphTitle[0], 'content'), titles[0].childNodes[0]?.value);
  assert.equal(attr(openGraphDescription[0], 'content'), attr(descriptions[0], 'content'));
  assert.ok(assets.length > 0, 'the built client entry asset must be preserved');
  for (const asset of assets.filter((value) => value.startsWith('/'))) {
    assert.ok(existsSync(path.join(output, asset.slice(1))), `${asset} must exist in the output`);
  }
});

test('safe_bootstrap_cannot_close_script', async () => {
  const modulePath = path.join(root, 'src/blog/safe-json.js');
  assert.ok(existsSync(modulePath), 'the public bootstrap serializer should be implemented');
  const { safeJson } = await import(pathToFileURL(modulePath));
  const encoded = safeJson({ title: '</script><script>alert(1)</script>' });
  assert.doesNotMatch(encoded, /<\s*\/\s*script/i, 'serialized data must not terminate its script element');
  assert.deepEqual(JSON.parse(encoded), { title: '</script><script>alert(1)</script>' });
});


test('five_routes_keep_their_content', () => {
  const markers = ['Beleza', 'Seis técnicas.', 'Perguntas Frequentes', 'O trabalho', 'Marque a'];
  for (let index = 0; index < routes.length; index += 1) {
    const file = routeFiles[index];
    assert.ok(existsSync(file), `${routes[index]} must have its own pre-rendered HTML document`);
    const document = parse(readFileSync(file, 'utf8'));
    const rootNode = walk(document, (node) => node.tagName === 'div' && attr(node, 'id') === 'root')[0];
    const main = walk(rootNode, (node) => node.tagName === 'main')[0];
    const mainText = walk(main, (node) => node.nodeName === '#text').map((node) => node.value).join(' ');
    assert.ok(mainText.includes(markers[index]), `${routes[index]} must include page content in raw HTML`);
    const canonical = walk(document, (node) => node.tagName === 'link' && attr(node, 'rel') === 'canonical')[0];
    const expectedCanonical = `https://jaquelinetakiutistudio.com${routes[index] === '/' ? '' : routes[index]}`;
    assert.equal(attr(canonical, 'href'), expectedCanonical, `${routes[index]} must use its no-slash canonical URL`);
    const jsonLdTypes = walk(document, (node) => node.tagName === 'script' && attr(node, 'type') === 'application/ld+json')
      .map((node) => { try { return JSON.parse(node.childNodes?.map((child) => child.value ?? '').join(''))['@type']; } catch { return null; } });
    if (routes[index] === '/servicos') assert.ok(jsonLdTypes.includes('ItemList'), 'services structured data must survive composition');
    if (routes[index] === '/info') assert.ok(jsonLdTypes.includes('FAQPage'), 'FAQ structured data must survive composition');
  }
});
