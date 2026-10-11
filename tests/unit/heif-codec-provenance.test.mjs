import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root));
}

test('HEIC decoder artifact is pinned to the approved patched sources and local build', async () => {
  const manifest = JSON.parse(await read('src/blog/codecs/heif-codec.manifest.json'));
  const recipe = await read('scripts/build-heif-codec/build-offline.sh');
  assert.equal(manifest.sources.libheif.version, '1.23.6');
  assert.equal(manifest.sources.libheif.commit, 'f81f28ac014b1c28dee483ac45b72c6b05bc421a');
  assert.equal(manifest.sources.libde265.version, '1.1.3');
  assert.equal(manifest.sources.libde265.commit, 'ba62bf4cfb3242f3bf0a45617ff09e35236e4d82');
  assert.equal(manifest.build.emscripten, '6.0.12');
  assert.equal(manifest.build.platform, 'linux/amd64');
  assert.equal(manifest.build.exceptions, 'wasm');
  assert.equal(manifest.securityLimits.maxImageSizePixels, 60_000_000);
  assert.equal(manifest.securityLimits.setOnContextBeforeParsing, true);
  assert.equal(manifest.securityLimits.codecThreadsPerDecode, 1);
  assert.match(recipe.toString(), /EXPORTED_RUNTIME_METHODS=.*HEAPU8.*HEAPU32/);
  for (const [file, expectedDigest] of Object.entries(manifest.outputs)) {
    const bytes = await read(`src/blog/codecs/${file}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedDigest, `${file} digest`);
  }
  assert.ok(manifest.outputs['heif-decoder.wasm']);
});

test('the worker no longer imports the vulnerable heic-to build', async () => {
  const worker = await read('src/blog/image-worker.js');
  const dependencies = JSON.parse(await read('package.json'));
  assert.doesNotMatch(worker.toString(), /heic-to/);
  assert.equal(dependencies.dependencies['heic-to'], undefined);
});
