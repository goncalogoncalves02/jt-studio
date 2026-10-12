import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve('tests/browser/image-harness');
const output = resolve('dist/fixture/site/__task2');

await build({
  configFile: false,
  root,
  base: '/__task2/',
  publicDir: resolve('tests/fixtures/media'),
  worker: { format: 'es' },
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'index.html') },
  },
});

const pickerRoot = resolve('tests/browser/media-picker-harness');
await build({
  configFile: false,
  root: pickerRoot,
  base: '/__task5/',
  build: {
    outDir: resolve('dist/fixture/site/__task5'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(pickerRoot, 'index.html') },
  },
});
