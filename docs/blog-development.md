# Blog development and verification

> **Task 8, verified locally on 24 November 2026.** See [the handoff](blog-handoff.md)
> for the migration, gate evidence and the pending Netlify integration.
>
> **Estado em 13 de outubro de 2026:** etapas 1–6 aceites localmente no commit `eb2d5a7e7f53d8db0f624a20e49556219d546f49`, após revisão independente. A Task 7 foi implementada e os gates locais terminaram; aguarda revisão independente do coordenador, sem aceitação declarada. A implementação usa deadline partilhado de 48 s por pedido de Function, limitado pelos tetos existentes de 6/8/12 s dos transports, progresso persistente por objeto e claim durável de dispatch. Gates: 143 unitários, 6 gates SQL em PostgreSQL 17.11, concorrência física com `pg_blocking_pids`, E2E local Functions/Auth/Storage e hook stub, lint, build legacy, 3 legacy, 29 browser, fixtures vazia/publicada e checker limpo de 100 artigos. No E2E local, seis pedidos demoraram 1,949 s no total, cada um 269–398 ms; o stub recebeu e aceitou exatamente um POST. Estes tempos medem apenas o ambiente local. CI remoto, hook real, cloud, produção e dispositivo físico não foram verificados. Evidência Task 7 em `.superpowers/sdd/2026-10-11-blog-editorial/task7-implementation-20261013/`.

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

`npm run build` is the Netlify production command and requires a slot-acquired,
confirmed release. Use `npm run build:legacy` for the legacy local site. The separate
`npm run build:fixture` command explicitly selects the synthetic empty release in
`tests/fixtures/empty-release.json`; `npm run build:fixture:published` explicitly
selects the two-post test fixture. Both are test-only and are not production
publication commands. Browser tests generate a separate 100-post synthetic release
in memory through `npm run build:fixture:browser`; each body has a unique sentinel.

The fixture build creates a client Vite output and a separate SSR output, then writes
static documents for the five existing routes, `/blog`, every published fixture
post, `/admin`, and `404.html`. It also writes directory-index aliases for the four
non-home legacy routes with a trailing slash. Article data is split into a summary
index and one versioned JSON file per post. The public release manifest contains
only releaseId, deployId, digest, and schema. Release SHA-256 validation covers the
exact stored payload text; the build does not reserialize that payload to verify it.
Task 8 adds confirmed-release sourcing via `scripts/production-release.mjs` (`npm run build` runs `node scripts/build-blog.mjs --mode production`, while `npm run build:legacy` preserves the pre-blog client build). Production builds require `CONTEXT=production`, `BRANCH=main`, `DEPLOY_ID`, matching
`SITE_ID` and `BLOG_NETLIFY_SITE_ID`, `BLOG_PUBLIC_ORIGIN`, and
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. Use `BLOG_PUBLIC_STORAGE_ORIGIN`
when its HTTPS origin differs from `SUPABASE_URL`. Configure
`BLOG_NETLIFY_API_TOKEN` for reconciliation in the production build and Functions.
Keep privileged variables scoped to the server and the builds that need them.

### Task 8 build-slot operation and recovery

- **Serialized build slot:** Both `main` code builds and editorial hook builds acquire `blog_private.build_slot` via `blog_build_acquire` before reading an immutable release, and re-verify `blog_build_assert_current` before concluding. While a code build holds the slot, editorial confirmation (`blog_freeze_release`) is blocked (`40001`). While an editorial request holds the slot, only a strictly URL-decoded `INCOMING_HOOK_BODY` matching `{ requestId, releaseId, attemptId }` can acquire the build; hooks without a body or malformed payloads fail closed.
- **Reconciliation (`POST /api/admin/publication/reconcile`):** Reads slot/request context in a short DB call, queries `GET /api/v1/deploys/{deploy_id}` and `GET /api/v1/sites/{site_id}` on `https://api.netlify.com` (`redirect: 'error'`, no DB locks held across HTTP), and commits via generation-fenced CAS (`blog_publication_reconcile_commit`).
- **`unknown` and interrupted builds:** Timeouts, 404s, wrong site/context/branch, or ready-but-unpublished deploys keep the slot blocked and never write `unknown` as `failed`. If a build is interrupted or its hook response was lost without a known `DEPLOY_ID`, the slot remains blocked (`unknown` is never retried automatically or via `retry`); an operator must inspect the Netlify site deploys/hook logs manually to obtain the `DEPLOY_ID` or confirm no deploy was created before any manual recovery. Only provider terminal failure (`error`/`rejected`/`canceled`/`cancelled` with a valid different `published_deploy.id`) clears the build identity as `failed` while keeping `active_request_id` reserved and preserving `last_published_release_id`.
- **Explicit retry:** Only the active `failed` request (`active_request_id === requestId`, `active_deploy_id === null`, and `release_id === latest_confirmed_release_id`) can be retried via `POST /api/admin/publication/retry`, preserving the original confirmed snapshot (`release_id`) and issuing a fresh attempt. Historical inactive failed requests and ambiguous `unknown` states are rejected.
- **Live confirmation:** Marking `live` requires `state === 'ready'`, `site.published_deploy.id === deployId`, and a matching `/blog-release.json` (`releaseId`, `deployId`, `digest`, `schema: 1`) on `BLOG_PUBLIC_ORIGIN`.

