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

The editor image pipeline is isolated under `src/blog/` and runs in a module worker. `validateInputImage(file)` checks the byte signature and bounded header dimensions; HEIF/AVIF top-level boxes are scanned by file offset within a 4,096-box budget, reading only bounded `ftyp` and `meta` boxes and rejecting duplicate metadata before decoder loading. `optimizeImage(file, { signal, onProgress })` decodes one image, strips source metadata by drawing pixels to canvas, and returns SHA-256 identified WebP variants at distinct eligible widths 480, 960, and the master width. The master is capped by its longest side at 1,600 pixels; variants preserve aspect ratio and never enlarge. Inputs above 30 MiB, 12,000 pixels on either axis, or 60 megapixels are rejected before full bitmap decoding when their headers contain dimensions. HEIC/HEIF is handled by the task-local generated ESM/WASM adapter under `src/blog/codecs/`; it is built from libheif 1.23.6 with libde265 1.1.3, selects the primary image, and loads only when the worker receives HEIC/HEIF. The pinned-source provenance, source archive digests, compiler identity, adapter interface, and exact build flags are maintained beside the explicit rebuild script and in the Task 2 report. Ordinary site builds consume the checked-in generated codec files and do not download source or compile C++. AVIF continues through the browser decoder when available. Native WebP output is accepted only when its MIME and RIFF signature both match; otherwise the locally bundled `@jsquash/webp` 1.5.0 WASM encoder is used. WASM quality is converted from the pipeline's native 0–1 scale to jSquash's 0–100 scale.

The measured landscape iPhone XR CC0 sample at `tests/fixtures/media/iphone-xr-original.HEIC` produced widths 480, 960, and 1600 at initial quality 0.84, all below their 128, 256, and 512 KiB targets in the recorded Chromium run. For a 3024×4032 portrait, the corresponding variants are 480×640, 960×1280, and 1200×1600. Quality may descend to 0.78 to reach each target; each returned variant also enforces the 1 MiB upload ceiling. See `tests/fixtures/media/README.md`, `third_party_licenses/README.md`, and the ignored `.superpowers/sdd/2026-10-11-blog-editorial/task2-report.md` for fixture, license, and measured browser details. The public sample and desktop browser tests do not establish manual iPhone/Safari editor acceptance.

The normal public build must remain free of codec assets. Browser proofs build a private test harness from the same worker entry and use the normal production build output. Run Chromium with `PLAYWRIGHT_BROWSERS_PATH` set to a local Playwright cache. For the local WebKit host-library overlay only, set it to the task-owned browser-cache overlay under `/tmp`; that overlay is a test-runtime prerequisite and is not an application dependency. Do not add machine-specific paths to project configuration.

### Rebuilding the HEIC decoder

The checked-in codec artifact is regenerated only by the separate, explicit Task 2 codec build command documented in `scripts/build-heif-codec/README.md`; routine site builds and Netlify must not invoke it. The approved local build runtime is the official `emscripten/emsdk` image for release 6.0.12, pinned to the verified `linux/amd64` image manifest digest in that runbook. The source inputs are the exact libheif v1.23.6 and libde265 v1.1.3 archives with recorded upstream commit IDs and SHA-256 digests. Build compilation runs offline after host-side source/archive verification, as the host has no CMake or Emscripten toolchain.

All pre-existing Docker resources are protected. The initial local inventory records 7 containers, 236 volumes, and 197 images; the named services/containers are preserved in the task's ignored evidence. Before creating the compiler container, refresh that inventory and compare it with the recorded protected state. This Docker Desktop daemon cannot bind-mount the host `/tmp`, so the build uses `docker cp` to place verified archives/scripts in one explicitly named and labelled task-owned ephemeral container's writable layer; compilation has no mounts. The container runs as non-root host UID/GID with `--network none`, at most 2 CPUs and 3 GiB memory on the current daemon, and no ports, named volumes or Docker socket. Record the exact container ID and build output before removing only that container by ID. Never prune Docker resources, remove images/volumes, or stop other services as part of this task. The local Docker Desktop runtime and temporary source/build directories are development/test prerequisites, not application dependencies.

- `npm run test:legacy` — confirms that the legacy Vite output still contains its original raw metadata and BeautySalon JSON-LD. Run after `npm run build`; its artifact-dependent test lives outside the unit-test discovery directory.
- `node scripts/check-public-artifacts.mjs` — route metadata, structured data, hydration payload, and local asset checks. Run after `npm run build:fixture`.
- `npm run test:browser -- tests/browser/existing-pages.spec.js` — Chromium hydration, navigation, console errors, and missing assets. The Playwright web server builds the explicit fixture first.

