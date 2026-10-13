import assert from 'node:assert/strict';
import test from 'node:test';
import { assertScriptIntegrity } from '../../scripts/check-public-artifacts.mjs';

const trustedScripts = [{
  attributes: [{ name: 'src', value: 'https://trusted.example/app.js' }],
  text: '',
}];
const safeLiteral = `</script><script>alert(1)</script>`;
const documentWithSafeMetadata = (extraScript = '') => `<!doctype html><html><head>
  <meta name="description" content="Quoted &quot;value&quot;: ${safeLiteral}">
  <script src="https://trusted.example/app.js"></script>
  <script type="application/ld+json" data-jt-jsonld="true">{"@type":"Blog"}</script>
  </head><body><script id="public-page-data" type="application/json">{"releaseId":"fixture"}</script>
  ${extraScript}<div id="root"></div></body></html>`;

test('parse-based script checker accepts dangerous-looking text confined to a metadata attribute', () => {
  assert.doesNotThrow(() => assertScriptIntegrity(documentWithSafeMetadata(), trustedScripts, '/'));
});

test('parse-based script checker rejects an actual unexpected executable script node', () => {
  assert.throws(() => assertScriptIntegrity(
    documentWithSafeMetadata('<script>alert(1)</script>'), trustedScripts, '/',
  ), /only trusted executable script nodes/u);
});
