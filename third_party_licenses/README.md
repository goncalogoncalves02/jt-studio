# Third-party media codec notices

- `libheif-COPYING.txt`: complete upstream `COPYING` from [strukturag/libheif v1.23.6](https://github.com/strukturag/libheif/blob/v1.23.6/COPYING). Its preamble identifies the library as LGPL-3.0 and includes the GPL-3.0 text as required by the upstream notice. SHA-256: `fa81ce652315b013359d6e8e4744335f31a50c7c192907176d3632f78a3b4596`.
- `libde265-v1.1.3-COPYING.txt`: complete upstream `COPYING` from [strukturag/libde265 v1.1.3](https://github.com/strukturag/libde265/blob/v1.1.3/COPYING). Its preamble identifies the library as LGPL-3.0 and includes the MIT sample-applications notice. SHA-256: `02cc1585a20677992e0ba578fa692635dc193735f2691dc81de924b51c4e8020`.

The current editor decoder is an original adapter and generated ESM/WASM build from the two pinned sources above; `heic-to` was removed from the direct dependency and lockfile. The prior pinned package is retained here only as historical baseline provenance: its `src/lib/libheif.js` build comment stated `Build from libheif 1.23.6 with LIBDE265_VERSION=1.0.16` (SHA-256 `739c935cd332f43676d6c1c5125e12f5bd05152a540c34de90a93e8e536b1290`). The old license text is retained as `libde265-v1.0.16-COPYING.txt`; that package version fell within the affected range for [GHSA-653q-9f73-8hvg / CVE-2026-33165](https://github.com/strukturag/libde265/security/advisories/GHSA-653q-9f73-8hvg); this does not establish a browser exploit. The replacement's compiled provenance is recorded in `src/blog/codecs/heif-codec.manifest.json` and the rebuild runbook; actual worker decoding is exercised in the Task 2 Chromium/WebKit suite, with independent coordinator review pending.

- `jsquash-webp-Apache-2.0.txt`: `@jsquash/webp` 1.5.0, Apache-2.0, npm package integrity `sha512-KggLoj2MnRSfIqTeKe1EmbljTX2vuV7mh79k89PCL1pyqiDULcPM1L47twxXt0hkb68F70bXiL31MxsuoZtKFw==`. Upstream: [jamsinclair/jSquash](https://github.com/jamsinclair/jSquash).
- `jsquash-webp-codec-BSD-3-Clause.txt`: WebP encoder codec notice shipped by the jSquash package.
- `wasm-feature-detect-Apache-2.0.txt`: transitive `wasm-feature-detect` 1.9.0 notice, resolved integrity `sha512-zonE+xlIIYtxPy++L24ow0hAD8CICb4+FgPyROd3buyXIqsJvUEDkBgfCCoXOd1Hu3DUr0GOfnPIdcGV+YpNaA==`.

These packages are loaded by the editor-only worker path. The normal public-site build is checked separately for absence of codec assets.
