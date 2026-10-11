import { optimizeImage, validateInputImage } from '../../../src/blog/image-processing.js';

window.imageProcessingHarness = {
  ready: true,
  optimizeImage,
  validateInputImage,
  message: 'Pipeline de imagem pronta.',
};
document.querySelector('#harness-status').textContent = window.imageProcessingHarness.message;
