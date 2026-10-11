import { createServer, request as requestHttp } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const MAX_CREATE_BODY_BYTES = 16 * 1024 * 1024;
const CREATE_PATH = /^(?:\/v[0-9]+\.[0-9]+)?\/containers\/create\/?$/;
const UPGRADE_PATH = /^(?:\/v[0-9]+\.[0-9]+)?\/(?:exec\/[a-zA-Z0-9_.-]+\/start|containers\/[a-zA-Z0-9_.-]+\/attach)\/?$/;
const CONTAINER_START_PATH = /^(?:\/v[0-9]+\.[0-9]+)?\/containers\/([0-9a-f]{64})\/start\/?$/;

function sendError(res, status, message) {
  const bytes = Buffer.from(JSON.stringify({ message }));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_CREATE_BODY_BYTES) throw new RangeError('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rewriteBindings(body) {
  let document;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    throw new TypeError('Invalid container create JSON');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Invalid container create JSON');
  }
  const bindings = document.HostConfig?.PortBindings;
  if (bindings !== undefined) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
      throw new TypeError('Invalid port bindings');
    }
    for (const entries of Object.values(bindings)) {
      if (!Array.isArray(entries)) throw new TypeError('Invalid port binding entries');
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new TypeError('Invalid port binding entry');
        }
        entry.HostIp = '127.0.0.1';
      }
    }
  }
  return Buffer.from(JSON.stringify(document));
}

function isContainerCreate(pathname) {
  return CREATE_PATH.test(pathname);
}

function isForbiddenMutation(method, pathname) {
  if (method === 'POST' && /^(?:\/v[0-9]+\.[0-9]+)?\/(?:containers|images|volumes|networks)\/prune\/?$/.test(pathname)) return true;
  if (method === 'DELETE' && /^(?:\/v[0-9]+\.[0-9]+)?\/(?:volumes|networks)\/[^/]+\/?$/.test(pathname)) return true;
  return false;
}

function enforceCreateBoundary(body) {
  let document;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    throw new TypeError('Invalid container create JSON');
  }
  const hostConfig = document?.HostConfig;
  if (hostConfig && (hostConfig.NetworkMode === 'host' || hostConfig.PublishAllPorts === true)) {
    throw new Error('Forbidden Docker host exposure mode');
  }
}

