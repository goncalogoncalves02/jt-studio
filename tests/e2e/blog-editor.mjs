import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import sharp from 'sharp';
import blogSession from '../../netlify/functions/blog-admin.mjs';
import blogPosts from '../../netlify/functions/blog-posts.mjs';
import blogMedia from '../../netlify/functions/blog-media.mjs';
import blogPublication from '../../netlify/functions/blog-publication.mjs';
import { createServerClient, readBlogConfig } from '../../server/blog/config.mjs';
import { buildBlog } from '../../scripts/build-blog.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const project = 'jt-studio-blog-tests';
const site = join(root, 'dist/fixture/site');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

async function localBackend() {
  const docker = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' });
  const endpoint = docker.stdout?.trim();
  assert.ok(docker.status === 0 && endpoint?.startsWith('unix:///'));
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: endpoint.slice('unix://'.length),
    allowedNames: new Set(['db', 'rest', 'auth', 'kong', 'storage'].map((name) => 'supabase_' + name + '_' + project)),
  });
  try {
    const env = createSupabaseCliEnvironment(process.env, await proxy.listen());
    const cli = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cli, '--version'], { cwd: root, env });
    assert.equal(version.stdout.trim(), '2.120.0');
    const result = await runCliCapture(process.execPath, [cli, 'status', '-o', 'json'], { cwd: root, env });
    assert.equal(result.status, 0);
    const status = JSON.parse(result.stdout);
    validateLocalDatabaseTarget(status, project, 54342);
    assert.ok(status.API_URL === 'http://127.0.0.1:54341' && status.ANON_KEY && status.SERVICE_ROLE_KEY);
    return status;
  } finally { await proxy.close(); }
}

async function localEdge(temp) {
  const cert = join(temp, 'localhost.pem');
  const key = join(temp, 'localhost-key.pem');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' }).status, 0);
  const server = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'https://127.0.0.1:' + incoming.socket.localPort);
      const route = url.pathname;
      const handler = route === '/api/admin/session' ? blogSession : route === '/api/admin/posts' ? blogPosts
        : route.startsWith('/api/admin/media/') ? blogMedia : route.startsWith('/api/admin/publication/') ? blogPublication : null;
      if (handler) {
        const hasBody = !['HEAD', 'GET'].includes(incoming.method);
        const response = await handler(new Request(url, {
          method: incoming.method, headers: incoming.headers,
          ...(hasBody && { body: Readable.toWeb(incoming), duplex: 'half' }),
        }));
        if (route === '/api/admin/media/upload' && !response.ok) {
          const diagnostic = await response.clone().json();
          console.error('Upload validation:', response.status, incoming.headers['content-length'], diagnostic.error?.code, diagnostic.error?.message);
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
        else outgoing.end();
        return;
      }
      const file = route === '/admin' ? join(site, 'admin.html') : resolve(site, '.' + route);
      if (!file.startsWith(site + '/')) { outgoing.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      outgoing.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        ...(route === '/admin' && { 'x-robots-tag': 'noindex, nofollow' }),
      }).end(bytes);
    } catch { outgoing.writeHead(404).end(); }
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return server;
}

async function checkAxe(page) {
  assert.deepEqual((await new AxeBuilder({ page }).include('.editor-surface').analyze()).violations.map(({ id }) => id), []);
}

async function restorePublication(db, original, owner, requestId, deployId) {
  const stored = await db.query('select to_jsonb(b) as slot from blog_private.build_slot b where singleton');
  const current = stored.rows[0].slot;
  if (JSON.stringify(current) === JSON.stringify(original)) return;
  assert.ok(requestId, 'Unexpected slot change. Left unchanged.');
  const fixture = await db.query('select release_id from blog_private.publication_requests where request_id = $1 and owner_id = $2', [requestId, owner]);
  const releaseId = fixture.rows[0]?.release_id;
  const active = current.active_request_id === requestId && [null, deployId].includes(current.active_deploy_id)
    && current.generation === original.generation + 1;
  const live = current.active_request_id === null && current.active_deploy_id === null
    && current.last_published_deploy_id === deployId && current.last_published_release_id === releaseId
    && current.generation === original.generation + 2;
  assert.ok(releaseId && current.latest_confirmed_release_id === releaseId && (active || live), 'Unexpected slot change. Left unchanged.');
  const restore = await db.query([
    'update blog_private.build_slot set latest_confirmed_release_id = $1, last_published_release_id = $2, last_published_deploy_id = $3,',
    'generation = $4, updated_at = $5, active_request_id = null, active_deploy_id = null, active_build_kind = null,',
    'active_build_release_id = null, active_build_generation = null, active_attempt_id = null, lease_expires_at = null',
    'where singleton and to_jsonb(build_slot) = $6::jsonb',
    'and exists (select 1 from blog_private.settings where singleton and authorized_owner_id = $7)',
  ].join(' '), [original.latest_confirmed_release_id, original.last_published_release_id, original.last_published_deploy_id,
    original.generation, original.updated_at, JSON.stringify(current), owner]);
  assert.equal(restore.rowCount, 1, 'Fixture build slot must be restored by exact CAS');
}

