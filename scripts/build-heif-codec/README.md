# Rebuilding the local HEIC decoder

The generated ESM/WASM codec under `src/blog/codecs/` is checked into the repository. Normal site and Netlify builds use those files and must not fetch third-party source or compile C++. Regenerate only with `npm run rebuild:heif-codec`; the script is intentionally a separate local developer operation.

## Pinned sources and runtime

| Input | Source commit/tag | Archive SHA-256 |
| --- | --- | --- |
| libheif | `v1.23.6`, `f81f28ac014b1c28dee483ac45b72c6b05bc421a` | `c9a00b0452f5c16d72ef71e5e40c0e90fbe2ad37148d27a1b2f9bb21546f5f03` |
| libde265 | `v1.1.3`, `ba62bf4cfb3242f3bf0a45617ff09e35236e4d82` | `189baa08fd6d2dd34db099de411bd6b2e6bd5eb88e81236a3d0fa3826b9715c4` |

The archives come from the official upstream GitHub tag source URLs. The official Emscripten SDK Docker image is pinned to the verified Linux/amd64 manifest `emscripten/emsdk@sha256:52549e68ad6dd0f3509ff378bc1a5d317d40030c8991919cada0dad95d85e00c` (tag `6.0.12`). The resolved immutable image manifest and `emcc --version` are captured in the generated provenance manifest and ignored Task 2 build evidence. The sources are downloaded and SHA-256 checked on the host; the compile container has no network. Context7 was quota-limited for the pinned libraries; options were verified against the exact tagged upstream `CMakeLists.txt`, `README.md`, and installed headers.

## Build configuration

`build-offline.sh` uses upstream CMake for both libraries. libde265 is static with its HEVC decoder enabled and its encoder, SIMD, SDL, and development tools disabled. libheif is static, links the pinned libde265, and has plugin loading, every optional non-HEVC encoder/decoder, examples, tests, docs, multithreading, parallel tile decoding, and header compression disabled. It defines the upstream `__EMSCRIPTEN_STANDALONE_WASM__` guard to exclude libheif's optional embind JavaScript API because this adapter uses only the stable C API. WebAssembly exception handling is enabled explicitly at compile and link because libheif C++ paths throw; this does not enable dynamic JavaScript execution. The resulting module is WASM-only, ESM and worker-only, with dynamic execution disabled, memory growth enabled, and a 64 MiB initial memory. The Emscripten `HEAPU8` and `HEAPU32` runtime views are exported for the adapter's input and RGBA memory copies, including after WASM memory growth. The adapter asks libheif for the **primary** image, decodes to interleaved RGBA, returns the actual decoded dimensions, and exports both library version getters for browser assertions. The existing bounded header parser remains the pre-decode allocation guard; this codec does not replace it.

Before `heif_context_read_from_memory`, the adapter sets the tagged libheif context's `max_image_size_pixels` to the product's exact 60,000,000-pixel ceiling. It does not use the deprecated width-squared setter. The 30 MiB input-file limit remains in force; other `max_total_memory` and `max_memory_block_size` values retain libheif 1.23.6's own defaults and are not represented as a complete peak-memory bound. The context's effective image-pixel setting is exported and asserted from the browser build.

The adapters are original project glue. The libheif and libde265 license texts and pinned-source provenance are in `third_party_licenses/`. `heif-codec.manifest.json` records source commits/archive hashes, image/compiler identity, the explicit context image-size limit and generated JS/WASM SHA-256 digests.

## Reproduction and resource boundaries

The host requires Docker Desktop, `curl`, `tar`, `sha256sum`, `jq`, `node`, and npm. It does not install a global compiler. Run from the repository root:

```sh
npm run rebuild:heif-codec
```

The script uses an owned `/tmp/jt-studio-task2-heif.*` directory (or an explicit `HEIF_BUILD_TMP`), rechecks the protected Docker container and volume inventory recorded at `/tmp/jt-studio-protected-docker-20261011.json`, and records the current inventories before image pull. That initial snapshot contained 7 containers, 236 volumes, and 197 images. All pre-existing resources remain protected. The build image is pulled by exact digest. This Docker Desktop daemon cannot bind-mount the host `/tmp`, so the procedure uses `docker cp` to copy the already SHA-256-verified source archives and build scripts into one explicitly named task-owned container's writable ephemeral layer; the compilation itself has no mounts, ports, named volumes, or Docker socket. The container runs as the host UID/GID, no-new-privileges, no capabilities, no network, at most 2 CPUs/3 GiB (the daemon reports 4.1 GB memory), and is preserved on failure for diagnosis. On success, the script copies outputs and provenance back to host `/tmp`, captures the container exit status, then removes only that exact task-owned container ID. It does not prune or delete any image, volume, or other container. Local build-script defects are recorded and corrected from captured logs: source extraction's target directory was not created, the adapter's copied path differed from the compiler input, and libheif's generated public version header needed the CMake install step before adapter compilation. The upstream `__EMSCRIPTEN_STANDALONE_WASM__` guard is used to omit embind bindings because this adapter uses only the C API; WebAssembly exception support is enabled for libheif's C++ throw paths. The original bind-mount attempt was rejected before container creation; the post-attempt inventory still had the same 7 protected containers and 236 volumes.

Transient source, build, Emscripten cache, compiler and command logs stay under the task-owned temp path and ignored Task 2 evidence directory. The temp source/build directory and pulled compiler image may remain after completion; remove neither as part of the reproduction. Browser runs remain mandatory after a rebuild, because a successful compile alone does not prove worker loading, image dimensions, output quality, cancellation, or compatibility.

## Upstream references

- [libheif v1.23.6 CMake options](https://github.com/strukturag/libheif/blob/v1.23.6/CMakeLists.txt)
- [libheif v1.23.6 README](https://github.com/strukturag/libheif/blob/v1.23.6/README.md)
- [libde265 v1.1.3 CMake options](https://github.com/strukturag/libde265/blob/v1.1.3/CMakeLists.txt)
- [libde265 v1.1.3 README](https://github.com/strukturag/libde265/blob/v1.1.3/README.md)
- [Official Emscripten Docker guidance](https://emscripten.org/docs/building_from_source/using_docker.html)
- [Emscripten memory views/runtime exports](https://emscripten.org/docs/api_reference/preamble.js.html#type-accessors-for-the-memory-model)
- [Emscripten C++ exception support](https://emscripten.org/docs/porting/exceptions.html)
