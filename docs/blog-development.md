# Blog development and verification

The repository uses Node.js **24.21.0** for local builds and verification. `.nvmrc`
records that version; Netlify's build environment selects it in `netlify.toml`.
Project npm settings keep peer dependency resolution strict (`legacy-peer-deps=false`).
Use a task-local npm cache and Playwright browser directory when running this work:

```sh
export PATH=/tmp/jt-studio-runtime/node-v24.21.0-linux-x64/bin:$PATH
export npm_config_cache=/tmp/jt-studio-npm-cache
export PLAYWRIGHT_BROWSERS_PATH=/tmp/jt-studio-browsers
```

## Current build boundary

`npm run build` remains the existing site build. The confirmed-release reader is not
installed yet, so it must not fall back to an empty article fixture. The separate
`npm run build:fixture` command explicitly selects the synthetic empty release in
`tests/fixtures/empty-release.json` and writes verification artifacts under
`dist/fixture/`. It is test-only and is not a production publication command.

The fixture build creates a client Vite output and a separate SSR output, then writes
static documents for `/`, `/servicos`, `/info`, `/galeria`, and `/contactos`. It also
writes directory-index aliases for the four non-home routes with a trailing slash.
Both URL forms render matching route trees and use the no-slash canonical. Task 8
must add confirmed-release sourcing before the production build can publish the blog.
`vite.config.js` remains unchanged because its existing React SWC and Tailwind plugins
are used by both builds; `build-blog.mjs` supplies the independent output directories,
root, base path, and SSR entry through Vite's per-build options.

## Verification commands

Run these from the repository root with Node 24.21.0:

- `npm run lint` — ESLint. The pre-existing baseline has one `react-hooks/set-state-in-effect` error in `src/components/NavBar.jsx:16`.
- `npm run build` — existing production build; remains independent of fixture data.
- `npm run build:fixture` — explicit synthetic-release client/SSR rendering proof.
- `npm run test:unit` — discovers every `tests/unit/*.test.mjs` module, covering metadata, script-safe bootstrap serialization, and raw HTML for all five existing routes. Requires a successful `npm run build:fixture` immediately beforehand; legacy-build artifact checks are kept under `tests/legacy/` so this gate stays fixture-only.

## Image processing

The editor image pipeline is isolated under `src/blog/` and runs in a module worker. `validateInputImage(file)` checks the byte signature and bounded header dimensions; `optimizeImage(file, { signal, onProgress })` decodes one image, strips source metadata by drawing pixels to canvas, and returns SHA-256 identified WebP variants at up to 480, 960, and 1600 pixels. Inputs above 30 MiB, 12,000 pixels on either axis, or 60 megapixels are rejected before full bitmap decoding when their headers contain dimensions. HEIC/HEIF uses `heic-to` 1.6.6 in the worker and selects the first top-level image; this decoder behavior is documented upstream in its pinned source. AVIF is supported by the browser decoder when available. Native WebP output is accepted only when its MIME and RIFF signature both match; otherwise the locally bundled `@jsquash/webp` 1.5.0 WASM encoder is used. WASM quality is converted from the pipeline's native 0–1 scale to jSquash's 0–100 scale.

The measured iPhone XR CC0 sample at `tests/fixtures/media/iphone-xr-original.HEIC` produced the 480, 960, and 1600-pixel variants at initial quality 0.84, all below their 128, 256, and 512 KiB targets in the recorded Chromium run. Quality may descend to 0.78 to reach each target; each returned variant also enforces the 1 MiB upload ceiling. See `tests/fixtures/media/README.md`, `third_party_licenses/README.md`, and the ignored `.superpowers/sdd/2026-10-11-blog-editorial/task2-report.md` for fixture, license, and measured browser details. The public sample and desktop browser tests do not establish manual iPhone/Safari editor acceptance.

The normal public build must remain free of codec assets. Browser proofs build a private test harness from the same worker entry and use the normal production build output. Run Chromium with `PLAYWRIGHT_BROWSERS_PATH` set to a local Playwright cache. For the local WebKit host-library overlay only, set it to the task-owned browser-cache overlay under `/tmp`; that overlay is a test-runtime prerequisite and is not an application dependency. Do not add machine-specific paths to project configuration.
- `npm run test:legacy` — confirms that the legacy Vite output still contains its original raw metadata and BeautySalon JSON-LD. Run after `npm run build`; its artifact-dependent test lives outside the unit-test discovery directory.
- `node scripts/check-public-artifacts.mjs` — route metadata, structured data, hydration payload, and local asset checks. Run after `npm run build:fixture`.
- `npm run test:browser -- tests/browser/existing-pages.spec.js` — Chromium hydration, navigation, console errors, and missing assets. The Playwright web server builds the explicit fixture first.

Playwright uses a local preview on `127.0.0.1:4173` and checks both URL forms for each
non-home route. The flat files serve the canonical extensionless URLs; directory-index
aliases serve trailing-slash requests. Vite preview was verified for both mappings, but
hosting-level Netlify behavior remains unverified. Provider requests for analytics,
consent, fonts, and maps are intercepted only in the test browser; their HTML references
remain intact. No container or cloud service is required for this task. Set
`PLAYWRIGHT_BROWSERS_PATH` to keep browser downloads outside the repository. Do not use
the fixture output as a production fallback.
