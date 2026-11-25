import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStorageResponseGate } from '../e2e/blog-media.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Storage response gate preserves upstream status, headers and bytes on default, gated and RPC paths', { timeout: 5000 }, async () => {
  const targetPath = '/storage/v1/object/blog-drafts/draft/owner/media/960.webp';
  const objectBytes = Buffer.from('real-upstream-webp-response');
  const upstream = http.createServer((request, response) => {
    if (request.url === '/ordinary-denial') {
      response.writeHead(409, { 'content-type': 'application/json', 'x-upstream-marker': 'ordinary-denial' });
      response.end('{"error":"conflict"}');
      return;
    }
    if (request.url === targetPath) {
      response.writeHead(200, { 'content-type': 'image/webp', 'x-upstream-marker': 'object' });
      response.end(objectBytes);
      return;
    }
    if (request.url === '/rest/v1/rpc/blog_media_record_variant') {
      response.writeHead(403, { 'content-type': 'application/json', 'x-upstream-marker': 'rpc-denial' });
      response.end('{"code":"42501","message":"denied"}');
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createStorageResponseGate(upstreamUrl);
  try {
    const proxyUrl = await proxy.listen();
    const denied = await fetch(`${proxyUrl}/ordinary-denial`);
    assert.equal(denied.status, 409);
    assert.equal(denied.headers.get('x-upstream-marker'), 'ordinary-denial');
    assert.equal(await denied.text(), '{"error":"conflict"}');

    const gate = proxy.arm('GET', targetPath);
    const gatedResponse = fetch(`${proxyUrl}${targetPath}`);
    const physical = await gate.ready;
    assert.deepEqual(physical, { status: 200, contentType: 'image/webp', byteLength: objectBytes.length });
    gate.release();
    const object = await gatedResponse;
    assert.equal(object.status, 200);
    assert.equal(object.headers.get('x-upstream-marker'), 'object');
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), objectBytes);

    const mediaId = '00000000-0000-4000-8000-000000000305';
    const watchedRpc = proxy.watchRecordVariant(mediaId);
    const rpcResponsePromise = fetch(`${proxyUrl}/rest/v1/rpc/blog_media_record_variant`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_media_id: mediaId }),
    });
    const rpcResult = await watchedRpc;
    assert.deepEqual(rpcResult, { status: 403, code: '42501' });
    const rpcResponse = await rpcResponsePromise;
    assert.equal(rpcResponse.status, 403);
    assert.equal(rpcResponse.headers.get('x-upstream-marker'), 'rpc-denial');
    assert.equal(await rpcResponse.text(), '{"code":"42501","message":"denied"}');
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});
