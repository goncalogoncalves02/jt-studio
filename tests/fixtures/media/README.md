# Image pipeline fixtures

The real camera fixture is a public iPhone XR photo from the `thorsted/digicam_corpus` repository. Its upstream project identifies the dataset as CC0-1.0; the repository license notice is included as `THORSTED-CC0-LICENSE.txt`.

| File | Origin | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `iphone-xr-original.HEIC` | [Apple/iPhone XR/IMG_3578.HEIC](https://raw.githubusercontent.com/thorsted/digicam_corpus/master/Apple/iPhone%20XR/IMG_3578.HEIC), CC0-1.0 | 1,122,310 | `ff8c34fb8e5b953e9aabfad47890368b8b7ffbc1a8edf3f1e6952b6f643e1a35` |
| `loremfile-640x480.avif` | [loremfile.dev AVIF sample](https://loremfile.dev/avif/640x480.avif), published as a CC0 test sample | 1,284 | `c8e3c01650f906bed2073056b23fdaf3f7373b23bbb4ad006d8b06ef30d7c681` |

The oriented JPEG, alpha PNG, and small WebP are synthetic test-only images generated locally with Pillow. They contain no user or camera data. Their current SHA-256 values are recorded in the Task 2 execution report.

The public camera fixture is a reproducible codec/quality fixture, not a user-provided photograph or a real-device editor acceptance test. Tests do not print or retain its embedded metadata.