export async function runEditorProof({ accessibilityOnly = false } = {}) {
  const status = await localBackend();
  const db = new pg.Client({ connectionString: status.DB_URL, statement_timeout: 10_000, connectionTimeoutMillis: 5_000 });
  const temp = await mkdtemp(join(tmpdir(), 'jt-editor-e2e-'));
  const suffix = randomUUID();
  const title = 'Cuidados depois da sessão ' + suffix.slice(0, 8);
  const email = 'task9-' + suffix + '@example.invalid';
  const password = 'E9!' + randomBytes(18).toString('hex');
  const previousEnv = new Map();
  let owner, claimed = false, browser, edge, pendingTransport, originalSlot, requestId, manifest;
  const deployId = 'task9-' + suffix;
  const siteId = 'task9-local-site';
  const hooks = [];
  const realFetch = globalThis.fetch;
  try {
    await db.connect();
    assert.equal((await db.query('select authorized_owner_id from blog_private.settings where singleton')).rows[0].authorized_owner_id, null);
    originalSlot = (await db.query('select to_jsonb(b) as slot from blog_private.build_slot b where singleton')).rows[0].slot;
    assert.ok(originalSlot.active_request_id === null && originalSlot.active_deploy_id === null && originalSlot.lease_expires_at === null);
    edge = await localEdge(temp);
    const origin = 'https://127.0.0.1:' + edge.address().port;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === status.API_URL) return realFetch(input, init);
      if (url.origin === origin && url.pathname === '/blog-release.json' && manifest) return Response.json(manifest);
      if (url.origin !== 'https://api.netlify.com') throw new Error('External request blocked by fixture');
      if (url.pathname === '/build_hooks/task9proof123' && init.method === 'POST') {
        hooks.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/api/v1/sites/' + siteId) return Response.json({ id: siteId, published_deploy: { id: manifest ? deployId : 'task9-before' } });
      if (url.pathname === '/api/v1/deploys/' + deployId) {
        return Response.json({ id: deployId, site_id: siteId, branch: 'main', context: 'production', state: manifest ? 'ready' : 'building' });
      }
      return new Response(null, { status: 404 });
    };
    const created = await fetch(status.API_URL + '/auth/v1/admin/users', {
      method: 'POST', headers: { apikey: status.SERVICE_ROLE_KEY, authorization: 'Bearer ' + status.SERVICE_ROLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    assert.ok(created.ok, 'Synthetic owner creation failed');
    owner = (await created.json()).id;
    const claim = await db.query('update blog_private.settings set authorized_owner_id = $1 where singleton and authorized_owner_id is null', [owner]);
    assert.equal(claim.rowCount, 1);
    claimed = true;
    for (const [name, value] of Object.entries({
      SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      BLOG_ADMIN_USER_ID: owner, BLOG_SESSION_ENCRYPTION_KEY: randomBytes(32).toString('hex'), BLOG_PUBLIC_ORIGIN: origin,
      BLOG_PUBLICATION_HOOK_URL: 'https://api.netlify.com/build_hooks/task9proof123', BLOG_NETLIFY_SITE_ID: siteId,
      BLOG_NETLIFY_API_TOKEN: 'task9-fixture-token',
    })) { previousEnv.set(name, process.env[name]); process.env[name] = value; }
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true });
    await context.route(new RegExp('^https?://(?!127\\.0\\.0\\.1:' + edge.address().port + '(?:/|$))', 'u'), (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/admin/publication/confirm') requestId = request.postDataJSON().requestId;
    });
    assert.equal((await page.request.get(origin + '/api/admin/posts')).status(), 401);
    const shell = await page.goto(origin + '/admin');
    assert.equal(shell.headers()['x-robots-tag'], 'noindex, nofollow');
    assert.ok(!(await shell.text()).includes(title));
    const login = page.getByRole('button', { name: 'Iniciar sessão' });
    await expect(login).toBeVisible();
    if (accessibilityOnly) {
      await checkAxe(page);
      await page.getByLabel('Email').focus();
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('Palavra-passe')).toBeFocused();
    }
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Palavra-passe').fill(password);
    await login.click();
    await page.getByRole('button', { name: 'Novo artigo' }).click();
    const body = page.getByRole('textbox', { name: 'Corpo do artigo' });
    await expect(body).toBeVisible();
    if (accessibilityOnly) {
      await checkAxe(page);
      await body.focus();
      await page.keyboard.press('Control+b');
      await page.keyboard.type('Negrito com teclado');
      await expect(body.locator('strong')).toHaveText('Negrito com teclado');
      await page.setViewportSize({ width: 390, height: 480 });
      await expect(body).toBeFocused();
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 390);
      await expect(page.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
      console.log('PASS real session, mobile editor, reduced viewport, keyboard and axe');
      return;
    }
    await page.getByRole('textbox', { name: 'Título', exact: true }).fill(title);
    await page.getByLabel('Resumo').fill('Cuidados essenciais nos primeiros dias.');
    await body.fill('Limpe a pele com cuidado.');
    await body.press('Control+End');
    await body.press('Enter');
    await body.press('Control+b');
    await page.keyboard.type('Siga o plano de cuidados.');
    await expect(body.locator('strong')).toHaveText('Siga o plano de cuidados.');
    await body.press('Control+b');
    await body.press('Enter');
    await page.getByRole('button', { name: 'Inserir ligação' }).click();
    await page.getByRole('textbox', { name: 'Endereço da ligação' }).fill('/servicos');
    await page.getByRole('button', { name: 'Aplicar ligação' }).click();
    await expect(body).toBeFocused();
    await page.keyboard.type('Ver serviços');
    await expect(body.locator('a')).toHaveAttribute('href', '/servicos');
    await page.getByRole('button', { name: 'Adicionar capa' }).click();
    const cover = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#e8d9c0' } }).png().toBuffer();
    const mediaResponses = [];
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/api/admin/media/') || /image-worker|\.wasm$/u.test(pathname)) mediaResponses.push([pathname, response.status()]);
    });
    await page.locator('input[type=file]').setInputFiles({ name: 'capa.png', mimeType: 'image/png', buffer: cover });
    const coverPreview = page.getByRole('img', { name: 'Capa do artigo' });
    try {
      await expect(coverPreview).toBeVisible({ timeout: 12_000 });
      await expect(coverPreview).toHaveAttribute('width', '96');
      await expect.poll(() => coverPreview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    } catch (error) {
      console.error('Media stages:', JSON.stringify(mediaResponses));
      console.error('Media status:', await page.locator('.media-picker [role=status]').allTextContents());
      throw error;
    }
    await expect(page.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
    console.log('PASS real Auth, formatting, link, Storage upload and autosave');

    const beforeLeaving = Promise.withResolvers();
    pendingTransport = Promise.withResolvers();
    const delaySave = async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      beforeLeaving.resolve();
      await pendingTransport.promise;
      await route.continue();
    };
    await page.route('**/api/admin/posts', delaySave);
    await page.getByLabel('Resumo').fill('Texto que tem de ficar guardado antes de sair.');
    await page.getByRole('button', { name: '← Artigos' }).click();
    await beforeLeaving.promise;
    await expect(body).toBeVisible();
    pendingTransport.resolve();
    await page.getByRole('button', { name: title, exact: false }).click();
    await page.unroute('**/api/admin/posts', delaySave);
    await expect(page.getByLabel('Resumo')).toHaveValue('Texto que tem de ficar guardado antes de sair.');

    const second = await context.newPage();
    second.setDefaultTimeout(12_000);
    await second.goto(origin + '/admin');
    await second.getByRole('button', { name: title, exact: false }).click();
    await second.getByLabel('Resumo').fill('Alteração guardada na segunda aba.');
    await second.getByRole('button', { name: 'Guardar agora' }).click();
    await expect(second.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
    await page.getByLabel('Resumo').fill('Alterações da primeira aba.');
    await expect(page.getByRole('alert')).toContainText('noutra aba');
    await expect(page.getByLabel('Resumo')).toHaveValue('Alterações da primeira aba.');
    await page.getByRole('button', { name: 'Rever versão guardada' }).click();
    await expect(page.getByText('Alteração guardada na segunda aba.')).toBeVisible();
    await page.getByRole('button', { name: 'Aplicar as minhas alterações' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
    await page.getByRole('button', { name: 'Preparar publicação' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Artigo preparado para publicação' })).toBeVisible();
    await page.getByRole('button', { name: 'Rever publicação' }).click();
    await expect(page.getByRole('region', { name: 'Rever publicação' }).getByText(title)).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar publicação' }).click();
    await expect.poll(() => hooks.length, { timeout: 15_000 }).toBe(1);
    assert.equal(hooks[0].requestId, requestId);
    await expect(page.getByText('Publicação online')).toHaveCount(0);
    const client = createServerClient(readBlogConfig());
    const built = await buildBlog({
      mode: 'production', outDir: join(temp, 'release'), rpc: (name, args) => client.rpc(name, args),
      env: {
        ...process.env, BLOG_PUBLIC_ORIGIN: 'https://editor-fixture.example.invalid', CONTEXT: 'production', BRANCH: 'main',
        SITE_ID: siteId, DEPLOY_ID: deployId, BLOG_PUBLIC_STORAGE_ORIGIN: 'https://fixture.supabase.co',
        INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hooks[0])),
      },
    });
    assert.equal(built.releaseId, hooks[0].releaseId);
    manifest = built.publicManifest;
    await expect(page.getByText('Publicação online')).toBeVisible({ timeout: 14_000 });
    assert.equal(hooks.length, 1);
    console.log('PASS navigation save, conflict recovery, one hook and live after provider and manifest proof');

    const entered = Promise.withResolvers();
    pendingTransport = Promise.withResolvers();
    await second.route('**/api/admin/posts', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      entered.resolve();
      await pendingTransport.promise;
      await route.continue().catch(() => {});
    });
    const completedWrite = second.waitForResponse((response) => response.url().endsWith('/api/admin/posts') && response.request().method() === 'PUT');
    await second.getByLabel('Resumo').fill('Texto de uma sessão que vai terminar.');
    await entered.promise;
    await page.getByRole('button', { name: 'Terminar sessão' }).click();
    await expect(second.getByRole('button', { name: 'Iniciar sessão' })).toBeVisible();
    pendingTransport.resolve();
    await expect(second.getByRole('textbox', { name: 'Corpo do artigo' })).toHaveCount(0);
    assert.equal((await completedWrite).status(), 401);
    assert.equal((await second.request.get(origin + '/api/admin/posts')).status(), 401);
    console.log('PASS cross-tab logout clears private editor while transport is pending');
  } finally {
    pendingTransport?.resolve();
    await browser?.close();
    globalThis.fetch = realFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try {
      if (claimed) {
        let restoreError;
        try { await restorePublication(db, originalSlot, owner, requestId, deployId); }
        catch (error) { restoreError = error; }
        await db.query("update auth.sessions set not_after = clock_timestamp() - interval '1 second' where user_id = $1 and (not_after is null or not_after > clock_timestamp())", [owner]);
        await db.query('update blog_private.admin_sessions set revoked_at = clock_timestamp() where user_id = $1 and revoked_at is null', [owner]);
        const restored = await db.query('update blog_private.settings set authorized_owner_id = null where singleton and authorized_owner_id = $1', [owner]);
        assert.equal(restored.rowCount, 1);
        assert.ifError(restoreError);
      }
    } finally {
      await db.end();
      if (edge) await new Promise((done) => edge.close(done));
      await rm(temp, { recursive: true, force: true });
    }
  }
}