A subsequent production build or editorial confirmation can reconcile a preceding
code build. Missing production credentials or inconclusive provider evidence leave
the existing reservation in place. An operator needs separate approval before
repairing production state manually.

Run `npm run test:db -- build-slot` and
`npm run test:e2e -- tests/e2e/publication.spec.js` against the task-owned local
Supabase. The E2E uses a loopback provider, generates a production artefact in a
temporary directory and revokes only its own fixture authority. This gate leaves
the real Netlify publication and atomic deploy contract pending.
`vite.config.js` remains unchanged because its existing React SWC and Tailwind plugins
are used by both builds; `build-blog.mjs` supplies the independent output directories,
root, base path, and SSR entry through Vite's per-build options.

## Verification commands

Run these from the repository root with Node 24.21.0:

- `npm run lint` — full ESLint gate; passed for the accepted Task 6 tree.
- `npm run build` — Netlify production build from the immutable confirmed release.
- `npm run build:legacy` — local build of the original site for legacy verification.
- `npm run build:fixture` — explicit synthetic-release client/SSR rendering proof.
- `npm run test:unit` — discovers every `tests/unit/*.test.mjs` module, covering metadata, script-safe bootstrap serialization, and raw HTML for all five existing routes. Requires a successful `npm run build:fixture` immediately beforehand; legacy-build artifact checks are kept under `tests/legacy/` so this gate stays fixture-only.

## Editorial panel

The article list retrieves up to 20 summaries. It fetches a body and its media
only when the editor opens that article. Saves use a single queue against the
last acknowledged revision. A conflict preserves the latest local text and
requires the editor to review the current saved revision before applying changes.

Run `npm run build:fixture` before
`npm run test:e2e -- tests/e2e/editor.spec.js tests/e2e/accessibility.spec.js`.
The proof uses the actual Function handlers with local Auth, Storage and PostgreSQL.
The Netlify provider is simulated. Browser checks cover 390 px and 1440 px
layouts, keyboard controls, and axe on the panel. Device and VoiceOver acceptance
remain separate.

The public entry graph check runs during each site build. The deployed source
references, build instructions and licence notices for the image codecs are under
`/codec-notices/`. The worker rejects native WebP variants that carry metadata
and uses the existing WebAssembly encoder for those images.

## Image processing

The editor image pipeline is isolated under `src/blog/` and runs in a module worker. `validateInputImage(file)` checks the byte signature and bounded header dimensions; HEIF/AVIF top-level boxes are scanned by file offset within a 4,096-box budget, reading only bounded `ftyp` and `meta` boxes and rejecting duplicate metadata before decoder loading. `optimizeImage(file, { signal, onProgress })` decodes one image, strips source metadata by drawing pixels to canvas, and returns SHA-256 identified WebP variants at distinct eligible widths 480, 960, and the master width. The master is capped by its longest side at 1,600 pixels; variants preserve aspect ratio and never enlarge. Inputs above 30 MiB, 12,000 pixels on either axis, or 60 megapixels are rejected before full bitmap decoding when their headers contain dimensions. HEIC/HEIF is handled by the task-local generated ESM/WASM adapter under `src/blog/codecs/`; it is built from libheif 1.23.6 with libde265 1.1.3, selects the primary image, and loads only when the worker receives HEIC/HEIF. The pinned-source provenance, source archive digests, compiler identity, adapter interface, and exact build flags are maintained beside the explicit rebuild script and in the Task 2 report. Ordinary site builds consume the checked-in generated codec files and do not download source or compile C++. AVIF continues through the browser decoder when available. Native WebP output is accepted only when its MIME and RIFF signature both match; otherwise the locally bundled `@jsquash/webp` 1.5.0 WASM encoder is used. WASM quality is converted from the pipeline's native 0–1 scale to jSquash's 0–100 scale.

