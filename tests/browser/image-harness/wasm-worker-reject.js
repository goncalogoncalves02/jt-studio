OffscreenCanvas.prototype.convertToBlob = async function testRejectedNativeWebP() {
  throw new Error('test-only native encoder rejection');
};
const queued = [];
self.onmessage = (event) => queued.push(event);
await import('../../../src/blog/image-worker.js');
for (const event of queued) self.onmessage(event);
