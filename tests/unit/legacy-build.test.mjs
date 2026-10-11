import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(path.join(root, 'dist/index.html'), 'utf8');
const expectedDescription = 'Micropigmentação, Nanoblading e Estética Avançada no JT Studio em Setúbal. Avaliação 4.9★ no Google. Agende já a sua sessão.';
const expectedBusinessData = {
  '@context': 'https://schema.org',
  '@type': 'BeautySalon',
  name: 'Jaqueline Takiuti Studio',
  alternateName: 'JT Studio',
  url: 'https://jaquelinetakiutistudio.com',
  logo: 'https://jaquelinetakiutistudio.com/favicon.png',
  image: 'https://jaquelinetakiutistudio.com/og-image.png',
  description: expectedDescription,
  telephone: '+351962149209',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Estrada das Machadas, nº 3C',
    addressLocality: 'Setúbal',
    postalCode: '2900-466',
    addressCountry: 'PT',
  },
  geo: { '@type': 'GeoCoordinates', latitude: 38.532176, longitude: -8.898165 },
  sameAs: ['https://www.instagram.com/jtmicroblading/'],
  priceRange: '€€',
  areaServed: [
    { '@type': 'City', name: 'Setúbal' },
    { '@type': 'City', name: 'Palmela' },
    { '@type': 'City', name: 'Azeitão' },
    { '@type': 'City', name: 'Sesimbra' },
    { '@type': 'City', name: 'Pinhal Novo' },
  ],
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', bestRating: '5', ratingCount: 100 },
  openingHoursSpecification: {
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    opens: '09:00',
    closes: '20:00',
  },
  potentialAction: {
    '@type': 'ReserveAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: 'https://www.sumupbookings.com/takiuti-studio',
      actionPlatform: 'http://schema.org/DesktopWebPlatform',
    },
    result: { '@type': 'Reservation', name: 'Agendar sessão' },
  },
};

function walk(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  for (const child of node.childNodes ?? []) walk(child, predicate, matches);
  if (node.content) walk(node.content, predicate, matches);
  return matches;
}

function attr(node, name) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

test('legacy_build_preserves_static_metadata_before_javascript', () => {
  const document = parse(html);
  const titles = walk(document, (node) => node.tagName === 'title');
  const descriptions = walk(document, (node) => node.tagName === 'meta' && attr(node, 'name') === 'description');
  const themes = walk(document, (node) => node.tagName === 'meta' && attr(node, 'name') === 'theme-color');
  const schemas = walk(document, (node) => node.tagName === 'script' && attr(node, 'type') === 'application/ld+json');
  const bootstrap = walk(document, (node) => attr(node, 'id') === 'public-page-data');

  assert.equal(titles.length, 1);
  assert.equal(titles[0].childNodes[0]?.value, 'JT Studio | Micropigmentação & Estética');
  assert.equal(descriptions.length, 1);
  assert.equal(attr(descriptions[0], 'content'), expectedDescription);
  assert.equal(themes.length, 1);
  assert.equal(attr(themes[0], 'content'), '#B0264A');
  assert.equal(schemas.length, 1);
  assert.deepEqual(JSON.parse(schemas[0].childNodes.map((child) => child.value ?? '').join('')), expectedBusinessData);
  assert.equal(bootstrap.length, 0, 'legacy output remains a client shell, not a fixture build');
});
