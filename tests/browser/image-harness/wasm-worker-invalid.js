OffscreenCanvas.prototype.convertToBlob = async function testInvalidNativeWebP() {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' });
};
const queued = [];
self.onmessage = (event) => queued.push(event);
await import('../../../src/blog/image-worker.js');
for (const event of queued) self.onmessage(event);
