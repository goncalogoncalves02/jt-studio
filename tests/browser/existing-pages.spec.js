import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const pages = [
  { path: '/', title: 'JT Studio', marker: 'Micropigmentação' },
  { path: '/servicos', title: 'Serviços', marker: 'Seis técnicas.' },
  { path: '/info', title: 'Info & FAQ', marker: 'Perguntas Frequentes' },
  { path: '/galeria', title: 'Galeria', marker: 'Resultados reais' },
  { path: '/contactos', title: 'Contactos', marker: 'Marque a' },
  { path: '/servicos/', title: 'Serviços', marker: 'Seis técnicas.' },
  { path: '/info/', title: 'Info & FAQ', marker: 'Perguntas Frequentes' },
  { path: '/galeria/', title: 'Galeria', marker: 'Resultados reais' },
  { path: '/contactos/', title: 'Contactos', marker: 'Marque a' },
];

test('five existing routes prerender, hydrate with slash variants, and keep navigation working', async ({ page, request }) => {
  const browserErrors = [];
  const interceptedProviders = new Set();
  const requestedExternalHosts = new Set();
  const providerHosts = new Set([
    'consent.cookiebot.com',
    'www.googletagmanager.com',
    'www.google-analytics.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'maps.googleapis.com',
    'www.google.com',
  ]);

  await page.route(/^https:\/\/(?:consent\.cookiebot\.com|www\.googletagmanager\.com|www\.google-analytics\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|maps\.googleapis\.com|www\.google\.com)\//, async (route) => {
    const url = new URL(route.request().url());
    interceptedProviders.add(url.hostname);
    const resourceType = route.request().resourceType();
    const contentType = resourceType === 'stylesheet' ? 'text/css' : resourceType === 'script' ? 'application/javascript' : 'text/html';
    const body = resourceType === 'document' ? '<!doctype html><html><head></head><body></body></html>' : '';
    await route.fulfill({ status: 200, contentType, body });
  });

  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('request', (requestEvent) => {
    const requestUrl = new URL(requestEvent.url());
    if (requestUrl.origin !== 'http://127.0.0.1:4173') requestedExternalHosts.add(requestUrl.hostname);
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === 'http://127.0.0.1:4173') {
      browserErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  for (const route of pages) {
    const rawResponse = await request.get(route.path);
    expect(rawResponse.ok(), `${route.path} should return a page`).toBeTruthy();
    const prerenderedHtml = await rawResponse.text();
    expect(prerenderedHtml, `${route.path} should include content before JavaScript`).toContain(route.marker);
    const prerenderedCanonical = prerenderedHtml.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const prerenderedMainClass = prerenderedHtml.match(/<main[^>]*\bclass="([^"]*)"/)?.[1] ?? null;

    await page.goto(route.path);
    await expect(page.locator('main')).toContainText(route.marker);
    const effectivePath = new URL(page.url()).pathname;
    expect(effectivePath).toBe(route.path);
    const canonicalPath = effectivePath.replace(/\/+$/, '') || '/';
    const expectedCanonical = `https://jaquelinetakiutistudio.com${canonicalPath === '/' ? '' : canonicalPath}`;
    expect(prerenderedCanonical).toBe(expectedCanonical);
    await expect(page.locator('head title')).toHaveCount(1);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', expectedCanonical);
    await expect(page.locator('main')).toHaveAttribute('class', prerenderedMainClass ?? '');
    if (route.title === 'JT Studio') await expect(page).toHaveTitle(/JT Studio/);
    else await expect(page).toHaveTitle(new RegExp(route.title));
  }

  await page.getByRole('link', { name: /Serviços/i }).first().click();
  await expect(page).toHaveURL(/\/servicos$/);
  await expect(page.locator('main')).toContainText('Seis técnicas.');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jaquelinetakiutistudio.com/servicos');
  expect(interceptedProviders.has('consent.cookiebot.com')).toBeTruthy();
  expect(interceptedProviders.has('www.googletagmanager.com')).toBeTruthy();
  expect([...requestedExternalHosts].every((host) => providerHosts.has(host))).toBeTruthy();
  expect([...requestedExternalHosts].every((host) => interceptedProviders.has(host))).toBeTruthy();
  expect(browserErrors).toEqual([]);
});

test('legacy createRoot replaces template metadata without duplicates', async ({ page }) => {
  const legacyHtml = readFileSync(path.join(projectRoot, 'dist/index.html'), 'utf8');
  const browserErrors = [];
  await page.route(/^https:\/\/(?:consent\.cookiebot\.com|www\.googletagmanager\.com|www\.google-analytics\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|maps\.googleapis\.com|www\.google\.com)\//, async (route) => {
    const resourceType = route.request().resourceType();
    const contentType = resourceType === 'stylesheet' ? 'text/css' : resourceType === 'script' ? 'application/javascript' : 'text/html';
    const body = resourceType === 'document' ? '<!doctype html><html><head></head><body></body></html>' : '';
    await route.fulfill({ status: 200, contentType, body });
  });
  await page.route('http://127.0.0.1:4173/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: legacyHtml }));
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/');
  await expect(page.locator('main')).toContainText('Micropigmentação');
  await expect(page.locator('head title')).toHaveCount(1);
  await expect(page).toHaveTitle('JT Studio | Micropigmentação & Estética');
  await expect(page.locator('meta[name="description"]')).toHaveCount(1);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'JT Studio em Setúbal: especialistas em Nanoblading, Micropigmentação Labial, Soft Eyeliner, Tattoo e Remoção a Laser. Avaliação 4.9★ no Google. Agende já.');
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#be185d');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://jaquelinetakiutistudio.com');
  const businessSchemas = await page.locator('script[type="application/ld+json"]').evaluateAll((scripts) => scripts.flatMap((script) => {
    try {
      const schema = JSON.parse(script.textContent);
      return schema['@type'] === 'BeautySalon' ? [schema] : [];
    } catch {
      return [];
    }
  }));
  expect(businessSchemas).toHaveLength(1);
  expect(businessSchemas[0]).toMatchObject({ name: 'Jaqueline Takiuti Studio', telephone: '+351962149209' });
  await expect(page.locator('#Cookiebot')).toHaveCount(1);
  await expect(page.locator('script[src*="googletagmanager.com/gtag/js"]')).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});
