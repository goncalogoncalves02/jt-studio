OffscreenCanvas.prototype.convertToBlob = async function testAbortedNativeWebP() {
  throw new DOMException('cancelled by test', 'AbortError');
};
const queued = [];
self.onmessage = (event) => queued.push(event);
await import('../../../src/blog/image-worker.js');
for (const event of queued) self.onmessage(event);