The measured landscape iPhone XR CC0 sample at `tests/fixtures/media/iphone-xr-original.HEIC` produced widths 480, 960, and 1600 at initial quality 0.84, all below their 128, 256, and 512 KiB targets in the recorded Chromium run. For a 3024×4032 portrait, the corresponding variants are 480×640, 960×1280, and 1200×1600. Quality may descend to 0.78 to reach each target; each returned variant also enforces the 1 MiB upload ceiling. See `tests/fixtures/media/README.md`, `third_party_licenses/README.md`, and the ignored `.superpowers/sdd/2026-10-11-blog-editorial/task2-report.md` for fixture, license, and measured browser details. The public sample and desktop browser tests do not establish manual iPhone/Safari editor acceptance.

Public routes must keep editor and codec code out of their client entry graph. Browser proofs build a private test harness from the same worker entry and use the normal production build output. Run Chromium with `PLAYWRIGHT_BROWSERS_PATH` set to a local Playwright cache. For the local WebKit host-library overlay only, set it to the task-owned browser-cache overlay under `/tmp`; that overlay is a test-runtime prerequisite and is not an application dependency. Do not add machine-specific paths to project configuration.

### Rebuilding the HEIC decoder

The checked-in codec artifact is regenerated only by the separate, explicit Task 2 codec build command documented in `scripts/build-heif-codec/README.md`; routine site builds and Netlify must not invoke it. The approved local build runtime is the official `emscripten/emsdk` image for release 6.0.12, pinned to the verified `linux/amd64` image manifest digest in that runbook. The source inputs are the exact libheif v1.23.6 and libde265 v1.1.3 archives with recorded upstream commit IDs and SHA-256 digests. Build compilation runs offline after host-side source/archive verification, as the host has no CMake or Emscripten toolchain.

All pre-existing Docker resources are protected. The initial local inventory records 7 containers, 236 volumes, and 197 images; the named services/containers are preserved in the task's ignored evidence. Before creating the compiler container, refresh that inventory and compare it with the recorded protected state. This Docker Desktop daemon cannot bind-mount the host `/tmp`, so the build uses `docker cp` to place verified archives/scripts in one explicitly named and labelled task-owned ephemeral container's writable layer; compilation has no mounts. The container runs as non-root host UID/GID with `--network none`, at most 2 CPUs and 3 GiB memory on the current daemon, and no ports, named volumes or Docker socket. Record the exact container ID and build output before removing only that container by ID. Never prune Docker resources, remove images/volumes, or stop other services as part of this task. The local Docker Desktop runtime and temporary source/build directories are development/test prerequisites, not application dependencies.

- `npm run test:legacy` — confirms that the legacy Vite output still contains its original raw metadata and BeautySalon JSON-LD. Run after `npm run build:legacy`. Its artifact-dependent test lives outside the unit-test discovery directory.
- `node scripts/check-public-artifacts.mjs` — route metadata, structured data, versioned data, sitemap, hydration payload, cache rules, and public bundle boundary checks. Run after either fixture build.
- `npm run build:fixture:published` followed by `node scripts/check-public-artifacts.mjs dist/published-fixture/manifest.json` — validates the two-post release fixture independently.
- `npm run test:browser -- tests/browser/public-blog.spec.js` — runs the public pages against a generated 100-post fixture using the scoped `scripts/static-test-server.mjs`. The server serves existing files first, then returns a real 404 for missing blog/admin paths; it is a local static-hosting equivalent, not evidence from Netlify.

The public renderer accepts only DocumentV1 nodes and promoted `blog-public`
Storage URLs. SQL release posts retain immutable public object keys without URLs.
The renderer constructs the public URLs from those keys after the editorial slot
verifies that media promotion is complete. It verifies the digest of the exact
stored payload text. Per-post browser navigation requests only that versioned post JSON, not
the other article bodies. The `/admin` HTML shell has no private data, carries
`noindex, nofollow` in its metadata and headers, and stays outside the sitemap.
The editor and codecs load through the authenticated panel's lazy entry points.

Generated `/blog/*` files take priority over the Netlify 404 redirect, and missing
static blog files follow `/blog/* /404.html 404` before the SPA fallback. `_headers`
gives HTML and the release manifest revalidation headers, while `/blog-data/*`
uses immutable caching; selectors remain disjoint so Cache-Control values are not
concatenated. Netlify file-shadowing/404 behavior is based on the pinned official
documentation but was not tested against a remote site. The local fixture server
proves the expected HTTP statuses without deploying. The service anchors preserve
hash scrolling through React navigation, including the fixed navbar offset.
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

