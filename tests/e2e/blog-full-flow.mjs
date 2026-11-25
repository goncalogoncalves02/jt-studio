import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, posix, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';
import blogSession from '../../netlify/functions/blog-admin.mjs';
import blogPosts from '../../netlify/functions/blog-posts.mjs';
import blogMedia from '../../netlify/functions/blog-media.mjs';
import blogPublication from '../../netlify/functions/blog-publication.mjs';
import { createAuthClient, createServerClient, readBlogConfig } from '../../server/blog/config.mjs';
import { createNetlifyClient } from '../../server/blog/netlify-api.mjs';
import { createPublicationService } from '../../server/blog/publication.mjs';
import { buildBlog } from '../../scripts/build-blog.mjs';
import { acquireBuild } from '../../scripts/production-release.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, parseTaskProjectConfig, runCliCapture } from '../../scripts/supabase-local.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const fallbackSite = join(root, 'dist/fixture/site');
const CANONICAL_ORIGIN = 'https://jaquelinetakiutistudio.com';
const SYNTHETIC_PUBLIC_ORIGIN = 'https://fullflow-public.example.invalid';
const STORAGE_HOST = 'fixture-storage.example.invalid';
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.wasm', 'application/wasm'],
]);

async function localBackend() {
  const isolated = process.env.BLOG_FULL_FLOW_PROJECT_DIR;
  const projectDir = isolated ? resolve(isolated) : root;
  const project = isolated ? 'jt-studio-blog-task10-fresh' : 'jt-studio-blog-tests';
  const apiPort = isolated ? 55341 : 54341;
  const dbPort = isolated ? 55342 : 54342;
  const config = parseTaskProjectConfig(await readFile(join(projectDir, 'supabase/config.toml'), 'utf8'));
  assert.deepEqual(config, { projectId: project, apiPort, databasePort: dbPort });
  for (const [service, internalPort, port] of [['db', 5432, dbPort], ['kong', 8000, apiPort]]) {
    const name = 'supabase_' + service + '_' + project;
    const inspect = spawnSync('docker', ['--context', 'desktop-linux', 'inspect', '--format',
      '{{json .NetworkSettings.Ports}}', name], { encoding: 'utf8' });
    assert.equal(inspect.status, 0, 'disposable local Supabase service must exist');
    const bindings = JSON.parse(inspect.stdout)[internalPort + '/tcp'];
    assert.deepEqual(bindings, [{ HostIp: '127.0.0.1', HostPort: String(port) }]);
  }
  const docker = spawnSync(
    'docker',
    ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' },
  );
  const endpoint = docker.stdout?.trim();
  assert.ok(docker.status === 0 && endpoint?.startsWith('unix:///'), 'docker-local-socket');
  const proxy = createDockerLoopbackProxy({
    upstreamSocketPath: endpoint.slice('unix://'.length),
    allowedNames: new Set(['db', 'rest', 'auth', 'kong', 'storage'].map((name) => `supabase_${name}_${project}`)),
  });
  try {
    const env = createSupabaseCliEnvironment(process.env, await proxy.listen());
    const cli = join(root, 'node_modules/supabase/dist/supabase.js');
    const version = await runCliCapture(process.execPath, [cli, '--version'], { cwd: root, env });
    assert.equal(version.stdout.trim(), '2.120.0');
    const result = await runCliCapture(process.execPath, [cli, 'status', '-o', 'json'], { cwd: projectDir, env });
    assert.equal(result.status, 0);
    const status = JSON.parse(result.stdout);
    const dbUrl = new URL(status.DB_URL);
    assert.ok(['postgresql:', 'postgres:'].includes(dbUrl.protocol) && dbUrl.hostname === '127.0.0.1'
      && dbUrl.port === String(dbPort) && dbUrl.username === 'postgres' && dbUrl.password
      && dbUrl.pathname === '/postgres' && !dbUrl.search && !dbUrl.hash, 'disposable loopback database required');
    assert.ok(status.API_URL === 'http://127.0.0.1:' + apiPort && status.ANON_KEY && status.SERVICE_ROLE_KEY);
    return status;
  } finally {
    await proxy.close();
  }
}

async function resolveStaticFile(siteRoot, pathname) {
  const clean = posix.normalize(`/${decodeURIComponent(pathname)}`).replace(/\/$/u, '') || '/';
  const candidates = clean === '/'
    ? ['/index.html']
    : [clean, ...(posix.extname(clean) ? [] : [`${clean}.html`, `${clean}/index.html`])];
  for (const candidate of candidates) {
    const abs = resolve(siteRoot, `.${candidate}`);
    if (!abs.startsWith(`${siteRoot}/`) && abs !== siteRoot) continue;
    try {
      const info = await stat(abs);
      if (info.isFile()) return { file: abs, status: 200 };
    } catch {
      // continue to next candidate
    }
  }
  return { file: resolve(siteRoot, '404.html'), status: 404 };
}

