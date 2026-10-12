import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
import { promoteMedia } from '../../server/blog/media.mjs';
import { readBlogConfig } from '../../server/blog/config.mjs';
import { requireAdmin } from '../../server/blog/auth.mjs';
import { freezeRelease, getPublicationSummary, markPrepared, savePost } from '../../server/blog/repositories.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const projectId = 'jt-studio-blog-tests';
const apiPort = 54341;
const dbPort = 54342;
const appPort = 8892;
const functionPort = 8893;
const appOrigin = 'https://127.0.0.1:8443';
const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
const netlify = join(root, 'node_modules/.bin/netlify');
const storageNames = new Set([
  'supabase_db_jt-studio-blog-tests',
  'supabase_auth_jt-studio-blog-tests',
  'supabase_rest_jt-studio-blog-tests',
  'supabase_kong_jt-studio-blog-tests',
  'supabase_storage_jt-studio-blog-tests',
  'supabase_storage_init_jt-studio-blog-tests',
]);

function check(condition, stage) { if (!condition) throw new Error(stage); }

async function within(promise, stage, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(stage)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function safeAuthErrorCode(body) {
  const code = [body?.code, body?.error_code, body?.error]
    .find((value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value));
  return code ?? 'unknown';
}

function safeStoragePolicyCode(body) {
  if (String(body?.statusCode) !== '403') return 'unknown';
  const messages = [body?.message, body?.error, body?.error_description]
    .filter((value) => typeof value === 'string');
  if (messages.some((message) => /row.level.security|policy/i.test(message))) return 'policy';
  if (messages.some((message) => /\bunauthorized\b|\baccessdenied\b/i.test(message))) return 'access-denied';
  return 'unknown';
}

function safePrivateObjectReadCode(body) {
  if (String(body?.statusCode) === '403') return safeStoragePolicyCode(body);
  if (String(body?.statusCode) === '404' && body?.error === 'not_found') return 'object-not-found';
  return 'unknown';
}

async function jsonResponse(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'manual' });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function directStorageRequest(url, { method = 'GET', anonKey, accessToken, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'image/webp' } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let bodyJson;
  try { bodyJson = JSON.parse(bytes.toString('utf8')); } catch { bodyJson = null; }
  return { status: response.status, contentType: response.headers.get('content-type'), bytes, body: bodyJson };
}

function jwtExpirySeconds(token) {
  try {
    const pieces = token.split('.');
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    return pieces.length === 3 && Number.isSafeInteger(claims.exp) ? claims.exp : null;
  } catch { return null; }
}

function privateReadDenied(result) {
  const objectCode = safePrivateObjectReadCode(result.body);
  const policyCode = safeStoragePolicyCode(result.body);
  return !/image\/webp/iu.test(result.contentType ?? '')
    && (([400, 404].includes(result.status) && objectCode === 'object-not-found')
      || ([400, 403].includes(result.status) && ['policy', 'access-denied'].includes(policyCode)));
}

function privateWriteDenied(result) {
  return [400, 403].includes(result.status)
    && ['policy', 'access-denied'].includes(safeStoragePolicyCode(result.body));
}

function dockerSocketPath() {
  const result = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  check(result.status === 0 && result.stdout.trim().startsWith('unix:///'), 'docker-context-socket');
  return result.stdout.trim().slice('unix://'.length);
}

async function readLocalStatus() {
  const proxy = createDockerLoopbackProxy({ upstreamSocketPath: dockerSocketPath(), allowedNames: storageNames });
  const socketPath = await proxy.listen();
  try {
    const env = createSupabaseCliEnvironment(process.env, socketPath);
    const version = await runCliCapture(process.execPath, [cliPath, '--version'], { cwd: root, env });
    check(version.status === 0 && version.stdout.trim() === '2.120.0', 'supabase-cli-version');
    const result = await runCliCapture(process.execPath, [cliPath, 'status', '-o', 'json'], { cwd: root, env });
    check(result.status === 0, 'supabase-local-status');
    const status = JSON.parse(result.stdout);
    validateLocalDatabaseTarget(status, projectId, dbPort);
    check(status.API_URL === `http://127.0.0.1:${apiPort}` && status.ANON_KEY && status.SERVICE_ROLE_KEY, 'supabase-api-target');
    return status;
  } finally { await proxy.close(); }
}

function functionEnvironment(status, ownerId, encryptionKey, taskHome, supabaseUrl = status.API_URL) {
  const allow = new Set(['PATH', 'LANG', 'LC_ALL', 'TMPDIR']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key)));
  return {
    ...env,
    HOME: taskHome,
    XDG_CONFIG_HOME: join(taskHome, '.config'),
    XDG_CACHE_HOME: join(taskHome, '.cache'),
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    BLOG_ADMIN_USER_ID: ownerId,
    BLOG_SESSION_ENCRYPTION_KEY: encryptionKey,
    BLOG_PUBLIC_ORIGIN: appOrigin,
  };
}