Task 5 keeps `storage-api` excluded from the Supabase CLI lifecycle: the pinned
CLI's Storage spec omits a user and cgroup limits, and the pinned upstream Storage
image has no default `USER`. Do not run it through `supabase start` or as root. The
Task 5 runner accepts only `supabase/storage-api:v1.79.36` at linux/amd64 digest
`sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154` and
the exact existing task bridge ID. Before the first image pull or Engine create,
compare full protected container IDs and all volume names with the saved Task 3
inventory, and verify the exact four Task 3 container IDs, bridge ID/options,
loopback listeners, and current free space. The only new volume name allowed is
`supabase_storage_jt-studio-blog-tests`, created with labels
`org.jt-studio.project=jt-studio-blog-tests` and
`org.jt-studio.task=blog-editorial-task5`; on a fresh runtime, if it already
exists, fail closed and preserve it. The Storage service is created only through
the Task 5 Docker request guard: `User=1000:1000`, one CPU, 768 MiB memory with
swap capped to 768 MiB,
`PidsLimit=256`, `CapDrop=ALL`, `no-new-privileges`, read-only root filesystem,
and a 64 MiB `/tmp` tmpfs owned by UID/GID 1000. It mounts only that task-owned
volume at `/mnt`, uses the bridge's `storage` alias, and publishes no host ports.
Its process UID/GID and every limit are re-read after start; health must pass on
the internal port 5000. The healthcheck runs the image's Node 24 directly and
requires a successful `/status` response within a 1.5-second abort window; it
does not depend on shell or wget options. Failure of any check stops Task 5
before serving requests.

The new volume initially has a root-owned, empty mountpoint. A single finite
initializer container is allowed only after the volume was proven absent from the
pre-create inventory and the new volume's exact name, driver, and labels were
verified. It uses the same image with no network, no published ports, no secrets,
one CPU, 128 MiB memory and equal swap, and only `CAP_CHOWN`. Its fixed command
checks that `/etc/passwd` maps `node` to UID/GID 1000 and that `/mnt` is an empty,
root-owned directory; it changes ownership of `/mnt` itself only, never recursively.
Both newly created volume mounts set Docker Engine `VolumeOptions.NoCopy=true`;
the create proxy rejects a missing or false value. This prevents a later container
create from copying the image mountpoint metadata back over the initialized volume.
The initializer must exit successfully before Storage starts. Keep its stopped
container and the volume for diagnosis; no `--rm`, volume removal, prune, or GC is
permitted. If the volume exists already, is non-empty, or has unexpected ownership,
fail closed without changing it. Do not add write permissions to other paths to
work around a read-only-root failure; demonstrate any required temporary path and
bound it before a reviewed change.

The first reviewed Task 5 run created a pinned volume and two containers, then the
service exited with `EACCES` on `/mnt/stub`. For this one known partial run, the
coordinator-approved `node scripts/supabase-storage-local.mjs resume` path may
resume only the original full IDs recorded in the ignored runtime state:
initializer `fc07c13392c9b099a44ac67f3d175dd87980513a907596b62c71fd01774417bc`
and service `64db731c94b829cd30427a0b30630e5979e17f15d157d297ac13d7fe0a5910e1`.
Before each start it compares the complete protected and task inventories, exact
names/labels/image digest/network/volume, state and runtime limits. The stopped
service's complete `HostConfig`/`NetworkSettings` must point only at the task
bridge; the initializer must have `NetworkMode=none` and exactly Docker's
`Networks` key `none`. While Storage is stopped, the bridge endpoint inventory
must contain exactly the four Task 3 IDs; after Storage is healthy, it must
contain those four IDs plus the exact Storage service ID. It derives the service
environment from current task config and local Supabase status, merges the pinned
image defaults, and compares both containers' actual environment in memory
without logging, hashing, or persisting values. It also reads the raw `/mnt`
archive to require one empty root-owned directory before
the initializer. It starts that exact
finite initializer, then reads the archive again and requires an empty UID/GID
1000:1000 directory before starting the existing service. It creates no resources
and performs no database or Storage writes. The old containers predate the
NoCopy fix, so their inspected mount option may be absent or false only for those
two exact IDs; new Engine creates must still carry `NoCopy=true`. Source review of
the pinned Moby v29.8.0 implementation confirms volume population happens during
container creation, not Start. If any identity, inventory, empty-directory,
ownership, or health check fails, stop and preserve the current resources and
runtime state. Keep the resume lock and all evidence; never retry by recreating,
deleting, pruning, or weakening container limits. If the same recovery has already
started the service but its final local verification was interrupted, use only
`node scripts/supabase-storage-local.mjs verify-existing`. That read-only path
requires the exact saved IDs and resume lock, validates the complete protected
inventory/config/environment/network/runtime state and actual non-root process,
and does not require the mount to remain empty after Storage creates its `stub`
directory. It performs no lifecycle or Storage/DB writes; never rerun `resume` on
an already-running service.