async function localEdge(temp, getSiteRoot, storageApiOrigin, realFetch) {
  const cert = join(temp, 'localhost.pem');
  const key = join(temp, 'localhost-key.pem');
  assert.equal(
    spawnSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', `subjectAltName=IP:127.0.0.1,DNS:${STORAGE_HOST},DNS:fullflow-public.example.invalid`,
      ],
      { stdio: 'ignore' },
    ).status,
    0,
  );
  const server = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? '/', `https://127.0.0.1:${incoming.socket.localPort}`);
      const route = url.pathname;
      if (route.startsWith('/storage/v1/object/public/blog-public/')) {
        const upstream = await realFetch(new URL(route + url.search, storageApiOrigin));
        const body = Buffer.from(await upstream.arrayBuffer());
        outgoing.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'image/webp',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        outgoing.end(body);
        return;
      }
      const handler = route === '/api/admin/session'
        ? blogSession
        : route === '/api/admin/posts'
          ? blogPosts
          : route.startsWith('/api/admin/media/')
            ? blogMedia
            : route.startsWith('/api/admin/publication/')
              ? blogPublication
              : null;
      if (handler) {
        const hasBody = !['HEAD', 'GET'].includes(incoming.method);
        const response = await handler(new Request(url, {
          method: incoming.method,
          headers: incoming.headers,
          ...(hasBody && { body: Readable.toWeb(incoming), duplex: 'half' }),
        }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
        else outgoing.end();
        return;
      }
      const siteRoot = getSiteRoot();
      const resolved = await resolveStaticFile(siteRoot, route);
      const bytes = await readFile(resolved.file);
      outgoing.writeHead(resolved.status, {
        'content-type': mime.get(extname(resolved.file)) ?? 'application/octet-stream',
        ...(route === '/admin' && { 'x-robots-tag': 'noindex, nofollow' }),
      });
      outgoing.end(bytes);
    } catch {
      outgoing.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  return server;
}

async function createSyntheticUser(apiUrl, serviceRoleKey, prefix) {
  const id = randomUUID();
  const email = `${prefix}-${id}@example.invalid`;
  const password = `Ff!${randomBytes(18).toString('hex')}`;
  const response = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.ok(response.ok, `Synthetic user creation failed for ${prefix}`);
  const payload = await response.json();
  return { id: payload.id, email, password };
}

async function assertPublicFilesExclude(siteDir, forbiddenTokens) {
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt', '.xml']);
  for (const entry of await readdir(siteDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;
    const file = join(entry.parentPath, entry.name);
    const text = await readFile(file, 'utf8');
    for (const token of forbiddenTokens) {
      assert.equal(text.includes(token), false, 'Private fixture material leaked in ' + entry.name);
    }
  }
}

export async function runFullFlowProof() {
  const status = await localBackend();
  const db = new pg.Client({ connectionString: status.DB_URL, statement_timeout: 15_000, connectionTimeoutMillis: 5_000 });
  const temp = await mkdtemp(join(tmpdir(), 'jt-fullflow-e2e-'));
  const runId = randomUUID().slice(0, 8);
  const deploy1 = `ff-ed1-${runId}`;
  const deploy2 = `ff-ed2-${runId}`;
  const failDeployId = `ff-ed3-fail-${runId}`;
  const deploy3 = `ff-ed3-${runId}`;
  const runDeployIds = [deploy1, deploy2, failDeployId, deploy3];
  const siteId = 'fullflow-local-site';
  const apiToken = 'fullflow-fixture-token';
  const previousEnv = new Map();
  const realFetch = globalThis.fetch;

  let activeSiteRoot = fallbackSite;
  let ownerUser;
  let unauthorizedUser;
  let ownerClaimed = false;
  let originalSlot;
  let browser;
  let edge;
  let activeDeployId = `ff-base-${runId}`;
  let publishedDeployId = `ff-base-${runId}`;
  let providerState = 'building';
  let requestId1;
  let releaseId1;
  let requestId2;
  let releaseId2;
  let requestId3;
  let releaseId3;
  const hooks = [];
  const cleanupFailures = [];
  let primaryFailure = null;

  try {
    await db.connect();
    const baseline = await db.query(`
      select
        (select authorized_owner_id from blog_private.settings where singleton) as owner_id,
        (select count(*)::int from blog_private.admin_sessions where revoked_at is null) as active_sessions,
        (select count(*)::int from public.blog_posts where prepared_action is not null) as prepared_posts,
        (select count(*)::int from auth.sessions where not_after is null or not_after > clock_timestamp()) as auth_sessions,
        (select to_jsonb(b) from blog_private.build_slot b where singleton) as slot
    `);
    assert.equal(baseline.rows[0].owner_id, null, 'requires owner NULL baseline');
    assert.equal(baseline.rows[0].active_sessions, 0, 'requires zero active sessions');
    assert.equal(baseline.rows[0].auth_sessions, 0, 'requires zero active Auth sessions');
    assert.equal(baseline.rows[0].prepared_posts, 0, 'requires an isolated Supabase database without prepared posts');
    originalSlot = baseline.rows[0].slot;
    assert.equal(originalSlot.active_request_id, null);
    assert.equal(originalSlot.active_deploy_id, null);

    edge = await localEdge(temp, () => activeSiteRoot, status.API_URL, realFetch);
    const edgePort = edge.address().port;
    const origin = `https://127.0.0.1:${edgePort}`;
    const storageOrigin = `https://${STORAGE_HOST}:${edgePort}`;

    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/blog-release.json'
          && (url.origin === origin || url.origin === SYNTHETIC_PUBLIC_ORIGIN)) {
        return new Response(await readFile(join(activeSiteRoot, 'blog-release.json')), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.origin === status.API_URL || url.origin === origin) return realFetch(input, init);
      if (url.origin !== 'https://api.netlify.com') throw new Error(`External request blocked: ${url.origin}`);
      if (url.pathname === '/build_hooks/fullflow123' && init?.method === 'POST') {
        hooks.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/api/v1/sites/${siteId}`) {
        return Response.json({ id: siteId, published_deploy: { id: publishedDeployId } });
      }
      if (url.pathname === `/api/v1/deploys/${activeDeployId}`) {
        return Response.json({ id: activeDeployId, site_id: siteId, branch: 'main', context: 'production', state: providerState });
      }
      return new Response(null, { status: 404 });
    };

    ownerUser = await createSyntheticUser(status.API_URL, status.SERVICE_ROLE_KEY, 'task10-owner');
    unauthorizedUser = await createSyntheticUser(status.API_URL, status.SERVICE_ROLE_KEY, 'task10-unauth');
    const claim = await db.query(
      'update blog_private.settings set authorized_owner_id = $1 where singleton and authorized_owner_id is null',
      [ownerUser.id],
    );
    assert.equal(claim.rowCount, 1);
    ownerClaimed = true;

    const encryptionKey = randomBytes(32).toString('hex');
    for (const [name, value] of Object.entries({
      SUPABASE_URL: status.API_URL,
      SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      BLOG_ADMIN_USER_ID: ownerUser.id,
      BLOG_SESSION_ENCRYPTION_KEY: encryptionKey,
      BLOG_PUBLIC_ORIGIN: origin,
      BLOG_PUBLICATION_HOOK_URL: 'https://api.netlify.com/build_hooks/fullflow123',
      BLOG_NETLIFY_SITE_ID: siteId,
      BLOG_NETLIFY_API_TOKEN: apiToken,
    })) {
      previousEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const config = readBlogConfig();
    const serviceClient = createServerClient(config);

    // Causal auth assertion: unauthorized user rejected by RLS/RPC with 42501
    const unauthSignIn = await realFetch(`${status.API_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: unauthorizedUser.email, password: unauthorizedUser.password }),
    }).then((r) => r.json());
    assert.ok(unauthSignIn.access_token);
    const unauthSdk = createAuthClient(config, unauthSignIn.access_token);
    const unauthRpc = await unauthSdk.rpc('blog_save_post', {
      p_input: {
        title: 'Unauthorized attempt',
        slug: `unauth-${runId}`,
        excerpt: 'Should fail',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nope' }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: 0,
      p_session_id: randomUUID(),
      p_generation: 1,
    });
    assert.equal(unauthRpc.error?.code, '42501', 'Unauthorized account must be rejected with 42501');

    browser = await chromium.launch({
      args: [
        `--host-resolver-rules=MAP ${STORAGE_HOST} 127.0.0.1, MAP fullflow-public.example.invalid 127.0.0.1`,
        '--no-proxy-server',
      ],
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true });
    await context.route(
      new RegExp(`^https?://(?!(?:127\\.0\\.0\\.1|${STORAGE_HOST}):${edgePort}(?:/|$))`, 'u'),
      (route) => route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/admin/publication/confirm') {
        requestId1 = request.postDataJSON().requestId;
      }
    });

    assert.equal((await page.request.get(`${origin}/api/admin/posts`)).status(), 401);
    const shell = await page.goto(`${origin}/admin`);
    assert.equal(shell.headers()['x-robots-tag'], 'noindex, nofollow');

    // Unauthorized login rejected in UI (403)
    await page.getByLabel('Email').fill(unauthorizedUser.email);
    await page.getByLabel('Palavra-passe').fill(unauthorizedUser.password);
    const [unauthResp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/admin/session') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Iniciar sessão' }).click(),
    ]);
    assert.equal(unauthResp.status(), 403);
    await expect(page.getByRole('alert')).toBeVisible();

    // Owner login
    await page.getByLabel('Email').fill(ownerUser.email);
    await page.getByLabel('Palavra-passe').fill(ownerUser.password);
    await page.getByRole('button', { name: 'Iniciar sessão' }).click();
    await expect(page.getByRole('button', { name: 'Novo artigo' })).toBeVisible();

    // Upload 3 formats (HEIC, JPEG, PNG) through real browser worker
    const mediaFormats = [
      { file: 'tests/fixtures/media/iphone-xr-original.HEIC', mimeType: 'image/heic', title: `Fullflow HEIC ${runId}` },
      { file: 'tests/fixtures/media/oriented.jpg', mimeType: 'image/jpeg', title: `Fullflow JPEG ${runId}` },
      { file: 'tests/fixtures/media/alpha.png', mimeType: 'image/png', title: `Fullflow PNG ${runId}` },
    ];
    for (const item of mediaFormats) {
      await page.getByRole('button', { name: 'Novo artigo' }).click();
      await page.getByRole('textbox', { name: 'Título', exact: true }).fill(item.title);
      await page.getByLabel('Resumo').fill(`Resumo para ${item.title}.`);
      await page.getByRole('textbox', { name: 'Corpo do artigo' }).fill(`Conteúdo publicado para ${item.title}.`);
      await page.getByRole('button', { name: 'Adicionar capa' }).click();
      const buffer = await readFile(join(root, item.file));
      await page.locator('input[type=file]').setInputFiles({ name: item.file.split('/').pop(), mimeType: item.mimeType, buffer });
      const coverPreview = page.getByRole('img', { name: 'Capa do artigo' });
      await expect(coverPreview).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => coverPreview.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expect(page.getByRole('status').filter({ hasText: 'Guardado' })).toBeVisible();
      await page.getByRole('button', { name: 'Preparar publicação' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Artigo preparado para publicação' })).toBeVisible();
      await page.getByRole('button', { name: '← Artigos' }).click();
    }

    const ownerSignIn = await realFetch(`${status.API_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: ownerUser.email, password: ownerUser.password }),
    }).then((r) => r.json());
    assert.ok(ownerSignIn.access_token);
    const ownerJwt = JSON.parse(Buffer.from(ownerSignIn.access_token.split('.')[1], 'base64url').toString('utf8'));
    const helperAppSessionId = randomUUID();
    await db.query(
      `insert into blog_private.admin_sessions(session_id, user_id, auth_session_id, generation, cookie_digest, expires_at, auth_expires_at, token_ciphertext)
       values($1, $2, $3, 1, extensions.digest($1::uuid::text, 'sha256'), clock_timestamp() + interval '10 minutes', clock_timestamp() + interval '10 minutes', 'v1.a.a.a')`,
      [helperAppSessionId, ownerUser.id, ownerJwt.session_id],
    );
    const ownerSdk = createAuthClient(config, ownerSignIn.access_token);

    // Causal epoch assertion: stale session generation rejected with 42501
    const badEpoch = await ownerSdk.rpc('blog_save_post', {
      p_input: {
        title: 'Stale epoch',
        slug: `stale-${runId}`,
        excerpt: 'Stale',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale' }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: 0,
      p_session_id: helperAppSessionId,
      p_generation: 99,
    });
    assert.equal(badEpoch.error?.code, '42501', 'Stale session generation must fail with 42501');

    const extraPosts = [];
    for (let i = 4; i <= 10; i += 1) {
      const slug = `ff-post-${i}-${runId}`;
      const saved = await ownerSdk.rpc('blog_save_post', {
        p_input: {
          title: `Artigo preparado ${i} ${runId}`,
          slug,
          excerpt: `Resumo preparado ${i}.`,
          document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Corpo preparado ${i} ${runId}.` }] }] },
          coverMediaId: null,
          serviceId: null,
        },
        p_expected_revision: 0,
        p_session_id: helperAppSessionId,
        p_generation: 1,
      });
      assert.equal(saved.error, null);
      assert.ok(saved.data?.id);
      extraPosts.push({ id: saved.data.id, slug });
      const prepared = await ownerSdk.rpc('blog_mark_prepared', {
        p_post_id: saved.data.id,
        p_expected_revision: saved.data.revision,
        p_action: 'upsert',
        p_session_id: helperAppSessionId,
        p_generation: 1,
      });
      assert.equal(prepared.error, null);
    }

    const draftSlug = `draft-excluded-${runId}`;
    const draftTitle = `Rascunho excluído ${runId}`;
    const draftSentinel = `EXCLUDED_DRAFT_SENTINEL_${runId}`;
    const draftSaved = await ownerSdk.rpc('blog_save_post', {
      p_input: {
        title: draftTitle,
        slug: draftSlug,
        excerpt: 'Não deve ser publicado.',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: draftSentinel }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: 0,
      p_session_id: helperAppSessionId,
      p_generation: 1,
    });
    assert.equal(draftSaved.error, null);

    // Confirm first publication in UI (10 prepared posts, 1 excluded draft)
    const [reviewResponse, currentResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/publication/review'),
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/publication/current'),
      page.getByRole('button', { name: 'Rever publicação' }).click(),
    ]);
    assert.equal(reviewResponse.status(), 200, 'Publication review must succeed');
    assert.equal(currentResponse.status(), 200, 'Current publication lookup must succeed');
    assert.equal((await reviewResponse.json()).changes.length, 10);
    await page.getByRole('button', { name: 'Confirmar publicação' }).click();
    await expect.poll(() => hooks.length, { timeout: 15_000 }).toBe(1);
    assert.equal(hooks[0].requestId, requestId1);
    releaseId1 = hooks[0].releaseId;

    const baseBuildEnv = {
      ...process.env,
      BLOG_PUBLIC_ORIGIN: SYNTHETIC_PUBLIC_ORIGIN,
      BLOG_PUBLIC_STORAGE_ORIGIN: storageOrigin,
      CONTEXT: 'production',
      BRANCH: 'main',
      SITE_ID: siteId,
    };

    const edDist1 = join(temp, 'ed-dist-1');
    const built1 = await buildBlog({
      mode: 'production',
      outDir: edDist1,
      rpc: (name, args) => serviceClient.rpc(name, args),
      env: { ...baseBuildEnv, DEPLOY_ID: deploy1, INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hooks[0])) },
    });
    assert.equal(built1.releaseId, releaseId1);
    activeSiteRoot = edDist1;
    activeDeployId = deploy1;
    publishedDeployId = deploy1;
    providerState = 'ready';

    await expect(page.getByText('Publicação online')).toBeVisible({ timeout: 15_000 });
    assert.equal(hooks.length, 1, 'First release must send exactly one hook');
    const privateTokens = [draftSlug, draftTitle, draftSentinel, status.SERVICE_ROLE_KEY, encryptionKey,
      apiToken, ownerUser.email, ownerUser.password, unauthorizedUser.email, unauthorizedUser.password];
    await assertPublicFilesExclude(edDist1, privateTokens);
    process.stdout.write('PASS release-1-10-posts-heic-jpeg-png-and-excluded-draft\n');

    // Verify canonical sitemap, 5 legacy routes, and compiled route navigation via browser request context
    const sitemapRes = await page.request.get(`${origin}/sitemap.xml`);
    assert.equal(sitemapRes.status(), 200);
    const sitemap1 = await sitemapRes.text();
    for (const legacyPath of ['/', '/servicos', '/info', '/galeria', '/contactos']) {
      const res = await page.request.get(`${origin}${legacyPath === '/' ? '' : legacyPath}`);
      assert.equal(res.status(), 200);
      assert.ok(sitemap1.includes(`${CANONICAL_ORIGIN}${legacyPath}`));
    }
    assert.ok(sitemap1.includes(`${CANONICAL_ORIGIN}/blog`));
    assert.ok(!sitemap1.includes('/admin'));
    const heicSlug = `fullflow-heic-${runId}`;
    assert.ok(sitemap1.includes(`${CANONICAL_ORIGIN}/blog/${heicSlug}`));
    const index1 = JSON.parse(await (await page.request.get(`${origin}/blog-data/${releaseId1}/index.json`)).text());
    const publishedSlugs = [...mediaFormats.map(({ title }) => title.toLowerCase().replaceAll(' ', '-')), ...extraPosts.map(({ slug }) => slug)];
    assert.deepEqual(index1.map(({ slug }) => slug).sort(), publishedSlugs.sort());

    // Slow public image delivery at 200 kbit/s, 400ms RTT with awaited response & no cache reuse
    const publicPage = await context.newPage();
    const cdp = await context.newCDPSession(publicPage);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 200_000 / 8,
      uploadThroughput: 200_000 / 8,
      latency: 400,
    });
    const imageResponsePromise = publicPage.waitForResponse(
      (res) => res.url().includes('/storage/v1/object/public/blog-public/') && res.status() === 200,
      { timeout: 30_000 },
    );
    await publicPage.goto(`${origin}/blog/${heicSlug}`);
    const imageResponse = await imageResponsePromise;
    const responseBytes = (await imageResponse.body()).length;
    const heroImg = publicPage.locator('main article img').first();
    await expect(heroImg).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => heroImg.evaluate((img) => img.complete && img.naturalWidth > 0), { timeout: 25_000 }).toBe(true);
    const imgMetrics = await heroImg.evaluate((img) => ({
      currentSrc: img.currentSrc || img.src,
      srcset: img.getAttribute('srcset') || '',
      widthAttr: img.getAttribute('width'),
      heightAttr: img.getAttribute('height'),
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(imageResponse.url().includes('/480-'), `Expected 480w variant, got ${imageResponse.url()}`);
    assert.equal(imgMetrics.currentSrc, imageResponse.url());
    assert.ok(imgMetrics.srcset.includes('480w'));
    assert.ok(Number(imgMetrics.widthAttr) > 0 && Number(imgMetrics.heightAttr) > 0);
    assert.ok(imgMetrics.scrollWidth <= 390);
    assert.ok(responseBytes > 0 && responseBytes <= 131_072);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });

    // Compiled public route/link navigation
    await publicPage.goto(`${origin}/blog`);
    await publicPage.locator(`main a[href="/blog/${heicSlug}"]`).first().click();
    await expect(publicPage).toHaveURL(`${origin}/blog/${heicSlug}`);
    await publicPage.getByRole('button', { name: 'Abrir menu' }).click();
    await publicPage.locator('.fixed.inset-0').getByRole('link', { name: 'Serviços', exact: true }).click();
    await expect(publicPage).toHaveURL(`${origin}/servicos`);
    await publicPage.close();
    process.stdout.write('PASS slow-network-200kbps-400ms-image-480w-bytes=' + responseBytes
      + '-layout-width=' + imgMetrics.scrollWidth + '-and-nav\n');

    // Release 2: query real revisions, edit 1 post + remove 1 post
    const auth = { userId: ownerUser.id, sessionId: helperAppSessionId, authSessionId: ownerJwt.session_id, generation: 1, userSdk: ownerSdk, serviceClient };
    const netlifyClient = createNetlifyClient({ siteId, apiToken, publicOrigin: SYNTHETIC_PUBLIC_ORIGIN, fetchImpl: globalThis.fetch });
    const pubService = createPublicationService({ rpc: (name, args) => serviceClient.rpc(name, args), hookUrl: 'https://api.netlify.com/build_hooks/fullflow123', fetchImpl: globalThis.fetch, netlifyClient });

    const postToEdit = extraPosts[0];
    const postToRemove = extraPosts[1];
    const revRows = await db.query('select id, revision from public.blog_posts where id = any($1::uuid[])', [[postToEdit.id, postToRemove.id]]);
    const revMap = new Map(revRows.rows.map((r) => [r.id, r.revision]));

    const edited = await ownerSdk.rpc('blog_save_post', {
      p_input: {
        id: postToEdit.id,
        title: `Artigo editado ${runId}`,
        slug: postToEdit.slug,
        excerpt: 'Resumo atualizado na release 2.',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Corpo editado ${runId}.` }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: revMap.get(postToEdit.id),
      p_session_id: helperAppSessionId,
      p_generation: 1,
    });
    assert.equal(edited.error, null);
    const prepEdit = await ownerSdk.rpc('blog_mark_prepared', { p_post_id: postToEdit.id, p_expected_revision: edited.data.revision, p_action: 'upsert', p_session_id: helperAppSessionId, p_generation: 1 });
    assert.equal(prepEdit.error, null);
    const prepRemove = await ownerSdk.rpc('blog_mark_prepared', { p_post_id: postToRemove.id, p_expected_revision: revMap.get(postToRemove.id), p_action: 'remove', p_session_id: helperAppSessionId, p_generation: 1 });
    assert.equal(prepRemove.error, null);

    const summary2 = await pubService.preparePublication(auth);
    assert.deepEqual(new Set(summary2.changes.map((c) => c.postId)), new Set([postToEdit.id, postToRemove.id]));
    requestId2 = randomUUID();
    const conf2 = await pubService.confirmPublication(auth, { requestId: requestId2, expectedDigest: summary2.digest });
    releaseId2 = conf2.releaseId;
    await pubService.advancePublication(auth, { requestId: requestId2 });
    assert.equal(hooks.length, 2);

    const edDist2 = join(temp, 'ed-dist-2');
    const built2 = await buildBlog({
      mode: 'production',
      outDir: edDist2,
      rpc: (name, args) => serviceClient.rpc(name, args),
      env: { ...baseBuildEnv, DEPLOY_ID: deploy2, INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hooks[1])) },
    });
    assert.equal(built2.releaseId, releaseId2);
    activeSiteRoot = edDist2;
    activeDeployId = deploy2;
    publishedDeployId = deploy2;
    providerState = 'ready';
    assert.equal((await pubService.reconcilePublication(auth, { requestId: requestId2 })).state, 'live');

    const editedRes = await page.request.get(`${origin}/blog/${postToEdit.slug}`);
    assert.equal(editedRes.status(), 200);
    assert.ok((await editedRes.text()).includes(`Corpo editado ${runId}.`));
    const removedRes = await page.request.get(`${origin}/blog/${postToRemove.slug}`);
    assert.equal(removedRes.status(), 404);
    const sitemap2 = await (await page.request.get(`${origin}/sitemap.xml`)).text();
    assert.ok(!sitemap2.includes(postToRemove.slug));
    await assertPublicFilesExclude(edDist2, [...privateTokens, postToRemove.slug]);
    process.stdout.write('PASS release-2-edit-and-remove\n');

    // Release 3: terminal failure acquired via real blog_build_acquire -> manual retry -> stale callback rejected -> live
    const post3 = extraPosts[2];
    const post3Rev = (await db.query('select revision from public.blog_posts where id = $1', [post3.id])).rows[0].revision;
    const saved3 = await ownerSdk.rpc('blog_save_post', {
      p_input: {
        id: post3.id,
        title: `Artigo retry ${runId}`,
        slug: post3.slug,
        excerpt: 'Resumo retry.',
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Corpo retry ${runId}.` }] }] },
        coverMediaId: null,
        serviceId: null,
      },
      p_expected_revision: post3Rev,
      p_session_id: helperAppSessionId,
      p_generation: 1,
    });
    assert.equal(saved3.error, null);
    const prep3 = await ownerSdk.rpc('blog_mark_prepared', { p_post_id: post3.id, p_expected_revision: saved3.data.revision, p_action: 'upsert', p_session_id: helperAppSessionId, p_generation: 1 });
    assert.equal(prep3.error, null);

    const summary3 = await pubService.preparePublication(auth);
    requestId3 = randomUUID();
    const conf3 = await pubService.confirmPublication(auth, { requestId: requestId3, expectedDigest: summary3.digest });
    releaseId3 = conf3.releaseId;
    const repeatedConfirmation = await pubService.confirmPublication(auth, { requestId: requestId3, expectedDigest: summary3.digest });
    assert.deepEqual(repeatedConfirmation, conf3);
    assert.equal(hooks.length, 2, 'Confirmation and replay must not send a build hook');
    await pubService.advancePublication(auth, { requestId: requestId3 });
    assert.equal(hooks.length, 3);
    await pubService.advancePublication(auth, { requestId: requestId3 });
    assert.equal(hooks.length, 3, 'Duplicate advancePublication must not send a second hook');

    const claimRows = await db.query(
      'select r.release_id, r.expected_summary_digest, l.digest, a.attempt_id'
      + ' from blog_private.publication_requests r'
      + ' join blog_private.releases l on l.release_id = r.release_id'
      + ' join blog_private.publication_dispatch_attempts a using (request_id)'
      + ' where r.request_id = $1 and r.owner_id = $2',
      [requestId3, ownerUser.id],
    );
    assert.equal(claimRows.rowCount, 1);
    assert.equal(claimRows.rows[0].release_id, releaseId3);
    assert.equal(claimRows.rows[0].attempt_id, hooks[2].attemptId);

    const acquiredFail = await acquireBuild({
      env: { ...baseBuildEnv, DEPLOY_ID: failDeployId, INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hooks[2])) },
      rpc: (name, args) => serviceClient.rpc(name, args),
      fetchImpl: globalThis.fetch,
      netlifyClient,
    });
    assert.equal(acquiredFail.releaseId, releaseId3);
    assert.equal(claimRows.rows[0].expected_summary_digest, summary3.digest);
    assert.equal(acquiredFail.digest, claimRows.rows[0].digest);

    activeDeployId = failDeployId;
    publishedDeployId = deploy2;
    providerState = 'error';
    const failedOutcome = await pubService.reconcilePublication(auth, { requestId: requestId3 });
    assert.equal(failedOutcome.state, 'failed');

    const slotAfterFail = (await db.query('select last_published_release_id, last_published_deploy_id from blog_private.build_slot where singleton')).rows[0];
    assert.equal(slotAfterFail.last_published_release_id, releaseId2);
    assert.equal(slotAfterFail.last_published_deploy_id, deploy2);

    const retried = await pubService.retryPublication(auth, { requestId: requestId3, retryId: randomUUID() });
    assert.equal(retried.state, 'confirmed');
    assert.equal(retried.releaseId, releaseId3);
    await pubService.advancePublication(auth, { requestId: requestId3 });
    assert.equal(hooks.length, 4);
    assert.equal(hooks[3].releaseId, hooks[2].releaseId);
    assert.notEqual(hooks[3].attemptId, hooks[2].attemptId);

    const edDist3 = join(temp, 'ed-dist-3');
    const built3 = await buildBlog({
      mode: 'production',
      outDir: edDist3,
      rpc: (name, args) => serviceClient.rpc(name, args),
      env: { ...baseBuildEnv, DEPLOY_ID: deploy3, INCOMING_HOOK_BODY: encodeURIComponent(JSON.stringify(hooks[3])) },
    });
    const activeBuild = await db.query('select active_build_generation from blog_private.build_slot where singleton and active_request_id = $1', [requestId3]);
    assert.ok(Number(activeBuild.rows[0].active_build_generation) > acquiredFail.generation);
    const staleCallback = await serviceClient.rpc('blog_publication_reconcile_commit', {
      p_user_id: ownerUser.id,
      p_session_id: helperAppSessionId,
      p_auth_session_id: ownerJwt.session_id,
      p_generation: 1,
      p_request_id: requestId3,
      p_publication_generation: acquiredFail.generation,
      p_deploy_id: failDeployId,
      p_outcome: 'live',
      p_published_deploy_id: failDeployId,
    });
    assert.equal(staleCallback.error?.code, '40001', 'Stale callback must be rejected');

    assert.equal(built3.releaseId, releaseId3);
    assert.equal(built3.publicManifest.digest, acquiredFail.digest);
    activeSiteRoot = edDist3;
    activeDeployId = deploy3;
    publishedDeployId = deploy3;
    providerState = 'ready';
    assert.equal((await pubService.reconcilePublication(auth, { requestId: requestId3 })).state, 'live');
    await assertPublicFilesExclude(edDist3, [...privateTokens, postToRemove.slug]);
    process.stdout.write('PASS release-3-failure-manual-retry-stale-callback-live\n');
  } catch (error) {
    primaryFailure = error;
  } finally {
    await browser?.close().catch(() => cleanupFailures.push('browser-close'));
    globalThis.fetch = realFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    if (db && originalSlot) {
      try {
        await db.query('begin');
        const current = (await db.query('select to_jsonb(b) as row from blog_private.build_slot b where b.singleton for update')).rows[0]?.row;
        if (JSON.stringify(current) !== JSON.stringify(originalSlot)) {
          const reqIds = [requestId1, requestId2, requestId3].filter(Boolean);
          const reqRows = ownerUser?.id && reqIds.length
            ? (await db.query('select request_id, release_id from blog_private.publication_requests where request_id = any($1::uuid[]) and owner_id = $2', [reqIds, ownerUser.id])).rows
            : [];
          const owned = reqRows.find((row) => row.release_id === current.latest_confirmed_release_id);
          const phase = [requestId1, requestId2, requestId3].indexOf(owned?.request_id);
          const deploy = [deploy1, deploy2, deploy3][phase];
          const generation = current.generation - originalSlot.generation;
          const active = current.active_request_id === owned?.request_id
            && [null, deploy, ...(phase === 2 ? [failDeployId] : [])].includes(current.active_deploy_id)
            && (generation === [1, 3, 5][phase] || (phase === 2 && generation === 6));
          const live = current.active_request_id === null && current.active_deploy_id === null
            && current.last_published_deploy_id === deploy && current.last_published_release_id === owned?.release_id
            && generation === [2, 4, 7][phase];
          let receiptOk = !live;
          if (current.last_published_deploy_id && current.last_published_deploy_id !== originalSlot.last_published_deploy_id) {
            const receipt = await db.query(
              "select 1 from blog_private.reconciled_deploys where deploy_id = $1 and deploy_id = any($2::text[]) and release_id = $3 and outcome = 'live'",
              [current.last_published_deploy_id, runDeployIds, current.last_published_release_id],
            );
            receiptOk = receipt.rowCount === 1;
          }
          if (!ownerClaimed || !owned || (!active && !live) || !receiptOk) {
            cleanupFailures.push('build-slot-cas-guard');
            await db.query('rollback');
          } else {
            const restored = await db.query(
              `update blog_private.build_slot
               set latest_confirmed_release_id = $1, last_published_release_id = $2, last_published_deploy_id = $3,
                   active_request_id = null, active_deploy_id = null, active_build_kind = null,
                   active_build_release_id = null, active_build_generation = null, active_attempt_id = null,
                   lease_expires_at = null, generation = $4, updated_at = $5
               where singleton and to_jsonb(build_slot) = $6::jsonb
                 and exists (select 1 from blog_private.settings s where s.singleton and s.authorized_owner_id = $7)`,
              [
                originalSlot.latest_confirmed_release_id,
                originalSlot.last_published_release_id,
                originalSlot.last_published_deploy_id,
                originalSlot.generation,
                originalSlot.updated_at,
                JSON.stringify(current),
                ownerUser.id,
              ],
            );
            if (restored.rowCount !== 1) {
              cleanupFailures.push('build-slot-cas-mismatch');
              await db.query('rollback');
            } else {
              await db.query('commit');
            }
          }
        } else {
          await db.query('commit');
        }
      } catch {
        await db.query('rollback').catch(() => {});
        cleanupFailures.push('build-slot-restore');
      }
    }

    if (db && ownerUser?.id) {
      await db.query('update public.blog_posts set prepared_action = null, prepared_revision = null where owner_id = $1 and prepared_action is not null', [ownerUser.id])
        .catch(() => cleanupFailures.push('prepared-fixture-posts-clear'));
      await db.query('update blog_private.admin_sessions set revoked_at = coalesce(revoked_at, clock_timestamp()) where user_id = $1', [ownerUser.id])
        .catch(() => cleanupFailures.push('admin-sessions-revoke'));
      await db.query("update auth.sessions set not_after = least(coalesce(not_after, clock_timestamp()), clock_timestamp() - interval '1 second') where user_id = $1", [ownerUser.id])
        .catch(() => cleanupFailures.push('owner-auth-sessions-revoke'));
    }
    if (db && unauthorizedUser?.id) {
      await db.query("update auth.sessions set not_after = least(coalesce(not_after, clock_timestamp()), clock_timestamp() - interval '1 second') where user_id = $1", [unauthorizedUser.id])
        .catch(() => cleanupFailures.push('unauth-sessions-revoke'));
    }
    if (db && ownerClaimed) {
      try {
        const restored = await db.query('update blog_private.settings set authorized_owner_id = null where singleton and authorized_owner_id = $1', [ownerUser.id]);
        assert.equal(restored.rowCount, 1);
      } catch {
        cleanupFailures.push('owner-setting-restore');
      }
    }

    await db?.end().catch(() => cleanupFailures.push('database-close'));
    if (edge) await new Promise((done) => edge.close(done)).catch(() => cleanupFailures.push('edge-close'));
    await rm(temp, { recursive: true, force: true }).catch(() => cleanupFailures.push('temp-cleanup'));
  }

  if (cleanupFailures.length > 0) {
    process.stderr.write(`Full-flow cleanup failed: ${cleanupFailures.join(', ')}\n`);
  }
  if (primaryFailure) {
    if (cleanupFailures.length > 0) primaryFailure.cleanupFailures = cleanupFailures;
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) throw new Error(`Full-flow cleanup failed: ${cleanupFailures.join(', ')}`);
  process.stdout.write('PASS full-flow-complete-with-exact-cas-cleanup\n');
}
