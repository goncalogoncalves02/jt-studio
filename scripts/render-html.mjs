import { parse, parseFragment, serialize } from 'parse5';
import { safeJson } from '../src/blog/safe-json.js';

function visit(node, callback) {
  callback(node);
  for (const child of node.childNodes ?? []) visit(child, callback);
  if (node.content) visit(node.content, callback);
}

function getAttr(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function setAttr(node, name, value) {
  const existing = node.attrs.find((attribute) => attribute.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

function textNode(value) {
  return { nodeName: '#text', value, parentNode: null };
}

function detach(node) {
  if (!node.parentNode) return;
  const siblings = node.parentNode.childNodes;
  const index = siblings.indexOf(node);
  if (index !== -1) siblings.splice(index, 1);
  node.parentNode = null;
}

/** Compose one rendered React route into the built client document. */
export function composeHtml(template, markup, pageData, jsonLd = []) {
  const document = parse(template);
  let head;
  let root;
  visit(document, (node) => {
    if (node.tagName === 'head') head = node;
    if (node.tagName === 'div' && getAttr(node, 'id') === 'root') root = node;
  });
  if (!head || !root) throw new Error('Client template must contain <head> and #root');

  for (const child of [...head.childNodes]) {
    if (child.tagName === 'title') detach(child);
    if (child.tagName === 'meta' && ['description', 'theme-color'].includes(getAttr(child, 'name'))) detach(child);
    if (child.tagName === 'link' && getAttr(child, 'rel') === 'canonical') detach(child);
    if (child.tagName === 'script' && getAttr(child, 'type') === 'application/ld+json') detach(child);
  }

  const fragment = parseFragment(markup);
  const hoisted = [];
  const content = [];
  for (const child of [...fragment.childNodes]) {
    if (['title', 'meta', 'link'].includes(child.tagName)
        || (child.tagName === 'script' && getAttr(child, 'type') === 'application/ld+json')) hoisted.push(child);
    else content.push(child);
  }

  for (const node of hoisted) {
    detach(node);
    if (node.tagName === 'title' || node.tagName === 'meta' || node.tagName === 'link') setAttr(node, 'data-rh', 'true');
    head.childNodes.push(node);
    node.parentNode = head;
  }
  for (const schema of jsonLd) {
    const script = {
      nodeName: 'script', tagName: 'script',
      attrs: [{ name: 'type', value: 'application/ld+json' }, { name: 'data-jt-jsonld', value: 'true' }],
      namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [textNode(safeJson(schema))], parentNode: head,
    };
    script.childNodes[0].parentNode = script;
    head.childNodes.push(script);
  }
  root.childNodes = content;
  for (const node of content) node.parentNode = root;
  setAttr(root, 'data-prerendered', 'true');

  const bootstrap = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [{ name: 'id', value: 'public-page-data' }, { name: 'type', value: 'application/json' }],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [textNode(safeJson(pageData))],
    parentNode: null,
  };
  const bodyNodes = [];
  visit(document, (node) => { if (node.tagName === 'body') bodyNodes.push(node); });
  const body = bodyNodes[0];
  body.childNodes.splice(body.childNodes.indexOf(root) + 1, 0, bootstrap);
  bootstrap.parentNode = body;
  bootstrap.childNodes[0].parentNode = bootstrap;

  return serialize(document);
}
