import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { decryptTokens, encryptTokens } from '../../server/blog/auth.mjs';
import { createServerClient, readBlogConfig } from '../../server/blog/config.mjs';
import { createDockerLoopbackProxy } from '../../scripts/docker-loopback-proxy.mjs';
import { createSupabaseCliEnvironment, runCliCapture, validateLocalDatabaseTarget } from '../../scripts/supabase-local.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const apiPort = 54341;
const projectId = 'jt-studio-blog-tests';
const cliPath = join(root, 'node_modules/supabase/dist/supabase.js');
const browserOrigin = 'https://127.0.0.1:8443';
const appPort = 8888;
const apiBoundaryPort = 54345;
const netlify = join(root, 'node_modules/.bin/netlify');
const nodePath = process.execPath;
let phase = 'setup';

function check(condition, stage) { if (!condition) { const error = new Error(stage); error.stage = stage; throw error; } }
function headers(key, token = key) { return { apikey: key, authorization: `Bearer ${token}` }; }
async function waitForDatabaseExpiry(db, expiresAt, stage) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await db.query('select clock_timestamp() >= $1::timestamptz as expired', [expiresAt]);
    if (result.rows[0]?.expired === true) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check(false, `${stage}-database-expiry-not-reached`);
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}
async function httpsJsonRequest(url, options = {}) {
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(url, {
      method: options.method ?? 'GET',
      headers: { ...options.headers, ...(options.body === undefined ? {} : { 'content-length': Buffer.byteLength(options.body) }) },
      rejectUnauthorized: false,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolveResponse({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('local-origin-probe-timeout')));
    request.once('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
async function directSavePost(apiUrl, anonKey, accessToken, sessionId, slug) {
  const response = await fetch(new URL('/rest/v1/rpc/blog_save_post', apiUrl), {
    method: 'POST',
    headers: { apikey: anonKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      p_input: { title: 'Task 4 JWT binding proof', slug, excerpt: '', document: { type: 'doc', content: [] }, coverMediaId: null, serviceId: null },
      p_expected_revision: 0,
      p_session_id: sessionId,
      p_generation: 1,
    }),
    signal: AbortSignal.timeout(8000),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function safeEnv(base, additions = {}) {
  const env = { ...base, ...additions };
  for (const name of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|KEY$/i.test(name) && !['PATH', 'BLOG_SESSION_ENCRYPTION_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].includes(name)) delete env[name];
  return env;
}

export async function runSessionProof() {
  phase = 'docker-project-inspection';
  const dockerContext = spawnSync('docker', ['--context', 'desktop-linux', 'context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dockerEndpoint = dockerContext.status === 0 ? dockerContext.stdout.trim() : '';
  check(dockerEndpoint.startsWith('unix:///'), 'docker-local-socket');
  const dockerProxy = createDockerLoopbackProxy({
    upstreamSocketPath: dockerEndpoint.slice('unix://'.length),
    allowedNames: new Set(['supabase_db_jt-studio-blog-tests', 'supabase_auth_jt-studio-blog-tests', 'supabase_rest_jt-studio-blog-tests', 'supabase_kong_jt-studio-blog-tests']),
  });
  const dockerSocket = await dockerProxy.listen();
  const cliEnv = createSupabaseCliEnvironment(process.env, dockerSocket);
  const version = await runCliCapture(nodePath, [cliPath, '--version'], {
    cwd: root, env: cliEnv,
  });
  check(version.status === 0 && version.stdout.trim() === '2.120.0', 'supabase-cli-version');
  const statusResult = await runCliCapture(nodePath, [cliPath, 'status', '-o', 'json'], {
    cwd: root, env: cliEnv,
  });
  await dockerProxy.close();
  check(statusResult.status === 0, 'supabase-local-status');
  const status = JSON.parse(statusResult.stdout);
  check(status.API_URL === `http://127.0.0.1:${apiPort}` && status.ANON_KEY && status.SERVICE_ROLE_KEY, 'supabase-api-target');
  validateLocalDatabaseTarget(status, projectId, 54342);
  phase = 'database-connect';
  const { Client } = await import('pg');
  const db = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000, query_timeout: 12000, statement_timeout: 12000, application_name: 'jt-studio-task4-browser-proof' });
  await db.connect();
  const fixtureBaselineSql = 'select'
    + ' (select authorized_owner_id is null from blog_private.settings where singleton) as owner_null,'
    + ' (select count(*)::int from blog_private.admin_sessions) as sessions,'
    + ' (select count(*)::int from blog_private.admin_sessions where revoked_at is null) as unrevoked_sessions,'
    + ' (select count(*)::int from blog_private.admin_sessions where user_id=any($1::uuid[])) as fixture_sessions,'
    + ' (select count(*)::int from auth.users where id=any($1::uuid[])) as fixture_users';
  const { rows: [baseline] } = await db.query(fixtureBaselineSql, [[]]);
  check(baseline?.owner_null && baseline.unrevoked_sessions === 0, 'owner-session-fixture-baseline');

  const fixtureEmail = `task4-${randomUUID()}@example.com`;
  const fixturePassword = `Aa9!${randomUUID()}`;
  const otherEmail = `task4-other-${randomUUID()}@example.com`;
  const otherPassword = `Aa9!${randomUUID()}`;
  let ownerId;
  let otherUserId;
  let ownerSet = false;
  const temp = await mkdtemp(join(tmpdir(), 'jt-studio-task4-e2e-'));
  let boundary;
  let httpsServers = [];
  let netlifyProcess;
  const netlifyLogs = [];
  let browser;
  let browserLifecycle = [];
  let fixtureSessions = [];
  const fixturePostSlugs = [];
  const fixturePostIds = [];
  let maximumActiveSessionRequests = 0;
  let activeSessionRequests = 0;
  let holdNextSessionResponse = false;
  let holdNextGetResponse = false;
  let releaseHeldGetResponse;
  let getResponseSeen;
  let getResponseDelivered;
  let heldGetResponse;
  let releaseHeldSession;
  let sessionResponseSeen;
  let sessionResponseDelivered;
  let heldSessionResponse;
  let authUnavailable = false;
  let authLogoutUnavailable = false;
  let holdNextUserVerification = false;
  let userVerificationSeen;
  let notifyUserVerificationSeen;
  let userVerificationGate;
  let releaseUserVerification;
  let ambiguousRefreshResponse = false;
  let ambiguousAuthRotationConfirmed = false;
  let externalAuthCalls = [];
  let physicalRefreshRequests = 0;
  let appCookies = [];
  let holdNextRefresh = false;
  let notifyRefreshEntered;
  const refreshEntered = new Promise(resolveRefresh => { notifyRefreshEntered = resolveRefresh; });
  let releaseRefresh;
  let primaryFailure;
  const cleanupFailures = [];
  try {
    phase = 'fixture-create';
    const created = await jsonRequest(new URL('/auth/v1/admin/users', status.API_URL), { method: 'POST', headers: headers(status.SERVICE_ROLE_KEY), body: JSON.stringify({ email: fixtureEmail, password: fixturePassword, email_confirm: true }) });
    check([200, 201].includes(created.response.status) && typeof created.body?.id === 'string', 'fixture-auth-create');
    ownerId = created.body.id;
    const otherCreated = await jsonRequest(new URL('/auth/v1/admin/users', status.API_URL), { method: 'POST', headers: headers(status.SERVICE_ROLE_KEY), body: JSON.stringify({ email: otherEmail, password: otherPassword, email_confirm: true }) });
    check([200, 201].includes(otherCreated.response.status) && typeof otherCreated.body?.id === 'string' && otherCreated.body.id !== ownerId, 'fixture-other-auth-user-create');
    otherUserId = otherCreated.body.id;
    const ownerInstall = await db.query('update blog_private.settings set authorized_owner_id=$1 where singleton and authorized_owner_id is null', [ownerId]);
    check(ownerInstall.rowCount === 1, 'owner-install-conditional');
    ownerSet = true;

    const boundaryServer = createHttpServer(async (request, response) => {
      const path = new URL(request.url, `http://127.0.0.1:${apiBoundaryPort}`).pathname;
      if (path.startsWith('/auth/v1/')) {
        externalAuthCalls.push(path);
        if (path === '/auth/v1/user' && holdNextUserVerification) {
          holdNextUserVerification = false;
          notifyUserVerificationSeen?.();
          await userVerificationGate;
        }
        if (path === '/auth/v1/token' && new URL(request.url, `http://127.0.0.1:${apiBoundaryPort}`).search === '?grant_type=refresh_token') physicalRefreshRequests += 1;
        if (path === '/auth/v1/token' && new URL(request.url, `http://127.0.0.1:${apiBoundaryPort}`).search === '?grant_type=refresh_token' && holdNextRefresh) {
          holdNextRefresh = false;
          notifyRefreshEntered();
          await new Promise(resolveRefresh => { releaseRefresh = resolveRefresh; });
        }
        if (authUnavailable || (path === '/auth/v1/logout' && authLogoutUnavailable)) {
          request.resume();
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{"error":"temporarily_unavailable"}');
          return;
        }
      }
      const upstream = await fetch(new URL(request.url, status.API_URL), {
        method: request.method,
        headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
        duplex: ['GET', 'HEAD'].includes(request.method) ? undefined : 'half',
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      if (path === '/auth/v1/token' && new URL(request.url, `http://127.0.0.1:${apiBoundaryPort}`).search === '?grant_type=refresh_token' && ambiguousRefreshResponse) {
        ambiguousRefreshResponse = false;
        ambiguousAuthRotationConfirmed = upstream.status === 200;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"temporarily_unavailable"}');
        return;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(responseBytes);
    });
    await new Promise((resolveReady, reject) => { boundaryServer.once('error', reject); boundaryServer.listen(apiBoundaryPort, '127.0.0.1', resolveReady); });
    boundary = boundaryServer;

    const encryptionKey = randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
    const netlifyEnv = safeEnv(process.env, {
      HOME: '/tmp/jt-studio-task4-cli-home', XDG_CONFIG_HOME: '/tmp/jt-studio-task4-cli-home/.config', XDG_CACHE_HOME: '/tmp/jt-studio-task4-cli-home/.cache',
      SUPABASE_URL: `http://127.0.0.1:${apiBoundaryPort}`, SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, BLOG_ADMIN_USER_ID: ownerId,
      BLOG_SESSION_ENCRYPTION_KEY: encryptionKey, BLOG_PUBLIC_ORIGIN: browserOrigin,
    });
    const staticDir = join(temp, 'public');
    phase = 'netlify-start';
    await mkdir(staticDir, { mode: 0o700 });
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Local admin API proof</title>');
    netlifyProcess = spawn(netlify, ['dev', '--offline', '--no-open', '--port', String(appPort), '--functions-port', '8889', '--functions', 'netlify/functions', '--dir', staticDir], { cwd: root, env: netlifyEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [netlifyProcess.stdout, netlifyProcess.stderr]) stream.on('data', chunk => { if (netlifyLogs.join('').length < 32_768) netlifyLogs.push(chunk.toString('utf8')); });
    try {
      await waitFor(`http://127.0.0.1:${appPort}/api/admin/session`, 45_000);
    } catch {
      const startupOutput = netlifyLogs.join('');
      const startupClass = [
        ['address_in_use', /EADDRINUSE/u],
        ['permission_denied', /EACCES|EPERM/u],
        ['missing_module', /MODULE_NOT_FOUND|Cannot find package/u],
        ['unsupported_option', /unknown option|unknown argument/u],
        ['closed_process', /closed/u],
      ].find(([, pattern]) => pattern.test(startupOutput))?.[0] ?? 'unclassified';
      const failureLines = startupOutput.split(/\r?\n/u)
        .filter(line => /error|failed|cannot|exception|fatal|not found|invalid/iu.test(line))
        .slice(0, 4)
        .map(line => line.replace(/\bBearer\s+\S+/giu, 'Bearer <redacted>')
          .replace(/\b(?:token|key|password|secret|authorization|cookie)\b([:=\s]+)\S+/giu, '$1<redacted>')
          .replace(/https?:\/\/\S+/giu, '<url>')
          .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, '<redacted>')
          .slice(0, 240));
      throw new Error(`netlify-dev-readiness-${startupClass}-${netlifyProcess.exitCode === null ? 'running' : 'exited'}${failureLines.length ? `-${failureLines.join('|')}` : ''}`);
    }
    const authCallsBeforeUnknownAction = externalAuthCalls.length;
    const unknownAction = await jsonRequest(`http://127.0.0.1:${appPort}/api/admin/session`, {
      method: 'POST', headers: { origin: browserOrigin, 'content-type': 'application/json' }, body: '{"action":"unknown"}',
    });
    check(unknownAction.response.status === 400 && !unknownAction.response.headers.has('set-cookie') && externalAuthCalls.length === authCallsBeforeUnknownAction, 'closed-session-action-dispatch');

    phase = 'local-tls-edge';
    const cert = join(temp, 'localhost.pem');
    const key = join(temp, 'localhost-key.pem');
    const openssl = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    await new Promise((resolveExit, reject) => { openssl.once('error', reject); openssl.once('exit', code => code === 0 ? resolveExit() : reject(new Error('local-test-certificate'))); });
    const tls = { key: await readFile(key), cert: await readFile(cert) };
    const redirectProbe = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(302, { location: '/redirect-target', 'cache-control': 'no-store' });
      response.end('redirect-probe');
    });
    await new Promise((resolveReady, reject) => { redirectProbe.once('error', reject); redirectProbe.listen(0, '127.0.0.1', resolveReady); });
    httpsServers.push(redirectProbe);
    const redirectProbePort = redirectProbe.address().port;
    const makeEdge = () => createHttpsServer(tls, async (request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><meta charset="utf-8"><title>Local admin test</title><script type="module">import * as session from "/src/admin/session.js";import * as api from "/src/admin/api.js";window.blogSession={...session,...api};</script>');
        return;
      }
      if (request.url === '/src/admin/session.js' || request.url === '/src/admin/api.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': browserOrigin });
        response.end(await readFile(join(root, request.url.slice(1))));
        return;
      }
      const isSession = new URL(request.url, browserOrigin).pathname === '/api/admin/session';
      const holdThisResponse = isSession && request.method === 'POST' && holdNextSessionResponse;
      const holdThisGetResponse = isSession && request.method === 'GET' && holdNextGetResponse;
      if (isSession) {
        activeSessionRequests += 1;
        maximumActiveSessionRequests = Math.max(maximumActiveSessionRequests, activeSessionRequests);
        if (holdThisResponse) holdNextSessionResponse = false;
        if (holdThisGetResponse) holdNextGetResponse = false;
      }
      const upstreamHeaders = { ...request.headers };
      for (const name of ['host', 'connection', 'transfer-encoding', 'x-netlify-original-pathname', 'x-netlify-original-search', 'x-nf-function-name', 'x-nf-function-route']) delete upstreamHeaders[name];
      const isRedirectProbe = request.url === '/__task4_redirect_probe';
      const functionPort = isSession ? 8889 : isRedirectProbe ? redirectProbePort : appPort;
      const upstream = await fetch(`http://127.0.0.1:${functionPort}${request.url}`, {
        method: request.method, headers: upstreamHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
        duplex: ['GET', 'HEAD'].includes(request.method) ? undefined : 'half',
        signal: AbortSignal.timeout(20000),
        redirect: 'manual',
      });
      const setCookies = upstream.headers.getSetCookie?.() ?? [];
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      if (holdThisGetResponse) {
        let finished = false;
        response.once('finish', () => { finished = true; getResponseDelivered?.('finish'); });
        response.once('close', () => { if (!finished) getResponseDelivered?.('connection-closed'); });
        heldGetResponse = { status: upstream.status, hasSetCookie: setCookies.length > 0, hasLocation: upstream.headers.has('location') };
        getResponseSeen?.();
        if (releaseHeldGetResponse) await releaseHeldGetResponse;
      }
      if (holdThisResponse) {
        let finished = false;
        response.once('finish', () => { finished = true; sessionResponseDelivered?.('finish'); });
        response.once('close', () => { if (!finished) sessionResponseDelivered?.('connection-closed'); });
        let body = null;
        try { body = JSON.parse(responseBytes.toString('utf8')); } catch { body = null; }
        heldSessionResponse = { setCookie: setCookies[0] ?? null, body };
        sessionResponseSeen?.();
        if (releaseHeldSession) await releaseHeldSession;
      }
      if (isSession && upstream.headers.has('set-cookie')) appCookies.push(upstream.headers.get('set-cookie'));
      const responseHeaders = Object.fromEntries(upstream.headers);
      if (setCookies.length) responseHeaders['set-cookie'] = setCookies;
      response.writeHead(upstream.status, responseHeaders);
      response.end(responseBytes);
      if (isSession) activeSessionRequests -= 1;
    });
    const edgeServer = makeEdge();
    await new Promise((resolveReady, reject) => { edgeServer.once('error', reject); edgeServer.listen(8443, '127.0.0.1', resolveReady); });
    httpsServers.push(edgeServer);
    const redirectProbeResult = await httpsJsonRequest(`${browserOrigin}/__task4_redirect_probe`);
    check(redirectProbeResult.status === 302 && redirectProbeResult.headers.location === '/redirect-target' && redirectProbeResult.body === null, 'https-edge-preserves-upstream-redirect-without-following');

    phase = 'custom-function-routing-probe';
    const actionBody = '{"action":"unknown"}';
    const physicalHeaders = { origin: browserOrigin, 'content-type': 'application/json', accept: 'application/json' };
    const validOriginProbe = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, { method: 'POST', headers: physicalHeaders, body: actionBody });
    check(validOriginProbe.status === 400 && validOriginProbe.body?.error?.code === 'BLOG_INVALID_INPUT' && !validOriginProbe.headers.location && !validOriginProbe.headers['set-cookie'], `exact-path-functions-unknown-action-${validOriginProbe.status}`);
    const authCallsBeforeHostileLogin = externalAuthCalls.length;
    const hostileLoginProbe = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, {
      method: 'POST', headers: { ...physicalHeaders, origin: 'https://untrusted.example' },
      body: JSON.stringify({ action: 'login', email: fixtureEmail, password: fixturePassword }),
    });
    const hostileLoginSessions = await db.query('select count(*)::int as count from blog_private.admin_sessions where user_id=$1', [ownerId]);
    check(hostileLoginProbe.status === 403 && !hostileLoginProbe.headers.location && !hostileLoginProbe.headers['set-cookie'], `functions-hostile-login-${hostileLoginProbe.status}`);
    check(externalAuthCalls.length === authCallsBeforeHostileLogin && hostileLoginSessions.rows[0]?.count === 0, 'hostile-login-no-auth-call-or-app-session');
    const hostileOriginProbe = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, { method: 'POST', headers: { ...physicalHeaders, origin: 'https://untrusted.example' }, body: actionBody });
    check(hostileOriginProbe.status === 403 && hostileOriginProbe.body?.error?.code === 'BLOG_FORBIDDEN' && !hostileOriginProbe.headers.location && !hostileOriginProbe.headers['set-cookie'], `exact-path-functions-hostile-origin-${hostileOriginProbe.status}`);
    const cliFallbackProbe = await jsonRequest(`http://127.0.0.1:${appPort}/api/admin/session`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json', accept: 'application/json' }, body: actionBody });
    check(cliFallbackProbe.response.status === 404 && !cliFallbackProbe.response.headers.has('location'), `cli-fallback-contrast-${cliFallbackProbe.response.status}`);

    phase = 'browser-launch';
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    browser.on('disconnected', () => browserLifecycle.push('browser-disconnected'));
    context.on('close', () => browserLifecycle.push('context-closed'));
    context.on('page', observedPage => observedPage.on('close', () => browserLifecycle.push('page-closed')));
    const page = await context.newPage();
    phase = 'browser-anonymous';
    await page.goto(browserOrigin);
    await page.waitForFunction(() => Boolean(window.blogSession));
    let result = await page.evaluate(async () => {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' });
      return { status: response.status, setCookie: response.headers.has('set-cookie') };
    });
    check(result.status === 401 && !result.setCookie, `browser-anonymous-session-${result.status}`);

    const wrongOwnerLogin = await page.evaluate(async ({ email, password }) => {
      try { await window.blogSession.login({ email, password }); return { ok: true }; }
      catch (error) { return { ok: false, status: error.status }; }
    }, { email: otherEmail, password: otherPassword });
    check(!wrongOwnerLogin.ok && wrongOwnerLogin.status === 403, 'real-auth-other-user-owner-denied');
    check(!(await context.cookies(browserOrigin)).some(item => item.name === '__Host-jt_admin'), 'other-user-login-sets-no-app-cookie');
    check((await db.query('select count(*)::int as count from blog_private.admin_sessions where user_id=$1', [otherUserId])).rows[0]?.count === 0, 'other-user-login-creates-no-app-session');

    result = await page.evaluate(async ({ email, password }) => {
      try { await window.blogSession.login({ email, password }); return { ok: true }; }
      catch (error) { return { ok: false, status: error.status }; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(result.ok === true, 'browser-real-auth-login');
    await page.evaluate(() => { window.sessionChangeReasons = []; window.sessionChangeEvents = []; window.blogSession.subscribeSession(event => { window.sessionChangeReasons.push(event.reason); window.sessionChangeEvents.push(event); }); });
    phase = 'browser-cookie-and-authenticated-read';
    const cookies = await context.cookies(browserOrigin);
    let cookie = cookies.find(item => item.name === '__Host-jt_admin');
    check(cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax' && cookie.path === '/', 'browser-opaque-secure-cookie');
    check(!cookies.some(item => /access|refresh|token/i.test(item.name)), 'browser-token-cookie-absence');
    check((await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)) === 0, 'browser-token-storage-absence');

    let appSession = await db.query('select session_id from blog_private.admin_sessions where user_id=$1 and revoked_at is null order by created_at desc limit 1', [ownerId]);
    check(appSession.rowCount === 1, 'app-session-created');
    fixtureSessions.push(appSession.rows[0].session_id);
    phase = 'auth-verification-session-revalidation';
    let markUserVerificationSeen;
    userVerificationSeen = new Promise(resolveSeen => { markUserVerificationSeen = resolveSeen; });
    let releaseVerification;
    userVerificationGate = new Promise(resolveGate => { releaseVerification = resolveGate; });
    releaseUserVerification = releaseVerification;
    notifyUserVerificationSeen = markUserVerificationSeen;
    holdNextUserVerification = true;
    const pendingVerification = httpsJsonRequest(`${browserOrigin}/api/admin/session`, {
      method: 'GET', headers: { cookie: `${cookie.name}=${cookie.value}`, accept: 'application/json' },
    });
    await Promise.race([userVerificationSeen, new Promise((_, reject) => setTimeout(() => reject(new Error('held-auth-user-verification-not-reached')), 8000))]);
    const expiresWhileVerifying = await db.query("update blog_private.admin_sessions set expires_at=clock_timestamp()+interval '150 milliseconds' where session_id=$1 and revoked_at is null and expires_at>clock_timestamp() returning expires_at", [appSession.rows[0].session_id]);
    check(expiresWhileVerifying.rowCount === 1, 'verification-expiry-fixture-installed-after-auth-request-started');
    await waitForDatabaseExpiry(db, expiresWhileVerifying.rows[0].expires_at, 'auth-verification-expiry');
    releaseVerification();
    const verifiedAfterExpiry = await pendingVerification;
    check(verifiedAfterExpiry.status === 401 && !verifiedAfterExpiry.headers['set-cookie'] && !verifiedAfterExpiry.headers.location, 'function-rejects-session-expired-during-real-auth-verification');
    const expiredVerificationClientState = await page.evaluate(async () => ({ session: await window.blogSession.getSession(), state: window.blogSession.getSessionState() }));
    check(expiredVerificationClientState.session === null && expiredVerificationClientState.state === null, 'verification-expiry-clears-stale-client-session');
    check((await page.evaluate(() => window.sessionChangeReasons.at(-1))) === 'reauth-required', 'verification-expiry-reason-requires-reauth');
    const verificationRecovery = await page.evaluate(async ({ email, password }) => {
      try { await window.blogSession.login({ email, password }); return true; } catch { return false; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(verificationRecovery, 'login-after-verification-expiry');
    cookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    appSession = await db.query('select session_id from blog_private.admin_sessions where user_id=$1 and revoked_at is null and expires_at>clock_timestamp() order by created_at desc limit 1', [ownerId]);
    check(appSession.rowCount === 1 && appSession.rows[0].session_id !== fixtureSessions[0], 'replacement-app-session-after-verification-expiry');
    fixtureSessions.push(appSession.rows[0].session_id);
    notifyUserVerificationSeen = null;
    userVerificationSeen = null;
    releaseUserVerification = null;
    phase = 'browser-cookie-and-authenticated-read';
    let csrf = await page.evaluate(async () => {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    check(csrf.status === 200 && typeof csrf.body.csrfToken === 'string', 'browser-authenticated-function-read');
    await page.evaluate(() => {
      window.untrustedSessionChannel = new BroadcastChannel('jt-admin-session-v1');
      window.untrustedSessionChannel.postMessage({ type: 'session-changed', reason: 'unknown-reason' });
    });
    await page.waitForFunction(() => window.sessionChangeEvents.length > 0);
    const unknownSessionEvent = await page.evaluate(() => {
      const event = window.sessionChangeEvents.at(-1);
      return { reason: event.reason, keys: Object.keys(event).sort().join(',') };
    });
    check(unknownSessionEvent.reason === 'reauth-required' && unknownSessionEvent.keys === 'epoch,reason,type', 'closed-redacted-cross-tab-session-reason');
    await page.evaluate(() => window.untrustedSessionChannel.close());
    const restoredMemorySession = await page.evaluate(async () => window.blogSession.getSession());
    check(restoredMemorySession?.csrfToken === csrf.body.csrfToken, 'unknown-broadcast-reloads-existing-server-session');

    let csrfToken = csrf.body.csrfToken;
    let activeSessionId = appSession.rows[0].session_id;
    phase = 'app-cookie-expiry';
    const expireFixture = await db.query("update blog_private.admin_sessions set expires_at=clock_timestamp()-interval '1 second' where session_id=$1 and revoked_at is null returning revoked_at", [activeSessionId]);
    check(expireFixture.rowCount === 1 && expireFixture.rows[0].revoked_at === null, 'fixture-app-cookie-expired');
    const expiredCookieResponse = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, { method: 'GET', headers: { cookie: `${cookie.name}=${cookie.value}`, accept: 'application/json' } });
    check(expiredCookieResponse.status === 401 && !expiredCookieResponse.headers['set-cookie'] && !expiredCookieResponse.headers.location, 'expired-app-cookie-fails-closed-no-clear-cookie');
    const expiredClientSession = await page.evaluate(async () => window.blogSession.getSession());
    const expiredState = await page.evaluate(() => window.blogSession.getSessionState());
    check(expiredClientSession === null && expiredState === null, 'expired-client-session-requires-reauth');
    check((await page.evaluate(() => window.sessionChangeReasons.at(-1))) === 'reauth-required', 'expiry-reason-preserves-protected-data-contract');
    const expiredLogin = await page.evaluate(async ({ email, password }) => {
      try { await window.blogSession.login({ email, password }); return true; } catch { return false; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(expiredLogin, 'reauthenticate-after-app-cookie-expiry');
    cookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    csrf = await page.evaluate(async () => { const response = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' }); return { status: response.status, body: await response.json() }; });
    check(cookie?.value && csrf.status === 200 && csrf.body.csrfToken, 'fresh-session-after-cookie-expiry');
    csrfToken = csrf.body.csrfToken;
    const current = await db.query('select session_id from blog_private.admin_sessions where user_id=$1 and revoked_at is null and expires_at>clock_timestamp() order by created_at desc limit 1', [ownerId]);
    check(current.rowCount === 1, 'fresh-session-row-after-cookie-expiry');
    activeSessionId = current.rows[0].session_id;
    fixtureSessions.push(activeSessionId);
    phase = 'origin-rejection';
    const beforeAuthTransportCalls = externalAuthCalls.length;
    const rejected = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, {
      method: 'POST',
      headers: { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://untrusted.example', 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: '{"action":"logout"}',
    });
    if (rejected.status !== 403 || rejected.headers['set-cookie'] || rejected.headers.location) {
      process.stderr.write(`Origin probe: method=POST path=/api/admin/session status=${rejected.status} redirect=${Boolean(rejected.headers.location)} preflight=not-sent code=${rejected.body?.error?.code ?? 'none'}\n`);
      check(false, 'server-exact-origin-csrf');
    }
    check(rejected.status === 403, 'origin-probe-single-post-no-preflight');
    check(externalAuthCalls.length === beforeAuthTransportCalls, 'origin-rejection-does-not-contact-auth');
    const csrfRejections = [
      { name: 'wrong-csrf', headers: { cookie: `${cookie.name}=${cookie.value}`, origin: browserOrigin, 'content-type': 'application/json', 'x-csrf-token': `${csrfToken}x` } },
      { name: 'missing-csrf', headers: { cookie: `${cookie.name}=${cookie.value}`, origin: browserOrigin, 'content-type': 'application/json' } },
    ];
    for (const probe of csrfRejections) {
      const response = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, { method: 'POST', headers: probe.headers, body: '{"action":"logout"}' });
      check(response.status === 403 && !response.headers['set-cookie'] && !response.headers.location, `server-${probe.name}-rejected-${response.status}`);
    }
    check(externalAuthCalls.length === beforeAuthTransportCalls, 'csrf-rejection-does-not-contact-auth');
    const stillAuthenticated = await page.evaluate(async () => (await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' })).status);
    check(stillAuthenticated === 200, 'rejected-mutations-preserve-valid-session');
    phase = 'refresh-claim-and-logout';
    const secondPage = await context.newPage();
    await secondPage.goto(browserOrigin);
    await secondPage.waitForFunction(() => Boolean(window.blogSession));
    const secondTabSession = await secondPage.evaluate(async () => {
      const session = await window.blogSession.getSession();
      return session?.user?.id ?? null;
    });
    check(secondTabSession === csrf.body.user.id, 'reopened-tab-loads-session-and-initializes-coordination');
    const storedTokens = await db.query('select session_id, user_id, auth_session_id, generation, token_ciphertext from blog_private.admin_sessions where session_id=$1 and revoked_at is null', [activeSessionId]);
    check(storedTokens.rowCount === 1, 'refresh-fixture-session-present');
    const expiring = decryptTokens(storedTokens.rows[0].token_ciphertext, Buffer.from(encryptionKey, 'hex'));
    expiring.expires_at = Math.floor(Date.now() / 1000) + 30;
    await db.query('update blog_private.admin_sessions set token_ciphertext=$2, auth_expires_at=to_timestamp($3) where session_id=$1 and revoked_at is null', [activeSessionId, encryptTokens(expiring, Buffer.from(encryptionKey, 'hex')), expiring.expires_at]);

    const generationBeforeSuccessfulRefresh = Number(storedTokens.rows[0].generation);
    const successfulRefreshResponse = await httpsJsonRequest(`${browserOrigin}/api/admin/session`, {
      method: 'GET', headers: { cookie: `${cookie.name}=${cookie.value}`, accept: 'application/json' },
    });
    if (successfulRefreshResponse.status !== 200) {
      const failedRefreshState = await db.query('select session_id=$2 as same_session, user_id=$3 as same_owner, auth_session_id=$4 as same_auth_session, generation, generation=$5 as expected_generation, refresh_claim_id, revoked_at, expires_at>clock_timestamp() as app_active from blog_private.admin_sessions where session_id=$1', [activeSessionId, storedTokens.rows[0].session_id, storedTokens.rows[0].user_id, storedTokens.rows[0].auth_session_id, generationBeforeSuccessfulRefresh + 1]);
      const failedState = failedRefreshState.rows[0] ?? {};
      process.stderr.write(`Successful refresh probe: status=${successfulRefreshResponse.status} code=${successfulRefreshResponse.body?.error?.code ?? 'none'} authRefreshRequests=${physicalRefreshRequests} generation=${failedState.generation ?? 'missing'} expectedGeneration=${Boolean(failedState.expected_generation)} claim=${Boolean(failedState.refresh_claim_id)} revoked=${Boolean(failedState.revoked_at)} appActive=${Boolean(failedState.app_active)} sameSession=${Boolean(failedState.same_session)} sameOwner=${Boolean(failedState.same_owner)} sameAuthSession=${Boolean(failedState.same_auth_session)} ownerMatchesConfig=${Boolean(failedState.same_owner)}\n`);
    }
    check(successfulRefreshResponse.status === 200 && successfulRefreshResponse.body?.authenticated === true, 'successful-auth-refresh-remains-active-after-session-revalidation');
    const refreshedRow = await db.query('select generation, refresh_claim_id, token_ciphertext from blog_private.admin_sessions where session_id=$1 and revoked_at is null', [activeSessionId]);
    check(Number(refreshedRow.rows[0]?.generation) === generationBeforeSuccessfulRefresh + 1 && refreshedRow.rows[0]?.refresh_claim_id === null, 'successful-auth-refresh-commits-one-expected-generation');
    let refreshedTokens = decryptTokens(refreshedRow.rows[0].token_ciphertext, Buffer.from(encryptionKey, 'hex'));
    refreshedTokens.expires_at = Math.floor(Date.now() / 1000) + 30;
    await db.query('update blog_private.admin_sessions set token_ciphertext=$2, auth_expires_at=to_timestamp($3) where session_id=$1 and revoked_at is null', [activeSessionId, encryptTokens(refreshedTokens, Buffer.from(encryptionKey, 'hex')), refreshedTokens.expires_at]);

    const authCallsBeforeRefresh = externalAuthCalls.length;
    holdNextRefresh = true;
    const lateGet = page.evaluate(async () => window.blogSession.getSession());
    let refreshWaitTimer;
    try { await Promise.race([refreshEntered, new Promise((_, reject) => { refreshWaitTimer = setTimeout(() => reject(new Error('refresh-transport-not-reached')), 8000); })]); }
    finally { clearTimeout(refreshWaitTimer); }
    const claimed = await db.query('select generation, refresh_claim_id, revoked_at from blog_private.admin_sessions where session_id=$1', [activeSessionId]);
    check(claimed.rows[0]?.refresh_claim_id && !claimed.rows[0].revoked_at, 'real-database-refresh-claim-visible');
    check(externalAuthCalls.length === authCallsBeforeRefresh + 1 && externalAuthCalls.at(-1) === '/auth/v1/token', 'single-physical-refresh-request');
    const generationBeforeSecondRefresh = Number(claimed.rows[0].generation);
    const secondRefreshAttempt = await secondPage.evaluate(async () => {
      try { await window.blogSession.getSession(); return { status: 200 }; }
      catch (error) { return { status: error.status, code: error.code }; }
    });
    check(secondRefreshAttempt.status === 503 && secondRefreshAttempt.code === 'BLOG_SESSION_REFRESH_PENDING', 'concurrent-second-refresh-fails-closed');
    check(physicalRefreshRequests === 2, 'concurrent-refresh-sends-one-physical-auth-post-for-one-active-claim');
    const stillClaimed = await db.query('select generation, refresh_claim_id from blog_private.admin_sessions where session_id=$1 and revoked_at is null', [activeSessionId]);
    check(Number(stillClaimed.rows[0]?.generation) === generationBeforeSecondRefresh && stillClaimed.rows[0]?.refresh_claim_id === claimed.rows[0].refresh_claim_id, 'concurrent-refresh-keeps-one-generation-and-claim');

    const authCallsBeforeLogout = externalAuthCalls.length;
    authLogoutUnavailable = true;
    const logoutResponse = await secondPage.evaluate(async () => {
      try { await window.blogSession.logout(); return { ok: true }; }
      catch (error) { return { ok: false, status: error.status }; }
    });
    check(logoutResponse.ok, `logout-during-refresh-survives-auth-outage-${logoutResponse.status ?? 'failed'}`);
    check(externalAuthCalls.length === authCallsBeforeLogout + 1 && externalAuthCalls.at(-1) === '/auth/v1/logout', 'logout-does-not-call-user-or-refresh-auth');
    check((await page.evaluate(() => window.sessionChangeReasons.at(-1))) === 'logout', 'explicit-logout-reason-reaches-other-tab');
    let afterLogout = await db.query('select generation, refresh_claim_id, revoked_at from blog_private.admin_sessions where session_id=$1', [activeSessionId]);
    check(afterLogout.rows[0]?.revoked_at && afterLogout.rows[0]?.refresh_claim_id === null, 'logout-revokes-and-clears-refresh-claim');
    check(Number(afterLogout.rows[0].generation) === Number(claimed.rows[0].generation), 'logout-keeps-generation-stable');
    check(!(await context.cookies(browserOrigin)).some(item => item.name === '__Host-jt_admin'), 'browser-logout-cookie-cleared');
    check(await page.evaluate(() => window.blogSession.getSessionState()) === null, 'logout-clears-reopened-tab-memory-state');
    check(appCookies.at(-1)?.includes('Max-Age=0'), 'logout-cookie-expired');
    const cookiesBeforeLateResponse = appCookies.length;

    check(typeof releaseRefresh === 'function', 'refresh-transport-release-ready');
    releaseRefresh();
    const lateSession = await lateGet;
    check(lateSession === null, 'late-session-response-does-not-restore-browser-state');
    afterLogout = await db.query('select generation, refresh_claim_id, revoked_at from blog_private.admin_sessions where session_id=$1', [activeSessionId]);
    check(afterLogout.rows[0]?.revoked_at && afterLogout.rows[0]?.refresh_claim_id === null && Number(afterLogout.rows[0].generation) === Number(claimed.rows[0].generation), 'late-refresh-cannot-revive-revoked-session');
    check(appCookies.length === cookiesBeforeLateResponse, 'late-refresh-sets-no-cookie');
    check(physicalRefreshRequests === 2, 'two-refreshes-used-one-physical-auth-post-per-generation');
    check(!appCookies.some(value => /access_token|refresh_token/i.test(value)), 'http-cookie-no-auth-token');

    phase = 'tab-close-physical-login-race';
    const closingTab = page;
    check(!closingTab.isClosed() && browser.isConnected(), 'tab-close-race-browser-precondition');
    let markResponseSeen;
    let markResponseDelivered;
    const responseSeen = new Promise(resolveSeen => { markResponseSeen = resolveSeen; });
    const responseDelivered = new Promise(resolveDelivered => { markResponseDelivered = resolveDelivered; });
    let releaseResponse;
    const responseGate = new Promise(resolveGate => { releaseResponse = resolveGate; });
    sessionResponseSeen = markResponseSeen;
    sessionResponseDelivered = markResponseDelivered;
    releaseHeldSession = responseGate;
    holdNextSessionResponse = true;
    let loginOperation;
    try {
      loginOperation = closingTab.evaluate(async ({ email, password }) => {
        try { await window.blogSession.login({ email, password }); return 'resolved'; }
        catch { return 'rejected'; }
      }, { email: fixtureEmail, password: fixturePassword });
    } catch (error) {
      loginOperation = Promise.reject(error);
    }
    const pendingLogin = Promise.resolve(loginOperation).then(
      result => ({ outcome: result }),
      error => ({ outcome: 'target-closed', errorName: error?.name ?? 'unknown' }),
    );
    await Promise.race([responseSeen, pendingLogin.then(outcome => { if (outcome.outcome === 'target-closed') throw new Error(`login-tab-closed-before-transport-${browserLifecycle.join('-') || 'unobserved'}`); }), new Promise((_, reject) => setTimeout(() => reject(new Error('login-response-hold-timeout')), 8000))]);
    check(heldSessionResponse?.setCookie && heldSessionResponse.body?.csrfToken, 'held-login-response-ready');
    const oldLoginResponse = heldSessionResponse;
    const oldCookieValue = oldLoginResponse.setCookie.split(';', 1)[0].slice('__Host-jt_admin='.length);
    const oldCookieDigest = createHash('sha256').update(oldCookieValue).digest('hex');
    const oldDbSession = await db.query("select session_id, token_ciphertext from blog_private.admin_sessions where cookie_digest=decode($1,'hex')", [oldCookieDigest]);
    check(oldDbSession.rowCount === 1, 'old-login-db-session-captured');
    const oldAccessToken = decryptTokens(oldDbSession.rows[0].token_ciphertext, Buffer.from(encryptionKey, 'hex')).access_token;
    const oldAppSessionId = oldDbSession.rows[0].session_id;
    await closingTab.close();
    const succeedingTab = await context.newPage();
    await succeedingTab.goto(browserOrigin);
    await succeedingTab.waitForFunction(() => Boolean(window.blogSession));
    const succeedingSession = await succeedingTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(succeedingSession?.csrfToken, 'new-tab-login-after-held-physical-response');
    const succeedingCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(succeedingCookie?.value, 'new-login-cookie-before-old-response');
    const succeedingDigest = createHash('sha256').update(succeedingCookie.value).digest('hex');
    const succeedingDbSession = await db.query("select session_id, token_ciphertext from blog_private.admin_sessions where cookie_digest=decode($1,'hex') and revoked_at is null", [succeedingDigest]);
    check(succeedingDbSession.rowCount === 1, 'new-login-db-session-captured');
    const succeedingAccessToken = decryptTokens(succeedingDbSession.rows[0].token_ciphertext, Buffer.from(encryptionKey, 'hex')).access_token;
    const succeedingAppSessionId = succeedingDbSession.rows[0].session_id;
    releaseResponse();
    const closedTabOutcome = await pendingLogin;
    check(['target-closed', 'rejected', 'resolved'].includes(closedTabOutcome.outcome), 'closed-tab-transport-outcome-observed');
    const deliveredLogin = await Promise.race([responseDelivered, new Promise((_, reject) => setTimeout(() => reject(new Error('held-login-response-completion-timeout')), 8000))]);
    check(['finish', 'connection-closed'].includes(deliveredLogin), 'held-login-response-physical-completion-observed');
    releaseHeldSession = null;
    sessionResponseSeen = null;
    sessionResponseDelivered = null;
    let finalCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(finalCookie?.value === succeedingCookie.value, 'late-old-login-cookie-does-not-replace-new-cookie');
    let restoredSession = await succeedingTab.evaluate(async () => window.blogSession.getSession());
    check(restoredSession?.csrfToken === succeedingSession.csrfToken, 'late-old-login-response-retains-new-server-session');

    phase = 'tab-close-late-logout-cookie-race';
    await context.addCookies([{ name: '__Host-jt_admin', value: oldCookieValue, url: browserOrigin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const logoutTab = await context.newPage();
    await logoutTab.goto(browserOrigin);
    await logoutTab.waitForFunction(() => Boolean(window.blogSession));
    const oldLogoutSession = await logoutTab.evaluate(async () => window.blogSession.getSession());
    check(oldLogoutSession?.csrfToken === oldLoginResponse.body.csrfToken, 'old-login-session-reloaded-before-logout');
    let markLogoutResponseSeen;
    let markLogoutResponseDelivered;
    const logoutResponseSeen = new Promise(resolveSeen => { markLogoutResponseSeen = resolveSeen; });
    const logoutResponseDelivered = new Promise(resolveDelivered => { markLogoutResponseDelivered = resolveDelivered; });
    let releaseLogoutResponse;
    const logoutResponseGate = new Promise(resolveGate => { releaseLogoutResponse = resolveGate; });
    sessionResponseSeen = markLogoutResponseSeen;
    sessionResponseDelivered = markLogoutResponseDelivered;
    releaseHeldSession = logoutResponseGate;
    holdNextSessionResponse = true;
    const pendingLogout = logoutTab.evaluate(async () => {
      try { await window.blogSession.logout(); return 'resolved'; }
      catch { return 'rejected'; }
    }).then(result => ({ outcome: result }), error => ({ outcome: 'target-closed', errorName: error?.name ?? 'unknown' }));
    await Promise.race([logoutResponseSeen, new Promise((_, reject) => setTimeout(() => reject(new Error('logout-response-hold-timeout')), 8000))]);
    const oldDigest = createHash('sha256').update(oldCookieValue).digest('hex');
    const oldLogoutState = await db.query("select revoked_at is not null as revoked from blog_private.admin_sessions where cookie_digest=decode($1,'hex')", [oldDigest]);
    check(oldLogoutState.rows[0]?.revoked, 'old-app-session-revoked-before-cookie-response');
    const successorSession = await db.query('select revoked_at from blog_private.admin_sessions where session_id=$1', [succeedingAppSessionId]);
    check(successorSession.rowCount === 1 && successorSession.rows[0].revoked_at === null, 'successor-app-session-remains-active');
    const staleTokenSlug = `task4-stale-auth-session-${randomUUID()}`;
    const validTokenSlug = `task4-current-auth-session-${randomUUID()}`;
    const revokedTupleSlug = `task4-revoked-auth-session-${randomUUID()}`;
    fixturePostSlugs.push(staleTokenSlug, validTokenSlug, revokedTupleSlug);
    const validTokenRpc = await directSavePost(status.API_URL, status.ANON_KEY, succeedingAccessToken, succeedingAppSessionId, validTokenSlug);
    if (typeof validTokenRpc.body?.id === 'string') fixturePostIds.push(validTokenRpc.body.id);
    const staleTokenRpc = await directSavePost(status.API_URL, status.ANON_KEY, oldAccessToken, succeedingAppSessionId, staleTokenSlug);
    if (typeof staleTokenRpc.body?.id === 'string') fixturePostIds.push(staleTokenRpc.body.id);
    const revokedTupleRpc = await directSavePost(status.API_URL, status.ANON_KEY, oldAccessToken, oldAppSessionId, revokedTupleSlug);
    if (typeof revokedTupleRpc.body?.id === 'string') fixturePostIds.push(revokedTupleRpc.body.id);
    check(validTokenRpc.status === 200, `current-auth-session-uses-own-app-session-${validTokenRpc.status}`);
    check(revokedTupleRpc.status === 403, `revoked-auth-session-cannot-use-own-revoked-app-session-${revokedTupleRpc.status}`);
    check(staleTokenRpc.status === 403, `revoked-auth-session-cannot-borrow-successor-app-session-${staleTokenRpc.status}`);
    await logoutTab.close();
    const replacementTab = await context.newPage();
    await replacementTab.goto(browserOrigin);
    await replacementTab.waitForFunction(() => Boolean(window.blogSession));
    const replacementSession = await replacementTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(replacementSession?.csrfToken, 'new-login-after-held-logout-response');
    const replacementCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(replacementCookie?.value, 'replacement-cookie-before-old-logout-response');
    releaseLogoutResponse();
    const oldLogoutOutcome = await pendingLogout;
    check(['target-closed', 'rejected', 'resolved'].includes(oldLogoutOutcome.outcome), 'closed-logout-tab-transport-outcome-observed');
    const deliveredLogout = await Promise.race([logoutResponseDelivered, new Promise((_, reject) => setTimeout(() => reject(new Error('held-logout-response-completion-timeout')), 8000))]);
    check(['finish', 'connection-closed'].includes(deliveredLogout), 'held-logout-response-physical-completion-observed');
    releaseHeldSession = null;
    sessionResponseSeen = null;
    sessionResponseDelivered = null;
    finalCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(finalCookie?.value === replacementCookie.value, 'late-old-logout-clear-cookie-does-not-delete-new-cookie');
    restoredSession = await replacementTab.evaluate(async () => window.blogSession.getSession());
    check(restoredSession?.csrfToken === replacementSession.csrfToken, 'late-old-logout-retains-new-server-session');

    phase = 'abandoned-refresh-claim';
    const replacementDigest = createHash('sha256').update(replacementCookie.value).digest('hex');
    const replacementDbSession = await db.query('select session_id,generation,auth_expires_at,token_ciphertext from blog_private.admin_sessions where cookie_digest=decode($1,\'hex\') and revoked_at is null', [replacementDigest]);
    check(replacementDbSession.rowCount === 1, 'abandoned-claim-fixture-session-present');
    const abandonedClaimId = randomUUID();
    const physicalBeforeAbandonedClaim = physicalRefreshRequests;
    const setAbandoned = await db.query("update blog_private.admin_sessions set refresh_claim_id=$2,refresh_claimed_at=clock_timestamp()-interval '46 seconds' where session_id=$1 and revoked_at is null and refresh_claim_id is null", [replacementDbSession.rows[0].session_id, abandonedClaimId]);
    check(setAbandoned.rowCount === 1, 'abandoned-claim-old-cas-fixture-installed');
    const sessionStore = createServerClient(readBlogConfig(netlifyEnv));
    const abandonedRequest = await httpsJsonRequest(new URL('/api/admin/session', browserOrigin), { headers: { cookie: `__Host-jt_admin=${replacementCookie.value}` } });
    check(abandonedRequest.status === 401 && !abandonedRequest.headers['set-cookie'] && !abandonedRequest.headers.location, 'abandoned-claim-requires-reauth-without-cookie-or-redirect');
    check(physicalRefreshRequests === physicalBeforeAbandonedClaim, 'abandoned-claim-does-not-retry-auth-refresh');
    let abandonedState = await db.query('select generation,refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [replacementDbSession.rows[0].session_id]);
    check(String(abandonedState.rows[0]?.generation) === String(replacementDbSession.rows[0].generation) && abandonedState.rows[0]?.refresh_claim_id === null && abandonedState.rows[0]?.revoked_at, 'abandoned-claim-cas-revokes-without-generation-change');
    const lateRefreshCompletion = await sessionStore.rpc('blog_admin_session_refresh_complete', {
      p_session_id: replacementDbSession.rows[0].session_id,
      p_generation: replacementDbSession.rows[0].generation,
      p_claim_id: abandonedClaimId,
      p_auth_expires_at: replacementDbSession.rows[0].auth_expires_at,
      p_token_ciphertext: replacementDbSession.rows[0].token_ciphertext,
    });
    check(!lateRefreshCompletion.error && lateRefreshCompletion.data === null, 'late-abandoned-refresh-completion-cannot-revive-session');
    check(physicalRefreshRequests === physicalBeforeAbandonedClaim, 'late-abandoned-completion-causes-no-auth-retry');

    const recoveryLogin = await replacementTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(recoveryLogin?.csrfToken, 'reauth-after-abandoned-refresh-claim');
    const recoveryCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(recoveryCookie?.value, 'reauth-cookie-after-abandoned-refresh-claim');
    const recoveryDigest = createHash('sha256').update(recoveryCookie.value).digest('hex');
    const recoveryDbSession = await db.query('select session_id,generation from blog_private.admin_sessions where cookie_digest=decode($1,\'hex\') and revoked_at is null', [recoveryDigest]);
    check(recoveryDbSession.rowCount === 1, 'recent-claim-fixture-session-present');
    const recentClaimId = randomUUID();
    const physicalBeforeRecentClaim = physicalRefreshRequests;
    const setRecent = await db.query('update blog_private.admin_sessions set refresh_claim_id=$2,refresh_claimed_at=clock_timestamp() where session_id=$1 and revoked_at is null and refresh_claim_id is null', [recoveryDbSession.rows[0].session_id, recentClaimId]);
    check(setRecent.rowCount === 1, 'recent-claim-cas-fixture-installed');
    const recentRequest = await httpsJsonRequest(new URL('/api/admin/session', browserOrigin), { headers: { cookie: `__Host-jt_admin=${recoveryCookie.value}` } });
    check(recentRequest.status === 503 && !recentRequest.headers['set-cookie'] && !recentRequest.headers.location, 'recent-claim-stays-pending-without-cookie-or-redirect');
    const stillPending = await db.query('select generation,refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [recoveryDbSession.rows[0].session_id]);
    check(String(stillPending.rows[0]?.generation) === String(recoveryDbSession.rows[0].generation) && stillPending.rows[0]?.refresh_claim_id === recentClaimId && stillPending.rows[0]?.revoked_at === null, 'recent-claim-is-not-revoked-early');
    const authCallsBeforePendingLogout = externalAuthCalls.length;
    const recentClaimLogoutResult = await replacementTab.evaluate(async () => {
      try { await window.blogSession.logout(); return { ok: true }; }
      catch (error) { return { ok: false, status: error.status }; }
    });
    check(recentClaimLogoutResult.ok, 'recent-claim-session-can-logout');
    check(externalAuthCalls.length === authCallsBeforePendingLogout + 1 && externalAuthCalls.at(-1) === '/auth/v1/logout', 'recent-claim-logout-skips-user-and-refresh-auth');
    const afterPendingLogout = await db.query('select refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [recoveryDbSession.rows[0].session_id]);
    check(afterPendingLogout.rows[0]?.refresh_claim_id === null && afterPendingLogout.rows[0]?.revoked_at, 'recent-claim-logout-revokes-before-auth-cleanup');
    check(physicalRefreshRequests === physicalBeforeRecentClaim, 'recent-pending-claim-does-not-send-auth-refresh');

    const ambiguousLogin = await replacementTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(ambiguousLogin?.csrfToken, 'login-before-ambiguous-refresh');
    const ambiguousCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    const ambiguousDigest = createHash('sha256').update(ambiguousCookie.value).digest('hex');
    const ambiguousSessionRow = await db.query('select session_id,generation,token_ciphertext from blog_private.admin_sessions where cookie_digest=decode($1,\'hex\') and revoked_at is null', [ambiguousDigest]);
    check(ambiguousSessionRow.rowCount === 1, 'ambiguous-refresh-fixture-present');
    const nearExpiryTokens = decryptTokens(ambiguousSessionRow.rows[0].token_ciphertext, Buffer.from(encryptionKey, 'hex'));
    nearExpiryTokens.expires_at = Math.floor(Date.now() / 1000) + 30;
    await db.query('update blog_private.admin_sessions set token_ciphertext=$2,auth_expires_at=to_timestamp($3) where session_id=$1 and revoked_at is null', [ambiguousSessionRow.rows[0].session_id, encryptTokens(nearExpiryTokens, Buffer.from(encryptionKey, 'hex')), nearExpiryTokens.expires_at]);
    await replacementTab.evaluate(() => {
      window.task4Draft = 'unsaved text remains available after reauthentication is required';
      window.sessionChangeReasons = [];
      window.blogSession.subscribeSession(event => window.sessionChangeReasons.push(event.reason));
    });
    const physicalBeforeAmbiguous = physicalRefreshRequests;
    ambiguousRefreshResponse = true;
    const ambiguousClientResult = await replacementTab.evaluate(async () => {
      try { return { session: await window.blogSession.getSession(), error: null }; }
      catch (error) { return { session: null, error: { status: error.status, code: error.code } }; }
    });
    check(ambiguousAuthRotationConfirmed, 'auth-actually-rotated-before-response-became-ambiguous');
    check(physicalRefreshRequests === physicalBeforeAmbiguous + 1, 'ambiguous-refresh-one-physical-auth-post');
    check(ambiguousClientResult.session === null, 'ambiguous-refresh-requires-reauth');
    check((await replacementTab.evaluate(() => window.sessionChangeReasons.at(-1))) === 'reauth-required', 'ambiguous-refresh-emits-reauth-required-not-logout');
    check((await replacementTab.evaluate(() => window.task4Draft)) === 'unsaved text remains available after reauthentication is required', 'ambiguous-refresh-preserves-unsaved-draft');
    const ambiguousState = await db.query('select generation,refresh_claim_id,revoked_at from blog_private.admin_sessions where session_id=$1', [ambiguousSessionRow.rows[0].session_id]);
    check(ambiguousState.rows[0]?.revoked_at && ambiguousState.rows[0]?.refresh_claim_id === null && String(ambiguousState.rows[0]?.generation) === String(ambiguousSessionRow.rows[0].generation), 'ambiguous-refresh-revokes-without-reuse-or-generation');
    const repeatedAmbiguousCookieRead = await httpsJsonRequest(new URL('/api/admin/session', browserOrigin), { headers: { cookie: `__Host-jt_admin=${ambiguousCookie.value}` } });
    check(repeatedAmbiguousCookieRead.status === 401 && !repeatedAmbiguousCookieRead.headers['set-cookie'] && !repeatedAmbiguousCookieRead.headers.location, 'ambiguous-refresh-no-cookie-clear-or-redirect');
    check(physicalRefreshRequests === physicalBeforeAmbiguous + 1, 'ambiguous-refresh-is-not-retried-on-following-read');

    const late401Login = await replacementTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(late401Login?.csrfToken, 'new-login-before-late-401');
    const late401Cookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    const late401Digest = createHash('sha256').update(late401Cookie.value).digest('hex');
    const late401OldRow = await db.query('select session_id from blog_private.admin_sessions where cookie_digest=decode($1,\'hex\') and revoked_at is null', [late401Digest]);
    check(late401OldRow.rowCount === 1, 'late-401-old-app-session-present');
    const expiredOldSession = await db.query('update blog_private.admin_sessions set revoked_at=clock_timestamp() where session_id=$1 and revoked_at is null', [late401OldRow.rows[0].session_id]);
    check(expiredOldSession.rowCount === 1, 'late-401-old-app-session-revoked');
    let releaseLateGet;
    const lateGetGate = new Promise(resolveGate => { releaseLateGet = resolveGate; });
    const lateGetSeen = new Promise(resolveSeen => { getResponseSeen = resolveSeen; });
    const lateGetDelivered = new Promise(resolveDelivered => { getResponseDelivered = resolveDelivered; });
    releaseHeldGetResponse = lateGetGate;
    heldGetResponse = null;
    holdNextGetResponse = true;
    const pendingLateGet = replacementTab.evaluate(async () => window.blogSession.getSession());
    await Promise.race([lateGetSeen, new Promise((_, reject) => setTimeout(() => reject(new Error('late-401-physical-response-not-held')), 8000))]);
    check(heldGetResponse?.status === 401 && !heldGetResponse.hasSetCookie && !heldGetResponse.hasLocation, 'late-401-real-function-response-ready-without-cookie-or-redirect');
    const late401SuccessorTab = await context.newPage();
    await late401SuccessorTab.goto(browserOrigin);
    await late401SuccessorTab.waitForFunction(() => Boolean(window.blogSession));
    const late401SuccessorLogin = await late401SuccessorTab.evaluate(async ({ email, password }) => {
      try { return await window.blogSession.login({ email, password }); }
      catch { return null; }
    }, { email: fixtureEmail, password: fixturePassword });
    check(late401SuccessorLogin?.csrfToken, 'successor-login-before-late-401-delivery');
    const late401SuccessorCookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(late401SuccessorCookie?.value && late401SuccessorCookie.value !== late401Cookie.value, 'successor-cookie-installed-before-late-401');
    releaseLateGet();
    const late401OldResult = await pendingLateGet;
    check(late401OldResult === null, 'late-401-from-old-session-is-ignored-after-new-login');
    const deliveredLate401 = await Promise.race([lateGetDelivered, new Promise((_, reject) => setTimeout(() => reject(new Error('late-401-physical-completion-timeout')), 8000))]);
    check(['finish', 'connection-closed'].includes(deliveredLate401), 'late-401-physical-response-completion-observed');
    releaseHeldGetResponse = null;
    getResponseSeen = null;
    getResponseDelivered = null;
    const finalLate401Cookie = (await context.cookies(browserOrigin)).find(item => item.name === '__Host-jt_admin');
    check(finalLate401Cookie?.value === late401SuccessorCookie.value, 'late-401-cannot-clear-successor-cookie');
    const successorRead = await late401SuccessorTab.evaluate(async () => window.blogSession.getSession());
    check(successorRead?.csrfToken === late401SuccessorLogin.csrfToken, 'late-401-cannot-clear-successor-session-state');
    await context.close();
  } catch (error) {
    primaryFailure = error;
  } finally {
    authUnavailable = true;
    releaseRefresh?.();
    releaseUserVerification?.();
    if (browser) await browser.close().catch(() => cleanupFailures.push('browser-close'));
    if (netlifyProcess && netlifyProcess.exitCode === null) {
      netlifyProcess.kill('SIGTERM');
      try { await new Promise(resolveExit => netlifyProcess.once('exit', resolveExit)); } catch { cleanupFailures.push('netlify-stop'); }
    }
    for (const server of httpsServers) await new Promise(resolveClose => server.close(resolveClose)).catch(() => cleanupFailures.push('edge-close'));
    if (boundary) await new Promise(resolveClose => boundary.close(resolveClose)).catch(() => cleanupFailures.push('auth-boundary-close'));
    if (fixturePostIds.length) {
      try { await db.query('delete from public.blog_posts where id=any($1::uuid[]) and owner_id=$2', [fixturePostIds, ownerId]); } catch { cleanupFailures.push('fixture-post-delete'); }
      try { const posts = await db.query('select count(*)::int as count from public.blog_posts where id=any($1::uuid[])', [fixturePostIds]); if (posts.rows[0]?.count !== 0) cleanupFailures.push('fixture-post-verify'); } catch { cleanupFailures.push('fixture-post-verify'); }
    }
    if (fixturePostSlugs.length) {
      try { const posts = await db.query('select count(*)::int as count from public.blog_posts where slug=any($1::text[])', [fixturePostSlugs]); if (posts.rows[0]?.count !== 0) cleanupFailures.push('fixture-post-slug-verify'); } catch { cleanupFailures.push('fixture-post-slug-verify'); }
    }
    if (ownerId) {
      try { await db.query('delete from blog_private.admin_sessions where user_id=any($1::uuid[])', [[ownerId, ...(otherUserId ? [otherUserId] : [])]]); } catch { cleanupFailures.push('fixture-session-delete'); }
      if (ownerSet) {
        try {
          const restored = await db.query('update blog_private.settings set authorized_owner_id=null where singleton and authorized_owner_id=$1', [ownerId]);
          if (restored.rowCount !== 1) cleanupFailures.push('owner-setting-restore');
        } catch { cleanupFailures.push('owner-setting-restore'); }
      }
      for (const fixtureUserId of [ownerId, otherUserId].filter(Boolean)) {
        try {
          const removed = await jsonRequest(new URL(`/auth/v1/admin/users/${fixtureUserId}`, status.API_URL), { method: 'DELETE', headers: headers(status.SERVICE_ROLE_KEY) });
          if (![200, 202, 204].includes(removed.response.status)) cleanupFailures.push('fixture-auth-user-delete');
        } catch { cleanupFailures.push('fixture-auth-user-delete'); }
      }
    }
    try {
      const fixtureUserIds = [ownerId, otherUserId].filter(Boolean);
      const { rows: [final] } = await db.query(fixtureBaselineSql, [fixtureUserIds]);
      if (!final?.owner_null || final.sessions !== baseline.sessions || final.unrevoked_sessions !== 0
        || final.fixture_sessions !== 0 || final.fixture_users !== 0) cleanupFailures.push('fixture-baseline-verify');
    } catch { cleanupFailures.push('fixture-baseline-verify'); }
    await db.end().catch(() => cleanupFailures.push('database-close'));
    await rm(temp, { recursive: true, force: true }).catch(() => cleanupFailures.push('temp-cleanup'));
    if (authUnavailable) process.stdout.write('Task-local Auth transport control was disabled before fixture cleanup.\n');
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length) {
    const error = new Error('Task 4 fixture cleanup failed');
    error.stage = cleanupFailures[0];
    throw error;
  }
  process.stdout.write('PASS browser local Auth sign-in and real Netlify Functions; opaque Secure HttpOnly host-only cookie; no token storage; exact Origin/CSRF rejection; tab-close/second-tab physical login race; real DB refresh claim logout; late refresh cannot revive; one physical Auth refresh request; exact fixture cleanup verified.\n');
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.status < 500) return; } catch { /* readiness probe retries until the bounded deadline */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  throw new Error('netlify-dev-readiness');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) runSessionProof().catch(error => {
  const failure = error?.stage?.match(/^[A-Za-z0-9_:/-]{1,160}$/)?.[0] ?? (error?.name === 'TypeError' ? 'type_error' : error?.name === 'TimeoutError' ? 'timeout_error' : 'unclassified');
  const safeFailure = failure.toLowerCase();
  process.stderr.write(`Task 4 browser gate stopped at ${safeFailure} during ${phase}; credentials and response bodies were not retained.\n`);
  process.exitCode = 1;
});