Playwright uses a local preview on `127.0.0.1:4173` and checks both URL forms for each
non-home route. The flat files serve the canonical extensionless URLs; directory-index
aliases serve trailing-slash requests. Vite preview was verified for both mappings, but
hosting-level Netlify behavior remains unverified. Provider requests for analytics,
consent, fonts, and maps are intercepted only in the test browser; their HTML references
remain intact. The approved Task 2 codec rebuild uses the isolated local compiler
container described above; no cloud service is required. Set `PLAYWRIGHT_BROWSERS_PATH`
to keep browser downloads outside the repository. Do not use the fixture output as a
production fallback.

## Task 3 disposable Supabase backend

Task 3 uses only the local Supabase project `jt-studio-blog-tests`. The exact CLI
version is `2.120.0`; inspect the installed CLI `--help` before setup and migration
commands. The CLI generates `supabase/config.toml` and the timestamped migration
name. Keep the CLI npm cache, state, and project-specific database secrets under
task-owned `/tmp` locations or ignored files. The local runner sets the CLI child
`HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` to `/tmp/jt-studio-supabase-cli-home`
removes any inherited `SUPABASE_ACCESS_TOKEN`, and sets the documented
`SUPABASE_TELEMETRY_DISABLED=1` child-process option; it does not change global CLI
configuration. Never link the project to cloud.

Before starting any backend container, refresh and compare the protected Docker
inventory in `/tmp/jt-studio-protected-docker-20261011.json`; record the exact
current containers, all volumes, networks, images, and listening ports in the
ignored Task 3 report without dumping container environment variables. Protected
resources include all resources that predate this task, including all existing
volumes and Keepy services. Create only the task-owned bridge network
`jt-studio-blog-tests-network` with Docker option
`com.docker.network.bridge.host_binding_ipv4=127.0.0.1`. Pass its verified ID via
the CLI's supported `--network-id` option. Confirm every published port has
effective `HostIp=127.0.0.1` after startup; stop the task if a service is exposed
on another interface. Do not change global Docker settings.

Use project ID `jt-studio-blog-tests`, with intended API/DB/Studio/mail ports
54341/54342/54343/54344 and shadow DB port 54340. The generated config is the
source of truth: check every enabled and disabled service port against live
listeners and protected container bindings, including the default shadow port.
CLI 2.120.0 supports `supabase start --exclude`. Start only Postgres, GoTrue/Auth,
PostgREST, and Kong with
`--exclude realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`.
Auth stays available for Task 4. Never bind-mount host or `/tmp` paths into Docker
Desktop containers. Record exact container IDs, network ID, generated project ID,
bound ports, and CLI output.

The Task 3 daemon check found the Docker Desktop overlay at 46/47 GiB used with no
free blocks; Postgres `initdb` therefore failed with `No space left on device`.
After verifying that no container referenced it, the user approved removal of
only the task 2 compiler image
`emscripten/emsdk@sha256:52549e68ad6dd0f3509ff378bc1a5d317d40030c8991919cada0dad95d85e00c`.
The exact image was removed without `--force`, pruning, or volume operations.
This is a single approved exception; it does not authorize other image or volume
cleanup. The failed Task 3 database volume
`supabase_db_jt-studio-blog-tests` remains preserved for diagnosis. Recheck free
space and its state before any further local start or migration.

Do not use `supabase db reset` for this persistent Task 3 runtime. CLI 2.120.0
removed the task-owned DB container and then attempted a separate volume delete;
the local proxy blocked that request, leaving the task volume intact. The runner
has three separate lifecycle commands: `provision` invokes pinned CLI `start`
only when no container with this project label exists; `resume` validates the
complete existing stack and starts only the four recorded full container IDs;
`migrate` applies pending migrations to a ready local database. Normal test runs
must not provision or reset their database. Resume fails closed for partial
stacks, changed IDs, labels, bridge, ports, mounts, protected inventories, or
unexpected listeners. It starts DB, verifies PostgreSQL 17 health, then resumes
Auth, PostgREST, and Kong and checks local Auth/PostgREST readiness. Resume does
not create or remove containers, networks, or volumes.

The migration action verifies the exact project, DB container labels and loopback
binding, CLI version, and local DB URL; it never accepts a linked project or an
explicit connection URL. Keep the proxy's prune and volume-delete denials enabled.
Do not fall back to cloud or touch any pre-existing database. Task-local database
concurrency proofs use two physical PostgreSQL connections and `pg_blocking_pids`;
no SQL transaction may remain open across Auth, Storage, or HTTP work.

Run Task 3 behavior gates only against that ready local project:

```sh
node scripts/test-db.mjs editorial editorial-inputs guard-mutations publication
node scripts/test-backend.mjs
node tests/db/concurrency.mjs
npm run test:unit
```

`test-db.mjs` accepts only those named SQL files, validates the CLI-reported
loopback target and PostgreSQL major version, and reports SQLSTATE plus a bounded
schema constraint name only. The guard-mutation gate temporarily changes the
owner RLS policy, DocumentV1 validator, and release immutability trigger inside
separate transactions, proves each removed guard loses its protection, then rolls
back all data and schema changes. The Data API gate uses disposable Auth JWTs
only for actual owner/non-owner/anonymous RLS and RPC-grant checks; it does not
test persistent Auth-session lifecycle. Concurrency evidence must come from real
physical PostgreSQL connections and observed `pg_blocking_pids`, not sleeps.

The pinned CLI help lists `db advisors --local` and `db lint --local`, but this
version returned only generic empty `message`/`results` envelopes for both; do not
count those commands as completed analysis. Keep the checks that did run separate:
SQL catalog/effective grants, RLS/Data API behavior, and physical concurrency.
Do not substitute a cloud Advisor request for a local diagnostic.

## Task 4 server-managed admin sessions

The Netlify Function boundary reads only server-side configuration. The approved
environment names are `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `BLOG_ADMIN_USER_ID`,
`BLOG_SESSION_ENCRYPTION_KEY` (32 bytes encoded as 64 lowercase hexadecimal
characters), and `BLOG_PUBLIC_ORIGIN` (an exact HTTPS origin). Keep local values
outside tracked files; `.env.example` contains placeholders only. The service-role
key is used only by narrow session RPC helpers. Editorial CRUD continues to use
the owner's authenticated identity and database RLS.

Browser session tests must run against the ready task-owned Supabase project and
the actual local Auth service and Netlify Functions, not mocked application guards:

```sh
export PATH="/tmp/jt-studio-runtime/node-v24.21.0-linux-x64/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH=/tmp/jt-studio-browsers
npm run test:e2e -- tests/e2e/session.spec.js
node tests/db/admin-session-logout-concurrency.mjs
node tests/db/admin-session-refresh-expiry-concurrency.mjs
```

The runner checks the pinned Supabase CLI version and exact loopback project before
creating a synthetic `task4-*` Auth user. It sets the authorized owner only while
the fixture is active, exercises password sign-in, opaque cookie transport and
admin session reads in Chromium, then deletes only its own sessions/user and
restores the owner setting. Confirm the owner is `NULL` and the exact fixture
count is zero after any interrupted run; do not reset or reprovision the database.
The browser cache and HTTPS test certificate stay under `/tmp`.

The database proof separately holds the real app-session revocation RPC open on one
PostgreSQL connection while an owner mutation starts on another. It requires the
observer to see the blocker in `pg_blocking_pids`, then confirms the mutation is
denied after logout commits. It runs only when the authorized owner is `NULL` and
the task database has no leftover admin sessions, and verifies both baselines on
cleanup. It does not use a sleep as evidence of blocking.

Admin browser state stays in memory. The browser receives only an opaque
`__Host-` Secure, HttpOnly, SameSite cookie; Auth access and refresh tokens remain
encrypted in the private database schema. Mutations require exact Origin, JSON,
and a session-bound CSRF token. Logout revokes the app session first and does not
depend on a successful remote Auth sign-out. Session refresh uses one physical
Auth refresh request after a database claim; do not reintroduce SDK retry behavior
on that path. Refresh and user-verification HTTP transports each have an 8-second
bound; session claim/complete/reconciliation RPCs have 6-second bounds. A refresh
claim older than 45 seconds is conservatively revoked by a session/generation/claim
CAS using database time; the stale result cannot complete or trigger a second Auth
refresh. This leaves bounded reconciliation inside Netlify's 60-second Function
limit and makes a stale browser session require a new login.

The single `/api/admin/session` Function accepts GET for session reads and POST
with the closed `action: "login" | "logout"` body discriminator. Unknown or missing
actions return 400 without authentication or cookie effects. Logout requires the
existing cookie and CSRF token, revokes the app session before remote Auth cleanup,
and clears the cookie only after successful local revocation.

Admin session subscribers receive a closed `reason` value with session changes:
`login`, `logout`, `reauth-required`, or `invalidated`. Cross-tab messages contain
only that reason and the change type; they never carry credentials, CSRF values,
or editorial content. Consumers can treat explicit `logout` as a request to clear
protected editor state, while `reauth-required` preserves drafts for sign-in again.
