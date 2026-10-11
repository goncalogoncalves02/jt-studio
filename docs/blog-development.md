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

## Verification commands

Run these from the repository root with Node 24.21.0:

- `npm run lint` — ESLint. The pre-existing baseline has one `react-hooks/set-state-in-effect` error in `src/components/NavBar.jsx:16`.
- `npm run build` — existing production build; remains independent of fixture data.
- `npm run build:fixture` — explicit synthetic-release client/SSR rendering proof.
- `node --test tests/unit/render-html.test.mjs` — metadata, script-safe bootstrap serialization, and raw HTML for all five existing routes. Run after `npm run build:fixture`.
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
