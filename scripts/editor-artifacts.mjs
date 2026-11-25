import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function publicClientAssets(result) {
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output ?? []);
  const chunks = new Map(outputs.filter((output) => output.type === 'chunk').map((chunk) => [chunk.fileName, chunk]));
  const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) throw new Error('Expected one public site entry');
  const seen = new Set();
  function visit(chunk) {
    if (seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const id of chunk.moduleIds) {
      if (/\/src\/admin\/(?!AdminRoute\.jsx$)|\/node_modules\/(?:@tiptap\/|prosemirror-|@jsquash\/)|\/src\/blog\/(?:codecs\/|image-worker\.js)/u.test(id)) {
        throw new Error('Editor code must load only through the administration route');
      }
    }
    for (const name of chunk.imports) {
      const dependency = chunks.get(name);
      if (dependency) visit(dependency);
    }
  }
  entries.forEach(visit);
  return [...seen];
}

export async function writeEditorNotices(siteDir, projectRoot) {
  const output = path.join(siteDir, 'codec-notices');
  await mkdir(output, { recursive: true });
  const files = [
    'third_party_licenses/README.md', 'third_party_licenses/libheif-COPYING.txt', 'third_party_licenses/libde265-v1.1.3-COPYING.txt',
    'third_party_licenses/jsquash-webp-Apache-2.0.txt', 'third_party_licenses/jsquash-webp-codec-BSD-3-Clause.txt',
    'third_party_licenses/wasm-feature-detect-Apache-2.0.txt',
    'src/blog/codecs/heif-codec.manifest.json', 'src/blog/codecs/heif-codec.js',
    'scripts/build-heif-codec/heif_adapter.cpp', 'scripts/build-heif-codec/build-offline.sh',
    'scripts/build-heif-codec/rebuild.sh', 'scripts/build-heif-codec/write-manifest.mjs',
  ];
  await Promise.all(files.map((file) => copyFile(path.join(projectRoot, file), path.join(output, path.basename(file)))));
  await copyFile(path.join(projectRoot, 'scripts/build-heif-codec/README.md'), path.join(output, 'build.md'));
}