export function createStorageResponseGate(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  let armed = null;
  let recordVariantWatch = null;
  const pendingGates = new Set();
  const server = http.createServer((request, response) => {
    const isRecordVariant = request.method === 'POST' && request.url?.split('?', 1)[0] === '/rest/v1/rpc/blog_media_record_variant';
    const captureRequest = isRecordVariant && recordVariantWatch;
    const requestChunks = [];
    const send = (requestBody) => {
      const outgoing = http.request({
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: upstream.host, ...(requestBody ? { 'content-length': requestBody.length } : {}) },
      }, async (incoming) => {
        const target = armed && request.method === armed.method && request.url?.split('?', 1)[0] === armed.path;
        if (target) {
          const chunks = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          const metadata = { status: incoming.statusCode, contentType: incoming.headers['content-type'], byteLength: body.length };
          const gate = armed;
          armed = null;
          pendingGates.add(gate);
          gate.ready(metadata);
          await gate.released;
          pendingGates.delete(gate);
          if (!response.destroyed) {
            const headers = { ...incoming.headers, 'content-length': String(body.length) };
            delete headers['transfer-encoding'];
            response.writeHead(incoming.statusCode ?? 502, headers);
            response.end(body);
          }
          return;
        }
        if (captureRequest && requestBody) {
          const chunks = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          let mediaId = null;
          try { mediaId = JSON.parse(requestBody.toString('utf8'))?.p_media_id; } catch { /* never expose request data */ }
          if (mediaId === recordVariantWatch.mediaId) {
            let code = 'unknown';
            try {
              const parsed = JSON.parse(body.toString('utf8'));
              const candidate = parsed?.code ?? parsed?.error_code;
              if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(candidate)) code = candidate;
            } catch { /* status alone remains safe */ }
            recordVariantWatch.resolve({ status: incoming.statusCode, code });
            recordVariantWatch = null;
          }
          if (!response.destroyed) {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            response.end(body);
          }
          return;
        }
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      outgoing.on('error', () => { if (!response.destroyed) response.writeHead(502).end(); });
      if (requestBody) outgoing.end(requestBody);
      else request.pipe(outgoing);
    };
    if (captureRequest) {
      request.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));
      request.on('end', () => send(Buffer.concat(requestChunks)));
    } else send(null);
  });
  let origin;
  return {
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      return origin;
    },
    arm(method, path) {
      check(!armed, 'storage-response-gate-already-armed');
      let readyResolve;
      let releaseResolve;
      const ready = new Promise((resolveReady) => { readyResolve = resolveReady; });
      const released = new Promise((resolveRelease) => { releaseResolve = resolveRelease; });
      const gate = { method, path, ready: readyResolve, released, release: releaseResolve };
      armed = gate;
      return { ready, release: () => { gate.release(); pendingGates.delete(gate); } };
    },
    watchRecordVariant(mediaId) {
      check(!recordVariantWatch, 'record-variant-watch-already-armed');
      let resolve;
      const result = new Promise((resolveResult) => { resolve = resolveResult; });
      recordVariantWatch = { mediaId, resolve };
      return result;
    },
    async close() {
      if (armed) { armed.release(); armed = null; }
      for (const gate of pendingGates) gate.release();
      pendingGates.clear();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
    get origin() { return origin; },
  };
}

async function makeWebp(width, height, color) {
  return sharp({ create: { width, height, channels: 3, background: color } }).webp({ lossless: true }).toBuffer();
}

async function waitForFunction(processHandle) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('netlify-dev-exited');
    try {
      await fetch(`http://127.0.0.1:${appPort}/api/admin/session`, { signal: AbortSignal.timeout(500) });
      return;
    } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 150)); }
  }
  throw new Error('netlify-dev-timeout');
}