Task 5 creates private `blog-drafts` and public `blog-public` buckets, each limited
to WebP and 1 MiB. The private Storage policies require the configured editor,
an unexpired application session mapped to the JWT `session_id`, and the matching
live `auth.sessions` row. The BFF never returns Auth JWTs or signed private URLs.
It uploads the largest Task 2 variant first; the trusted recorder fixes that
master's dimensions and expected width set in the private schema, then accepts only
matching smaller variants. A missing/failed variant cannot complete the group.
Completion and preview revalidate the originally captured app/provider session;
preview repeats that check after the physical Storage download. Public promotion
is an internal server operation gated by references in the latest confirmed
release, never a browser route.

Generate the Task 5 migration name with the pinned Supabase CLI before applying it.
Do not use `supabase start` to add Storage to the existing partial stack; use only
the Task 5 scoped runtime runner and the normal migration command after its exact
resource checks pass. Preserve every created Storage resource and uploaded object
on failure for review; no media cleanup or garbage collection is part of this task.

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
complete Task 3 stack and starts only the four recorded full container IDs; the
Task 5 Storage extension is separately guarded and does not invoke CLI startup;
`migrate` applies pending migrations to a ready local database. Normal test runs
must not provision or reset their database. Resume fails closed for partial
stacks, changed IDs, labels, bridge, ports, mounts, protected inventories, or
unexpected listeners. It starts DB, verifies PostgreSQL 17 health, then resumes
Auth, PostgREST, and Kong and checks local Auth/PostgREST readiness. Resume does
not create or remove containers, networks, or volumes. Storage resume/start may
operate only on the exact Task 5 container and volume after validating their full
IDs, task labels, pinned image, runtime UID, security settings, mounts, and health;
it never touches the four Task 3 IDs or any protected resource.

The two resume runners use the historical protected inventory and can use a
separately reviewed full snapshot at `/tmp/jt-studio-protected-docker-resume.json`.
The reviewed file must contain all original identities and match the current
Docker container and volume inventory exactly once the pinned blog resources
are included. Preserve the old snapshot. Review changes to the inventory before
using a new snapshot. Keep the reviewed file private and outside Git.

When the existing Storage volume has already been initialized, run
`node scripts/supabase-storage-local.mjs restart-service` after the four backend
containers are healthy. This verifies the original completion record, container
identity, configuration and initialized volume, starts only the pinned Storage
service, then checks health and the inventory again. The original empty-volume
recovery command remains available for its original failure state.

The migration action verifies the exact project, DB container labels and loopback
binding, CLI version, and local DB URL; it never accepts a linked project or an
explicit connection URL. Keep the proxy's prune and volume-delete denials enabled.
Do not fall back to cloud or touch any pre-existing database. Task-local database
concurrency proofs use two physical PostgreSQL connections and `pg_blocking_pids`;
no SQL transaction may remain open across Auth, Storage, or HTTP work.

Run Task 3 behavior gates only against that ready local project:

```sh
node scripts/test-db.mjs editorial editorial-inputs guard-mutations publication
node scripts/test-db.mjs publication-dispatch
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

Task 7 adds `publication-dispatch` to the same scoped transactional runner. The
runner records the full server version (the current local database is PostgreSQL
17.11). The Task 3 publication SQL fixture creates random request IDs per run and
uses a transaction-local helper to mark only its captured owner/request/release/
generation as failed and release that exact slot, only when there is no dispatch
claim. It checks one affected row at each transition; the enclosing SQL test rolls
back, and the runner compares the complete owner/build-slot/request/release/post/
media/session mementos before and after. Immutable release/request history is
retained. Never reuse a fixed historical request or clear a slot by request ID
alone.

Task 7 publication Functions start one 48-second request deadline. Existing
per-transport caps stay at 6 seconds for service fetches, 8 seconds for Auth, and
12 seconds for the publication hook; each transport observes both its cap and the
remaining shared deadline, and abort completion is awaited before the Function
responds. After a durable dispatch claim, the Function rechecks the same captured
app/provider session, slot, request, release, generation, and claimed attempt
through the narrow status RPC before sending the hook. A failed or ambiguous
check keeps the claim unresolved and sends no POST. The hook counts as `queued` only after a successful POST response;
ambiguous or lost responses remain `unknown` and are never automatically retried.
Local E2E uses the controlled hook stub and does not contact Netlify.

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
