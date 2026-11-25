import { optimizeImage, validateInputImage } from '../../../src/blog/image-processing.js';
import WasmInvalidWorker from './wasm-worker-invalid.js?worker';
import WasmRejectWorker from './wasm-worker-reject.js?worker';
import AbortNativeWorker from './abort-native-worker.js?worker';

window.imageProcessingHarness = {
  ready: true,
  optimizeImage,
  validateInputImage,
  async heifCodecInfo() {
    const { getHeifCodecVersions } = await import('../../../src/blog/codecs/heif-codec.js');
    return getHeifCodecVersions();
  },
  async decodeReference(file) {
    const { decodePrimaryHeif } = await import('../../../src/blog/codecs/heif-codec.js');
    const bitmap = await decodePrimaryHeif(file);
    const sourceWidth = bitmap.width; const sourceHeight = bitmap.height;
    const full = new OffscreenCanvas(bitmap.width, bitmap.height);
    full.getContext('2d').drawImage(bitmap, 0, 0);
    const width = Math.round(bitmap.width * Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)));
    const height = Math.round(bitmap.height * Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)));
    const matched = new OffscreenCanvas(width, height);
    matched.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const fullPng = await full.convertToBlob({ type: 'image/png' });
    const matchedPng = await matched.convertToBlob({ type: 'image/png' });
    bitmap.close(); full.width = full.height = matched.width = matched.height = 1;
    const dataUrl = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:${blob.type};base64,${btoa(binary)}`;
    };
    return { width: sourceWidth, height: sourceHeight, fullPng: await dataUrl(fullPng), matchedPng: await dataUrl(matchedPng) };
  },
  optimizeWithNativeFailure(file, mode) {
    return new Promise((resolve, reject) => {
      const WorkerConstructor = mode === 'reject' ? WasmRejectWorker : mode === 'abort' ? AbortNativeWorker : WasmInvalidWorker;
      const worker = new WorkerConstructor();
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') return;
        worker.terminate();
        if (data.type === 'result') resolve(data.result);
        else reject(data.name === 'AbortError' ? new DOMException(data.message, 'AbortError') : new Error(data.message));
      };
      worker.onerror = () => { worker.terminate(); reject(new Error('Test worker failed')); };
      worker.postMessage({ type: 'process', file });
    });
  },
  message: 'Pipeline de imagem pronta.',
};
document.querySelector('#harness-status').textContent = window.imageProcessingHarness.message;