export function createDockerLoopbackProxy({
  upstreamSocketPath,
  allowedNames,
  verifiedContainerIds = new Set(),
  verifiedContainerNameIds = new Map(),
  resumableContainerIds = new Set(),
  onUpgradeEvent = () => {},
  onDeleteEvent = () => {},
}) {
  if (typeof upstreamSocketPath !== 'string' || !upstreamSocketPath.startsWith('/')) {
    throw new TypeError('upstreamSocketPath must be an absolute Unix socket path');
  }
  if (!(allowedNames instanceof Set) || allowedNames.size === 0) {
    throw new TypeError('allowedNames must be a non-empty Set');
  }
  if (!(verifiedContainerIds instanceof Set)
      || [...verifiedContainerIds].some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
    throw new TypeError('verifiedContainerIds must contain only complete Docker IDs');
  }
  if (!(verifiedContainerNameIds instanceof Map)
      || [...verifiedContainerNameIds].some(([name, id]) => !allowedNames.has(name) || !verifiedContainerIds.has(id))) {
    throw new TypeError('verifiedContainerNameIds must map task names to verified Docker IDs');
  }
  if (!(resumableContainerIds instanceof Set)
      || [...resumableContainerIds].some((id) => !verifiedContainerIds.has(id))) {
    throw new TypeError('resumableContainerIds must be a subset of verified container IDs');
  }

  let directory;
  let socketPath;
  const createdContainers = new Set();
  for (const id of verifiedContainerIds) createdContainers.add(id);
  const upgradedSockets = new Set();
  const server = createServer(async (clientReq, clientRes) => {
    let parsed;
    try {
      parsed = new URL(clientReq.url, 'http://docker.local');
    } catch {
      sendError(clientRes, 400, 'Invalid Docker API path');
      return;
    }

    const create = clientReq.method === 'POST' && isContainerCreate(parsed.pathname);
    const startRoute = clientReq.method === 'POST' && /^(?:\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+\/start\/?$/.test(parsed.pathname);
    const startMatch = startRoute && CONTAINER_START_PATH.exec(parsed.pathname);
    if (startRoute && (!startMatch || !resumableContainerIds.has(startMatch[1]))) {
      clientReq.resume();
      sendError(clientRes, 403, 'Container start is restricted to verified task containers');
      return;
    }
    if (isForbiddenMutation(clientReq.method, parsed.pathname)) {
      clientReq.resume();
      sendError(clientRes, 403, 'Docker mutation is outside this task runtime boundary');
      return;
    }
    let body;
    let headers = { ...clientReq.headers };
    if (create) {
      const names = parsed.searchParams.getAll('name');
      if (names.length !== 1 || !allowedNames.has(names[0])) {
        clientReq.resume();
        sendError(clientRes, 403, 'Container creation is restricted to this task project');
        return;
      }
      try {
        const rawBody = await readRequestBody(clientReq);
        enforceCreateBoundary(rawBody);
        body = rewriteBindings(rawBody);
      } catch (error) {
        if (error.message === 'Forbidden Docker host exposure mode') {
          sendError(clientRes, 403, 'Container host exposure is outside this task runtime boundary');
          return;
        }
        sendError(clientRes, error instanceof RangeError ? 413 : 400,
          error instanceof RangeError ? 'Container create request exceeds the local size limit' : 'Invalid container create request');
        return;
      }
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }

    if (clientReq.method === 'DELETE' && /^(?:\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+\/?$/.test(parsed.pathname)) {
      let identifier;
      try { identifier = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1)); }
      catch { /* Invalid escape remains an unrecognized identifier. */ }
      const volumeFlags = parsed.searchParams.getAll('v');
      const forceFlags = parsed.searchParams.getAll('force');
      const volumeFlag = volumeFlags.length === 0 ? 'absent'
        : volumeFlags.length > 1 ? 'duplicate'
          : volumeFlags[0] === 'false' ? 'false'
            : volumeFlags[0] === '0' ? 'zero' : 'other';
      const forceFlag = forceFlags.length === 0 ? 'absent'
        : forceFlags.length > 1 ? 'duplicate'
          : ['true', '1'].includes(forceFlags[0]) ? 'true'
            : ['false', '0'].includes(forceFlags[0]) ? 'false' : 'other';
      const isFullId = typeof identifier === 'string' && /^[0-9a-f]{64}$/.test(identifier);
      const isShortVerifiedId = typeof identifier === 'string' && /^[0-9a-f]{12,63}$/.test(identifier)
        && [...verifiedContainerIds].some((id) => id.startsWith(identifier));
      const identifierKind = isFullId && verifiedContainerIds.has(identifier) ? 'verified-full-id'
        : isShortVerifiedId ? 'verified-short-id'
          : allowedNames.has(identifier) ? 'exact-task-name'
            : /^[0-9a-f]+$/.test(identifier ?? '') ? 'foreign-id' : 'other';
      try {
        onDeleteEvent({
          endpoint: parsed.pathname.replace(/^(\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+\/?$/, '$1/containers/{id}'),
          idKind: identifierKind,
          idFormat: isFullId ? 'full-hex'
            : /^[0-9a-f]{12,63}$/.test(identifier ?? '') ? 'short-hex'
              : allowedNames.has(identifier) ? 'task-name' : 'other',
          volumeFlag,
          forceFlag,
        });
      } catch { /* Diagnostic callbacks must not affect request enforcement. */ }
      const removesVolumes = volumeFlags.length > 1
        || (volumeFlags.length === 1 && !['false', '0'].includes(volumeFlags[0]));
      const prefixMatches = typeof identifier === 'string' && /^[0-9a-f]{12,63}$/.test(identifier)
        ? [...verifiedContainerIds].filter((id) => id.startsWith(identifier)) : [];
      const resolvedId = verifiedContainerIds.has(identifier) ? identifier
        : verifiedContainerNameIds.get(identifier) ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
      if (!identifier || (!createdContainers.has(identifier) && !resolvedId) || removesVolumes) {
        clientReq.resume();
        sendError(clientRes, 403, 'Container removal is restricted to task-created containers and cannot remove volumes');
        return;
      }
      if (resolvedId) {
        const route = /^(\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+(\/?$)/.exec(parsed.pathname);
        if (route) clientReq.url = `${route[1] ?? ''}/containers/${resolvedId}${route[2]}${parsed.search}`;
      }
    }

    const upstreamReq = requestHttp({
      socketPath: upstreamSocketPath,
      path: clientReq.url,
      method: clientReq.method,
      headers,
      agent: false,
    }, (upstreamRes) => {
      if (create) {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          if (upstreamRes.statusCode === 201) {
            try {
              const result = JSON.parse(responseBody.toString('utf8'));
              if (typeof result.Id === 'string') {
                createdContainers.add(result.Id);
              }
            } catch { /* Invalid daemon create responses cannot seed delete ownership. */ }
          }
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
          clientRes.end(responseBody);
        });
      } else {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    });
    upstreamReq.on('error', () => {
      if (!clientRes.headersSent) sendError(clientRes, 502, 'Docker daemon request failed');
      else clientRes.destroy();
    });
    if (body) upstreamReq.end(body);
    else clientReq.pipe(upstreamReq);
  });
  server.on('upgrade', (clientReq, clientSocket, head) => {
    let parsed;
    try { parsed = new URL(clientReq.url, 'http://docker.local'); }
    catch { /* Invalid upgrade paths are rejected below. */ }
    const upgrade = clientReq.headers.upgrade;
    const connection = clientReq.headers.connection?.toLowerCase().split(',').map((part) => part.trim()) ?? [];
    const endpoint = parsed?.pathname
      .replace(/^(\/v[0-9]+\.[0-9]+)?\/exec\/[^/]+\/start\/?$/, '$1/exec/{id}/start')
      .replace(/^(\/v[0-9]+\.[0-9]+)?\/containers\/[^/]+\/attach\/?$/, '$1/containers/{id}/attach');
    try {
      onUpgradeEvent({
        method: clientReq.method,
        endpoint: endpoint ?? 'unrecognized',
        upgrade: upgrade === 'tcp' ? 'tcp' : 'other',
        connectionUpgrade: connection.includes('upgrade'),
      });
    } catch { /* Diagnostic callbacks must not affect request enforcement. */ }
    if (clientReq.method !== 'POST' || !parsed || !UPGRADE_PATH.test(parsed.pathname)
        || upgrade !== 'tcp' || !connection.includes('upgrade')) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const upstreamSocket = createConnection({ path: upstreamSocketPath });
    let upstreamConnected = false;
    upgradedSockets.add(clientSocket);
    upgradedSockets.add(upstreamSocket);
    const cleanup = () => {
      upgradedSockets.delete(clientSocket);
      upgradedSockets.delete(upstreamSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    clientSocket.once('error', cleanup);
    upstreamSocket.once('error', () => {
      if (!upstreamConnected && !clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      cleanup();
    });
    clientSocket.once('close', cleanup);
    upstreamSocket.once('close', () => upgradedSockets.delete(upstreamSocket));
    upstreamSocket.once('connect', () => {
      upstreamConnected = true;
      const headerLines = [];
      for (let index = 0; index < clientReq.rawHeaders.length; index += 2) {
        headerLines.push(`${clientReq.rawHeaders[index]}: ${clientReq.rawHeaders[index + 1]}\r\n`);
      }
      upstreamSocket.write(`${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}\r\n${headerLines.join('')}\r\n`);
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
  });

  return {
    get socketPath() { return socketPath; },
    async listen() {
      if (socketPath) throw new Error('Docker proxy is already listening');
      directory = await mkdtemp(join(tmpdir(), 'jt-studio-blog-tests-docker-'));
      socketPath = join(directory, 'docker.sock');
      server.listen(socketPath);
      await once(server, 'listening');
      await chmod(socketPath, 0o600);
      return socketPath;
    },
    async close() {
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      if (server.listening) {
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
      socketPath = undefined;
      directory = undefined;
    },
  };
}
