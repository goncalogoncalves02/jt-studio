import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const root = path.resolve(argument('--dir', 'dist/fixture/site'));
const host = argument('--host', '127.0.0.1');
const port = Number(argument('--port', '4173'));
if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The fixture server must bind to an explicit loopback address and port.');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.wasm', 'application/wasm'], ['.woff2', 'font/woff2'], ['.ico', 'image/x-icon'],
]);

async function existingFile(candidate) {
  const resolved = path.resolve(root, `.${candidate}`);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) return null;
  try {
    const info = await stat(resolved);
    return info.isFile() ? resolved : null;
  } catch { return null; }
}

async function resolveRequest(pathname) {
  if (pathname.includes('\\') || pathname.includes('\0')) return { file: null, status: 400 };
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return { file: null, status: 400 }; }
  if (decoded.split('/').includes('..')) return { file: null, status: 400 };
  const normalized = path.posix.normalize(`/${decoded}`).replace(/\/$/u, '') || '/';
  const candidates = [];
  if (normalized === '/') candidates.push('/index.html');
  else {
    candidates.push(normalized);
    if (!path.posix.extname(normalized)) candidates.push(`${normalized}.html`, `${normalized}/index.html`);
  }
  for (const candidate of candidates) {
    const file = await existingFile(candidate);
    if (file) return { file, status: 200 };
  }
  if (normalized === '/blog' || normalized.startsWith('/blog/')) return { file: await existingFile('/404.html'), status: 404 };
  if (normalized === '/admin' || normalized.startsWith('/admin/')) return { file: await existingFile('/404.html'), status: 404 };
  if (normalized.startsWith('/blog-data/')) return { file: null, status: 404 };
  return { file: await existingFile('/index.html'), status: 200 };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  const { file, status } = await resolveRequest(url.pathname);
  if (!file) {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }).end(status === 404 ? 'Not found' : 'Invalid path');
    return;
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  const headers = { 'content-type': mime.get(path.extname(file)) ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' };
  if (relative === 'admin.html') headers['x-robots-tag'] = 'noindex, nofollow';
  if (relative.startsWith('blog-data/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
  else if (relative.startsWith('assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
  else headers['cache-control'] = 'public, max-age=0, must-revalidate';
  response.writeHead(status, headers);
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(port, host, () => process.stdout.write(`Static fixture server ready at http://${host}:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await access(root);
}
