import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [outputDirectory, compilerVersionFile, outputFile] = process.argv.slice(2);
if (!outputDirectory || !compilerVersionFile || !outputFile) throw new Error('Usage: write-manifest.mjs <output-directory> <compiler-version-file> <manifest-output>');

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const outputs = {};
for (const file of ['heif-decoder.js', 'heif-decoder.wasm']) outputs[file] = await digest(resolve(outputDirectory, file));
const compiler = (await readFile(compilerVersionFile, 'utf8')).trim();
const manifest = {
  sources: {
    libheif: {
      version: '1.23.6',
      commit: 'f81f28ac014b1c28dee483ac45b72c6b05bc421a',
      archive: 'https://github.com/strukturag/libheif/archive/refs/tags/v1.23.6.tar.gz',
      sha256: 'c9a00b0452f5c16d72ef71e5e40c0e90fbe2ad37148d27a1b2f9bb21546f5f03',
    },
    libde265: {
      version: '1.1.3',
      commit: 'ba62bf4cfb3242f3bf0a45617ff09e35236e4d82',
      archive: 'https://github.com/strukturag/libde265/archive/refs/tags/v1.1.3.tar.gz',
      sha256: '189baa08fd6d2dd34db099de411bd6b2e6bd5eb88e81236a3d0fa3826b9715c4',
    },
  },
  build: {
    image: 'emscripten/emsdk@sha256:52549e68ad6dd0f3509ff378bc1a5d317d40030c8991919cada0dad95d85e00c',
    platform: 'linux/amd64',
    emscripten: '6.0.12',
    compiler,
    threading: false,
    simd: false,
    plugins: false,
    dynamicExecution: false,
    exceptions: 'wasm',
  },
  securityLimits: {
    maxImageSizePixels: 60_000_000,
    setOnContextBeforeParsing: true,
    maxImageSizeBlockSizeAndTotalMemoryRetainLibheifDefaults: true,
    codecThreadsPerDecode: 1,
  },
  outputs,
};
await writeFile(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
