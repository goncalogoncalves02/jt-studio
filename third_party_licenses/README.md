# Third-party media codec notices

- `heic-to-LGPL-3.0.txt`: `heic-to` 1.6.6, LGPL-3.0, npm package integrity `sha512-PYpOtPFEzgPxIoGF4LQ+oBD8o/tMvcFDNynrNzK1fLXfE6mTe2W+AHOvBKc5MwnVak4/Pnb51g9CJAtWL5YGWA==`. The package README states that it includes libheif 1.23.6. Upstream: [hoppergee/heic-to](https://github.com/hoppergee/heic-to).
- `jsquash-webp-Apache-2.0.txt`: `@jsquash/webp` 1.5.0, Apache-2.0, npm package integrity `sha512-KggLoj2MnRSfIqTeKe1EmbljTX2vuV7mh79k89PCL1pyqiDULcPM1L47twxXt0hkb68F70bXiL31MxsuoZtKFw==`. Upstream: [jamsinclair/jSquash](https://github.com/jamsinclair/jSquash).
- `jsquash-webp-codec-BSD-3-Clause.txt`: WebP encoder codec notice shipped by the jSquash package.
- `wasm-feature-detect-Apache-2.0.txt`: transitive `wasm-feature-detect` 1.9.0 notice, resolved integrity `sha512-zonE+xlIIYtxPy++L24ow0hAD8CICb4+FgPyROd3buyXIqsJvUEDkBgfCCoXOd1Hu3DUr0GOfnPIdcGV+YpNaA==`.

These packages are loaded by the editor-only worker path. The normal public-site build is checked separately for absence of codec assets.