export async function runMediaProof() {
  const status = await readLocalStatus();
  const { Client } = await import('pg');
  const db = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 12000, statement_timeout: 12000, application_name: 'jt-studio-task5-media-proof' });
  const temp = await mkdtemp(join(tmpdir(), 'jt-studio-task5-media-'));
  let netlifyProcess;
  let storageProxy;
  let ownerId;
  let otherUserId;
  let ownerSet = false;
  let primaryError;
  try {
    await db.connect();
    const initial = await db.query('select authorized_owner_id from blog_private.settings where singleton');
    check(initial.rowCount === 1 && initial.rows[0].authorized_owner_id === null, 'owner-baseline-not-null');

    const email = `task5-${randomUUID()}@example.com`;
    const password = `T5!${randomUUID()}`;
    const otherEmail = `task5-other-${randomUUID()}@example.com`;
    const otherPassword = `T5!${randomUUID()}`;
    check(Buffer.byteLength(password, 'utf8') <= 72 && Buffer.byteLength(otherPassword, 'utf8') <= 72,
      'auth-fixture-password-byte-limit');
    const created = await jsonResponse(new URL('/auth/v1/admin/users', status.API_URL), {
      method: 'POST', headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    check([200, 201].includes(created.response.status) && typeof created.body?.id === 'string',
      `auth-owner-fixture-create-${created.response.status}-${safeAuthErrorCode(created.body)}`);
    ownerId = created.body.id;
    const otherCreated = await jsonResponse(new URL('/auth/v1/admin/users', status.API_URL), {
      method: 'POST', headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password: otherPassword, email_confirm: true }),
    });
    check([200, 201].includes(otherCreated.response.status) && typeof otherCreated.body?.id === 'string' && otherCreated.body.id !== ownerId, 'auth-other-fixture-create');
    otherUserId = otherCreated.body.id;
    const installed = await db.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id is null', [ownerId]);
    check(installed.rowCount === 1, 'owner-install-conditional');
    ownerSet = true;

    const taskHome = join(temp, 'home');
    const publicDir = join(temp, 'public');
    await mkdir(taskHome, { recursive: true, mode: 0o700 });
    await mkdir(publicDir, { mode: 0o700 });
    await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Task 5 media proof</title>');
    const encryptionKey = randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
    const logs = [];
    storageProxy = createStorageResponseGate(status.API_URL);
    const storageProxyUrl = await storageProxy.listen();
    netlifyProcess = spawn(netlify, ['dev', '--offline', '--no-open', '--port', String(appPort), '--functions-port', String(functionPort), '--functions', 'netlify/functions', '--dir', publicDir], {
      cwd: root, env: functionEnvironment(status, ownerId, encryptionKey, taskHome, storageProxyUrl), stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [netlifyProcess.stdout, netlifyProcess.stderr]) stream.on('data', (chunk) => { if (logs.join('').length < 16000) logs.push(chunk.toString('utf8')); });
    try { await waitForFunction(netlifyProcess); }
    catch {
      const output = logs.join('');
      const category = /EADDRINUSE/u.test(output) ? 'address-in-use'
        : /EACCES|EPERM/u.test(output) ? 'permission-denied'
          : /MODULE_NOT_FOUND|Cannot find package/u.test(output) ? 'missing-module' : 'startup-failed';
      throw new Error(`netlify-${category}`);
    }

    const login = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/session`, {
      method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password }),
    });
    check(login.response.status === 200 && login.body?.authenticated === true && login.body?.user?.id === ownerId, 'owner-login');
    let cookie = login.response.headers.get('set-cookie')?.split(';', 1)[0];
    let csrf = login.body.csrfToken;
    check(cookie?.startsWith('__Host-jt_admin=') && typeof csrf === 'string', 'session-cookie-and-csrf');
    let mutationHeaders = { origin: appOrigin, cookie, 'x-csrf-token': csrf };
    const mediaId = randomUUID();
    const variants = [
      { width: 960, height: 640, bytes: await makeWebp(960, 640, '#3478a8') },
      { width: 480, height: 320, bytes: await makeWebp(480, 320, '#3478a8') },
    ];

    const anonymousPreview = await fetch(`http://127.0.0.1:${appPort}/api/admin/media/preview?mediaId=${mediaId}&width=480`);
    check(anonymousPreview.status === 401, 'anonymous-preview-denied');

    const first = variants[0];
    const query = new URLSearchParams({ mediaId, width: String(first.width), height: String(first.height) });
    const uploadUrl = `http://127.0.0.1:${appPort}/api/admin/media/upload?${query}`;
    const directFunctionUploadUrl = new URL(uploadUrl);
    directFunctionUploadUrl.port = String(functionPort);
    const wrongOrigin = await jsonResponse(directFunctionUploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, origin: 'https://untrusted.example', 'content-type': 'image/webp' }, body: first.bytes,
    });
    check(wrongOrigin.response.status === 403 && wrongOrigin.body?.error?.code === 'BLOG_FORBIDDEN', `direct-function-wrong-origin-upload-${wrongOrigin.response.status}`);
    const wrongCsrf = await jsonResponse(directFunctionUploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'x-csrf-token': 'invalid-csrf-token-for-test-000000', 'content-type': 'image/webp' }, body: first.bytes,
    });
    check(wrongCsrf.response.status === 403 && wrongCsrf.body?.error?.code === 'BLOG_FORBIDDEN', `direct-function-wrong-csrf-upload-${wrongCsrf.response.status}`);
    const wrongMime = await jsonResponse(directFunctionUploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: first.bytes,
    });
    check(wrongMime.response.status === 403 && wrongMime.body?.error?.code === 'BLOG_FORBIDDEN', `direct-function-wrong-mime-upload-${wrongMime.response.status}`);
    const otherAuth = await jsonResponse(new URL('/auth/v1/token?grant_type=password', status.API_URL), {
      method: 'POST', headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, password: otherPassword }),
    });
    check(otherAuth.response.status === 200 && typeof otherAuth.body?.access_token === 'string', 'other-user-auth-session');
    const directObjectPath = `draft/${otherCreated.body.id}/${randomUUID()}/480.webp`;
    const otherStorageWrite = await fetch(new URL(`/storage/v1/object/blog-drafts/${directObjectPath}`, status.API_URL), {
      method: 'POST', headers: { apikey: status.ANON_KEY, authorization: `Bearer ${otherAuth.body.access_token}`, 'content-type': 'image/webp' }, body: first.bytes,
    });
    let otherStorageWriteBody;
    try { otherStorageWriteBody = await otherStorageWrite.clone().json(); } catch { otherStorageWriteBody = null; }
    const storagePolicyCode = safeStoragePolicyCode(otherStorageWriteBody);
    check([401, 403, 404].includes(otherStorageWrite.status)
      || (otherStorageWrite.status === 400 && ['policy', 'access-denied'].includes(storagePolicyCode)),
    `nonowner-direct-storage-write-${otherStorageWrite.status}-${storagePolicyCode}`);
    const directObject = await db.query("select 1 from storage.objects where bucket_id='blog-drafts' and name=$1", [directObjectPath]);
    check(directObject.rowCount === 0, 'nonowner-direct-storage-object-absent');
    const directMedia = await db.query('select 1 from public.blog_media where id=$1', [mediaId]);
    check(directMedia.rowCount === 0, 'nonowner-direct-storage-media-absent');

    const uploadOne = await jsonResponse(uploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: first.bytes,
    });
    check(uploadOne.response.status === 200 && uploadOne.body?.variant?.width === first.width, `first-upload-${uploadOne.response.status}`);
    const incomplete = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/complete`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ mediaId }),
    });
    check(incomplete.response.status !== 200, 'master-only-group-not-completed');
    const uploadRetry = await jsonResponse(uploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: first.bytes,
    });
    check(uploadRetry.response.status === 200, `same-byte-retry-${uploadRetry.response.status}`);
    const different = await makeWebp(first.width, first.height, '#d76239');
    const conflict = await jsonResponse(uploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: different,
    });
    check(conflict.response.status === 409, `different-byte-retry-${conflict.response.status}`);

    const smaller = variants[1];
    const secondQuery = new URLSearchParams({ mediaId, width: String(smaller.width), height: String(smaller.height) });
    const uploadTwo = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/upload?${secondQuery}`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: smaller.bytes,
    });
    check(uploadTwo.response.status === 200, `second-upload-${uploadTwo.response.status}`);
    const completed = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/complete`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ mediaId }),
    });
    check(completed.response.status === 200 && completed.body?.media?.state === 'complete', `group-completion-${completed.response.status}`);

    const authConfig = readBlogConfig({
      SUPABASE_URL: status.API_URL,
      SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      BLOG_ADMIN_USER_ID: ownerId,
      BLOG_SESSION_ENCRYPTION_KEY: encryptionKey,
      BLOG_PUBLIC_ORIGIN: appOrigin,
    });
    const auth = await requireAdmin(new Request(`${appOrigin}/api/admin/posts`, { headers: { cookie } }), {}, { config: authConfig });
    const postSlug = `task5-media-${randomUUID()}`;
    const postDraft = {
      title: 'Task 5 confirmed media proof', slug: postSlug, excerpt: 'Private media promotion proof',
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Confirmed media proof.' }] }] },
      coverMediaId: mediaId, serviceId: null,
    };
    const savedPost = await savePost(auth, postDraft, 0);
    check(typeof savedPost.id === 'string' && savedPost.revision === 1, 'promotion-post-created-through-editor-rpc');
    await markPrepared(auth, savedPost.id, savedPost.revision, 'upsert');
    const summary = await getPublicationSummary(auth);
    check(typeof summary?.digest === 'string' && /^[a-f0-9]{64}$/.test(summary.digest), 'promotion-publication-summary');
    const release = await freezeRelease(auth, randomUUID(), summary.digest);
    const confirmedBeforePromotion = await db.query(`
      select b.latest_confirmed_release_id::text release_id,r.payload_text,r.digest
      from blog_private.build_slot b join blog_private.releases r on r.release_id=b.latest_confirmed_release_id
      where b.singleton
    `);
    check(confirmedBeforePromotion.rowCount === 1 && confirmedBeforePromotion.rows[0].release_id === release.releaseId
      && confirmedBeforePromotion.rows[0].payload_text === release.payload && confirmedBeforePromotion.rows[0].digest === release.digest,
    'promotion-release-confirmed-through-editor-rpc');
    const releasePayload = JSON.parse(release.payload);
    const releasePost = releasePayload.posts.find((post) => post.id === savedPost.id);
    check(releasePost?.coverMedia?.id === mediaId && Array.isArray(releasePost.coverMedia.variants)
      && releasePost.coverMedia.variants.length === variants.length, 'confirmed-release-references-complete-media');

    const promoted = await promoteMedia(auth, [mediaId]);
    const publicVariants = promoted[mediaId];
    check(Array.isArray(publicVariants) && publicVariants.length === variants.length, 'internal-promotion-returns-all-confirmed-variants');
    for (const publicVariant of publicVariants) {
      const sourceVariant = variants.find((variant) => variant.width === publicVariant.width);
      const expectedPath = `/storage/v1/object/public/blog-public/${publicVariant.objectKey}`;
      const publicUrl = new URL(publicVariant.url);
      check(sourceVariant && publicUrl.pathname === expectedPath, 'promotion-url-uses-public-blog-bucket');
      const publicResponse = await fetch(publicUrl, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      const publicBytes = Buffer.from(await publicResponse.arrayBuffer());
      check(publicResponse.status === 200 && publicResponse.headers.get('content-type') === 'image/webp'
        && publicBytes.equals(sourceVariant.bytes), `public-confirmed-media-bytes-${publicVariant.width}`);
    }
    const publicObjects = await db.query("select count(*)::int count from storage.objects where bucket_id='blog-public' and name like $1", [`public/${mediaId}/%`]);
    check(publicObjects.rows[0]?.count === variants.length, 'public-confirmed-media-object-count');

    const nextMediaId = randomUUID();
    const nextVariants = [
      { width: 960, height: 640, bytes: await makeWebp(960, 640, '#b74f92') },
      { width: 480, height: 320, bytes: await makeWebp(480, 320, '#b74f92') },
    ];
    const nextMaster = nextVariants[0];
    const nextMasterQuery = new URLSearchParams({ mediaId: nextMediaId, width: String(nextMaster.width), height: String(nextMaster.height) });
    const nextMasterUpload = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/upload?${nextMasterQuery}`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: nextMaster.bytes,
    });
    check(nextMasterUpload.response.status === 200, `next-photo-master-upload-${nextMasterUpload.response.status}`);
    const nextSmall = nextVariants[1];
    const nextSmallQuery = new URLSearchParams({ mediaId: nextMediaId, width: String(nextSmall.width), height: String(nextSmall.height) });
    const nextSmallUpload = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/upload?${nextSmallQuery}`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' }, body: nextSmall.bytes,
    });
    check(nextSmallUpload.response.status === 200, `next-photo-variant-upload-${nextSmallUpload.response.status}`);
    const nextComplete = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/complete`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ mediaId: nextMediaId }),
    });
    check(nextComplete.response.status === 200 && nextComplete.body?.media?.state === 'complete', 'next-photo-complete');
    const revisedDraft = await savePost(auth, { id: savedPost.id, ...postDraft, coverMediaId: nextMediaId }, savedPost.revision);
    check(revisedDraft.id === savedPost.id && revisedDraft.revision === 2, 'new-photo-saved-as-unconfirmed-revision');
    await markPrepared(auth, revisedDraft.id, revisedDraft.revision, 'upsert');
    let unconfirmedPromotionDenied = false;
    try { await promoteMedia(auth, [nextMediaId]); }
    catch (error) { unconfirmedPromotionDenied = error?.status === 403 && error?.code === 'BLOG_FORBIDDEN'; }
    check(unconfirmedPromotionDenied, 'unconfirmed-new-photo-cannot-be-promoted');
    const unconfirmedPublicObjects = await db.query("select count(*)::int count from storage.objects where bucket_id='blog-public' and name like $1", [`public/${nextMediaId}/%`]);
    check(unconfirmedPublicObjects.rows[0]?.count === 0, 'unconfirmed-photo-created-no-public-objects');
    const confirmedAfterRevision = await db.query(`
      select b.latest_confirmed_release_id::text release_id,r.payload_text,r.digest
      from blog_private.build_slot b join blog_private.releases r on r.release_id=b.latest_confirmed_release_id
      where b.singleton
    `);
    check(confirmedAfterRevision.rowCount === 1 && confirmedAfterRevision.rows[0].release_id === release.releaseId
      && confirmedAfterRevision.rows[0].payload_text === release.payload && confirmedAfterRevision.rows[0].digest === release.digest,
    'confirmed-media-release-remains-immutable-after-new-photo-review');
    for (const publicVariant of publicVariants) {
      const sourceVariant = variants.find((variant) => variant.width === publicVariant.width);
      const oldUrlResponse = await fetch(publicVariant.url, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      const oldUrlBytes = Buffer.from(await oldUrlResponse.arrayBuffer());
      check(oldUrlResponse.status === 200 && oldUrlBytes.equals(sourceVariant.bytes), `old-confirmed-public-url-still-serves-bytes-${publicVariant.width}`);
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const browserPublicUrl = new URL(publicVariants.find((variant) => variant.width === 960).url);
      check(browserPublicUrl.origin === status.API_URL && browserPublicUrl.pathname.startsWith('/storage/v1/object/public/blog-public/'),
        'browser-public-image-url-is-direct-storage-origin');
      const browserResponse = await page.goto(browserPublicUrl.href, { waitUntil: 'load', timeout: 15000 });
      const browserImageBytes = Buffer.from(await browserResponse.body());
      check(browserResponse.status() === 200 && browserResponse.url() === browserPublicUrl.href
        && browserResponse.headers()['content-type'] === 'image/webp'
        && browserImageBytes.equals(variants.find((variant) => variant.width === 960).bytes),
      'anonymous-browser-reads-direct-confirmed-storage-image');
    } finally { await browser.close(); }

    const previewUrl = `http://127.0.0.1:${appPort}/api/admin/media/preview?mediaId=${mediaId}&width=960`;
    const preview = await fetch(previewUrl, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    check(preview.status === 200 && preview.headers.get('content-type') === 'image/webp'
      && preview.headers.get('cache-control') === 'private, no-store'
      && previewBytes.equals(first.bytes), 'private-preview-exact-bytes');

    const privateObjectName = `draft/${ownerId}/${mediaId}/960.webp`;
    const privateObject = await db.query("select 1 from storage.objects where bucket_id='blog-drafts' and name=$1", [privateObjectName]);
    check(privateObject.rowCount === 1, 'private-preview-object-exists');
    const storageObjectUrl = `${status.API_URL}/storage/v1/object/blog-drafts/${privateObjectName}`;
    const serviceObject = await fetch(storageObjectUrl, {
      headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
    const serviceObjectBytes = Buffer.from(await serviceObject.arrayBuffer());
    check(serviceObject.status === 200 && serviceObject.headers.get('content-type') === 'image/webp'
      && serviceObjectBytes.equals(first.bytes), 'service-role-confirms-existing-private-object-bytes');
    const storageAnon = await fetch(storageObjectUrl, {
      headers: { apikey: status.ANON_KEY, authorization: `Bearer ${status.ANON_KEY}` },
      signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
    const storageAnonBytes = Buffer.from(await storageAnon.arrayBuffer());
    let storageAnonBody;
    try { storageAnonBody = JSON.parse(storageAnonBytes.toString('utf8')); } catch { storageAnonBody = null; }
    const anonymousStorageReadCode = safePrivateObjectReadCode(storageAnonBody);
    const anonymousReturnedObject = storageAnon.headers.get('content-type') === 'image/webp'
      && storageAnonBytes.equals(first.bytes);
    check(!anonymousReturnedObject && ([401, 403].includes(storageAnon.status)
      || ([400, 404].includes(storageAnon.status) && anonymousStorageReadCode === 'object-not-found')),
    `anonymous-private-object-${storageAnon.status}-${anonymousStorageReadCode}`);
    const promote = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/media/promote`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ mediaIds: [mediaId] }),
    });
    check(promote.response.status === 404, `browser-promotion-route-absent-${promote.response.status}`);

    const cancelledMediaId = randomUUID();
    const cancelledVariant = { width: 960, height: 640, bytes: await makeWebp(960, 640, '#e3a63d') };
    const cancelledObjectName = `draft/${ownerId}/${cancelledMediaId}/960.webp`;
    const cancelledObjectPath = `/storage/v1/object/blog-drafts/${cancelledObjectName}`;
    const cancelledUploadQuery = new URLSearchParams({ mediaId: cancelledMediaId, width: '960', height: '640' });
    const cancelledUploadUrl = `http://127.0.0.1:${functionPort}/api/admin/media/upload?${cancelledUploadQuery}`;
    const uploadGate = storageProxy.arm('POST', cancelledObjectPath);
    const recordVariantResult = storageProxy.watchRecordVariant(cancelledMediaId);
    const uploadController = new AbortController();
    const cancelledUploadResponse = fetch(cancelledUploadUrl, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'image/webp' },
      body: cancelledVariant.bytes, signal: uploadController.signal,
    }).then(async (response) => ({ status: response.status, contentType: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) }))
      .catch((error) => ({ errorName: error?.name === 'AbortError' ? 'AbortError' : 'request-failed' }));
    const physicalUpload = await within(uploadGate.ready, 'cancel-upload-storage-response-timeout');
    check(physicalUpload.status === 200 && /^application\/json(?:;|$)/iu.test(physicalUpload.contentType ?? '')
      && physicalUpload.byteLength > 0, `cancel-upload-storage-accepted-${physicalUpload.status}-${physicalUpload.contentType ?? 'no-content-type'}`);
    uploadController.abort();
    const logout = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/session`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }),
    });
    check(logout.response.status === 200, `cancel-upload-logout-${logout.response.status}`);
    uploadGate.release();
    const recordVariant = await within(recordVariantResult, 'cancel-upload-record-variant-timeout');
    check(recordVariant.status === 403 || recordVariant.code === '42501', 'cancel-upload-record-variant-denied-after-logout');
    const cancelledFunctionResult = await within(cancelledUploadResponse, 'cancel-upload-function-response-timeout');
    check(cancelledFunctionResult.errorName === 'AbortError' || cancelledFunctionResult.status === 403,
      'cancel-upload-client-response-terminated-or-denied');
    const orphanRow = await db.query("select owner,metadata->>'mimetype' mime from storage.objects where bucket_id='blog-drafts' and name=$1", [cancelledObjectName]);
    check(orphanRow.rowCount === 1 && orphanRow.rows[0].owner === ownerId && orphanRow.rows[0].mime === 'image/webp',
      'cancel-upload-private-object-retained');
    const orphanDownload = await fetch(`${status.API_URL}${cancelledObjectPath}`, {
      headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(15000), redirect: 'manual',
    });
    const orphanBytes = Buffer.from(await orphanDownload.arrayBuffer());
    check(orphanDownload.status === 200 && orphanBytes.equals(cancelledVariant.bytes), 'cancel-upload-orphan-exact-bytes-retained');
    const cancelledMedia = await db.query('select 1 from public.blog_media where id=$1', [cancelledMediaId]);
    const cancelledIntent = await db.query('select 1 from blog_private.media_upload_intents where media_id=$1', [cancelledMediaId]);
    check(cancelledMedia.rowCount === 0 && cancelledIntent.rowCount === 0, 'cancel-upload-no-media-or-intent-after-denied-rpc');

    const relogin = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/session`, {
      method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password }),
    });
    check(relogin.response.status === 200 && relogin.body?.authenticated === true && relogin.body?.user?.id === ownerId,
      'preview-race-new-session-login');
    cookie = relogin.response.headers.get('set-cookie')?.split(';', 1)[0];
    csrf = relogin.body.csrfToken;
    check(cookie?.startsWith('__Host-jt_admin=') && typeof csrf === 'string', 'preview-race-new-session-cookie-csrf');
    mutationHeaders = { origin: appOrigin, cookie, 'x-csrf-token': csrf };
    const previewGate = storageProxy.arm('GET', `/storage/v1/object/blog-drafts/${privateObjectName}`);
    const racedPreview = fetch(`http://127.0.0.1:${functionPort}/api/admin/media/preview?mediaId=${mediaId}&width=960`, {
      headers: { cookie }, signal: AbortSignal.timeout(15000), redirect: 'manual',
    }).then(async (response) => ({ status: response.status, contentType: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) }));
    const physicalPreview = await within(previewGate.ready, 'preview-race-storage-response-timeout');
    check(physicalPreview.status === 200 && physicalPreview.contentType === 'image/webp'
      && physicalPreview.byteLength === first.bytes.length, 'preview-race-storage-returned-real-image');
    const previewRaceLogout = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/session`, {
      method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'logout' }),
    });
    check(previewRaceLogout.response.status === 200, `preview-race-logout-${previewRaceLogout.response.status}`);
    previewGate.release();
    const racedPreviewResult = await within(racedPreview, 'preview-race-function-response-timeout');
    check(racedPreviewResult.status === 403 && racedPreviewResult.contentType !== 'image/webp'
      && !racedPreviewResult.bytes.equals(first.bytes), 'preview-race-original-session-revalidated-after-download');
    const afterLogout = await fetch(previewUrl, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
    check(afterLogout.status === 401, 'preview-after-logout-denied');

    const directLogin = async () => {
      const result = await jsonResponse(`http://127.0.0.1:${appPort}/api/admin/session`, {
        method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'login', email, password }),
      });
      check(result.response.status === 200 && result.body?.authenticated === true, `direct-storage-owner-login-${result.response.status}`);
      const directCookie = result.response.headers.get('set-cookie')?.split(';', 1)[0];
      check(directCookie?.startsWith('__Host-jt_admin='), 'direct-storage-owner-cookie');
      const captured = await requireAdmin(new Request(`${appOrigin}/api/admin/posts`, { headers: { cookie: directCookie } }), {}, { config: authConfig });
      const expiry = jwtExpirySeconds(captured.accessToken);
      check(expiry !== null && expiry > Math.floor(Date.now() / 1000) + 60, 'direct-storage-owner-jwt-unexpired');
      return captured;
    };
    const authorityA = await directLogin();
    check(authorityA.userId === ownerId && authorityA.sessionId !== auth.sessionId, 'direct-storage-app-context-is-new');

    const establishedPrivateRead = await directStorageRequest(storageObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityA.accessToken,
    });
    check(establishedPrivateRead.status === 200 && establishedPrivateRead.contentType === 'image/webp'
      && establishedPrivateRead.bytes.equals(first.bytes), `direct-storage-owner-get-positive-${establishedPrivateRead.status}`);

    const positiveDirectMediaId = randomUUID();
    const positiveDirectObjectName = `draft/${ownerId}/${positiveDirectMediaId}/480.webp`;
    const positiveDirectObjectUrl = `${status.API_URL}/storage/v1/object/blog-drafts/${positiveDirectObjectName}`;
    const directPositiveWrite = await directStorageRequest(positiveDirectObjectUrl, {
      method: 'POST', anonKey: status.ANON_KEY, accessToken: authorityA.accessToken, body: first.bytes,
    });
    check(directPositiveWrite.status === 200, `direct-storage-owner-post-positive-${directPositiveWrite.status}`);
    const directPositiveRead = await directStorageRequest(positiveDirectObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityA.accessToken,
    });
    check(directPositiveRead.status === 200 && directPositiveRead.contentType === 'image/webp'
      && directPositiveRead.bytes.equals(first.bytes), `direct-storage-owner-post-get-exact-bytes-${directPositiveRead.status}`);
    const directPositiveMetadata = await db.query(
      "select owner_id from storage.objects where bucket_id='blog-drafts' and name=$1", [positiveDirectObjectName],
    );
    check(directPositiveMetadata.rowCount === 1 && directPositiveMetadata.rows[0].owner_id === ownerId,
      'direct-storage-positive-object-metadata');

    const appInvalidated = await db.query(
      `update blog_private.admin_sessions set revoked_at=clock_timestamp()
       where session_id=$1 and user_id=$2 and revoked_at is null returning session_id`,
      [authorityA.sessionId, ownerId],
    );
    check(appInvalidated.rowCount === 1, 'direct-storage-app-authority-revoked-exact-row');
    const appInvalidationState = await db.query(`
      select (app.revoked_at is null and app.expires_at>clock_timestamp() and app.auth_expires_at>clock_timestamp()) as app_live,
        (provider.not_after is null or provider.not_after>clock_timestamp()) as provider_live
      from blog_private.admin_sessions app join auth.sessions provider
        on provider.id=app.auth_session_id and provider.user_id=app.user_id
      where app.session_id=$1 and app.user_id=$2 and provider.id=$3`,
    [authorityA.sessionId, ownerId, authorityA.authSessionId]);
    check(appInvalidationState.rowCount === 1 && appInvalidationState.rows[0].app_live === false
      && appInvalidationState.rows[0].provider_live === true, 'direct-storage-app-expired-provider-live-control');
    check(jwtExpirySeconds(authorityA.accessToken) > Math.floor(Date.now() / 1000),
      'direct-storage-app-invalidated-jwt-remains-unexpired');
    const appDeniedRead = await directStorageRequest(storageObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityA.accessToken,
    });
    check(privateReadDenied(appDeniedRead) && !appDeniedRead.bytes.equals(first.bytes),
      `direct-storage-app-invalidated-get-denied-${appDeniedRead.status}-${safePrivateObjectReadCode(appDeniedRead.body)}`);
    const appDeniedMediaId = randomUUID();
    const appDeniedObjectName = `draft/${ownerId}/${appDeniedMediaId}/480.webp`;
    const appDeniedWrite = await directStorageRequest(`${status.API_URL}/storage/v1/object/blog-drafts/${appDeniedObjectName}`, {
      method: 'POST', anonKey: status.ANON_KEY, accessToken: authorityA.accessToken, body: first.bytes,
    });
    check(privateWriteDenied(appDeniedWrite),
      `direct-storage-app-invalidated-post-denied-${appDeniedWrite.status}-${safeStoragePolicyCode(appDeniedWrite.body)}`);
    const appDeniedState = await db.query(`
      select
        (select count(*)::int from storage.objects where bucket_id='blog-drafts' and name=$1) as objects,
        (select count(*)::int from public.blog_media where id=$2) as media,
        (select count(*)::int from blog_private.media_upload_intents where media_id=$2) as intents`,
    [appDeniedObjectName, appDeniedMediaId]);
    check(appDeniedState.rows[0]?.objects === 0 && appDeniedState.rows[0]?.media === 0
      && appDeniedState.rows[0]?.intents === 0, 'direct-storage-app-invalidated-post-no-writes');

    const authorityB = await directLogin();
    check(authorityB.userId === ownerId && authorityB.sessionId !== authorityA.sessionId
      && authorityB.authSessionId !== authorityA.authSessionId, 'direct-storage-provider-context-is-independent');
    const providerPositiveRead = await directStorageRequest(storageObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityB.accessToken,
    });
    check(providerPositiveRead.status === 200 && providerPositiveRead.contentType === 'image/webp'
      && providerPositiveRead.bytes.equals(first.bytes), `direct-storage-provider-get-positive-${providerPositiveRead.status}`);
    const providerPositiveMediaId = randomUUID();
    const providerPositiveObjectName = `draft/${ownerId}/${providerPositiveMediaId}/480.webp`;
    const providerPositiveObjectUrl = `${status.API_URL}/storage/v1/object/blog-drafts/${providerPositiveObjectName}`;
    const providerPositiveWrite = await directStorageRequest(providerPositiveObjectUrl, {
      method: 'POST', anonKey: status.ANON_KEY, accessToken: authorityB.accessToken, body: first.bytes,
    });
    check(providerPositiveWrite.status === 200, `direct-storage-provider-post-positive-${providerPositiveWrite.status}`);
    const providerPositiveWrittenRead = await directStorageRequest(providerPositiveObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityB.accessToken,
    });
    check(providerPositiveWrittenRead.status === 200 && providerPositiveWrittenRead.contentType === 'image/webp'
      && providerPositiveWrittenRead.bytes.equals(first.bytes), `direct-storage-provider-post-get-exact-bytes-${providerPositiveWrittenRead.status}`);
    const providerPositiveMetadata = await db.query(
      "select owner_id from storage.objects where bucket_id='blog-drafts' and name=$1", [providerPositiveObjectName],
    );
    check(providerPositiveMetadata.rowCount === 1 && providerPositiveMetadata.rows[0].owner_id === ownerId,
      'direct-storage-provider-positive-object-metadata');
    const providerInvalidated = await db.query(
      `update auth.sessions set not_after=least(coalesce(not_after,clock_timestamp()),clock_timestamp()-interval '1 second'),
        updated_at=clock_timestamp() where id=$1 and user_id=$2 returning id`,
      [authorityB.authSessionId, ownerId],
    );
    check(providerInvalidated.rowCount === 1, 'direct-storage-provider-authority-expired-exact-row');
    const providerInvalidationState = await db.query(`
      select (app.revoked_at is null and app.expires_at>clock_timestamp() and app.auth_expires_at>clock_timestamp()) as app_live,
        (provider.not_after is null or provider.not_after>clock_timestamp()) as provider_live
      from blog_private.admin_sessions app join auth.sessions provider
        on provider.id=app.auth_session_id and provider.user_id=app.user_id
      where app.session_id=$1 and app.user_id=$2 and provider.id=$3`,
    [authorityB.sessionId, ownerId, authorityB.authSessionId]);
    check(providerInvalidationState.rowCount === 1 && providerInvalidationState.rows[0].app_live === true
      && providerInvalidationState.rows[0].provider_live === false, 'direct-storage-provider-expired-app-live-control');
    check(jwtExpirySeconds(authorityB.accessToken) > Math.floor(Date.now() / 1000),
      'direct-storage-provider-invalidated-jwt-remains-unexpired');
    const providerDeniedRead = await directStorageRequest(storageObjectUrl, {
      anonKey: status.ANON_KEY, accessToken: authorityB.accessToken,
    });
    check(privateReadDenied(providerDeniedRead) && !providerDeniedRead.bytes.equals(first.bytes),
      `direct-storage-provider-invalidated-get-denied-${providerDeniedRead.status}-${safePrivateObjectReadCode(providerDeniedRead.body)}`);
    const providerDeniedMediaId = randomUUID();
    const providerDeniedObjectName = `draft/${ownerId}/${providerDeniedMediaId}/480.webp`;
    const providerDeniedWrite = await directStorageRequest(`${status.API_URL}/storage/v1/object/blog-drafts/${providerDeniedObjectName}`, {
      method: 'POST', anonKey: status.ANON_KEY, accessToken: authorityB.accessToken, body: first.bytes,
    });
    check(privateWriteDenied(providerDeniedWrite),
      `direct-storage-provider-invalidated-post-denied-${providerDeniedWrite.status}-${safeStoragePolicyCode(providerDeniedWrite.body)}`);
    const providerDeniedState = await db.query(`
      select
        (select count(*)::int from storage.objects where bucket_id='blog-drafts' and name=$1) as objects,
        (select count(*)::int from public.blog_media where id=$2) as media,
        (select count(*)::int from blog_private.media_upload_intents where media_id=$2) as intents`,
    [providerDeniedObjectName, providerDeniedMediaId]);
    check(providerDeniedState.rows[0]?.objects === 0 && providerDeniedState.rows[0]?.media === 0
      && providerDeniedState.rows[0]?.intents === 0, 'direct-storage-provider-invalidated-post-no-writes');
    process.stdout.write(`Task 5 media E2E passed; retained owner=${ownerId} media=${mediaId} cancelledMedia=${cancelledMediaId} directStorageObject=${positiveDirectMediaId}; appInvalidatedSession=${authorityA.sessionId} providerInvalidatedSession=${authorityB.sessionId}; private objects and session history preserved.\n`);
  } catch (error) { primaryError = error; }
  finally {
    if (netlifyProcess && netlifyProcess.exitCode === null) {
      netlifyProcess.kill('SIGTERM');
      await new Promise((resolveExit) => netlifyProcess.once('exit', resolveExit));
    }
    if (storageProxy) await storageProxy.close().catch(() => { if (!primaryError) primaryError = new Error('storage-proxy-close'); });
    const fixtureUserIds = [ownerId, otherUserId].filter((id) => typeof id === 'string');
    if (fixtureUserIds.length > 0) {
      try {
        await db.query("update auth.sessions set not_after=least(coalesce(not_after,clock_timestamp()),clock_timestamp()-interval '1 second'),updated_at=clock_timestamp() where user_id=any($1::uuid[])", [fixtureUserIds]);
        await db.query("update blog_private.admin_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()),expires_at=least(expires_at,clock_timestamp()-interval '1 second') where user_id=any($1::uuid[])", [fixtureUserIds]);
        const active = await db.query(`select
          (select count(*)::int from auth.sessions where user_id=any($1::uuid[]) and (not_after is null or not_after>clock_timestamp())) as provider,
          (select count(*)::int from blog_private.admin_sessions where user_id=any($1::uuid[]) and revoked_at is null and expires_at>clock_timestamp()) as app`, [fixtureUserIds]);
        check(active.rows[0]?.provider === 0 && active.rows[0]?.app === 0, 'fixture-session-revocation');
      } catch { if (!primaryError) primaryError = new Error('fixture-session-revocation'); }
    }
    if (ownerSet) {
      try {
        const restored = await db.query('update blog_private.settings set authorized_owner_id=null where singleton and authorized_owner_id=$1', [ownerId]);
        check(restored.rowCount === 1, 'owner-setting-restore');
      } catch { if (!primaryError) primaryError = new Error('owner-setting-restore'); }
    }
    await db.end().catch(() => { if (!primaryError) primaryError = new Error('database-close'); });
    await rm(temp, { recursive: true, force: true }).catch(() => { if (!primaryError) primaryError = new Error('test-temp-cleanup'); });
  }
  if (primaryError) throw primaryError;
}
