# Third-party notices

Gatwy is MIT-licensed. See [LICENSE](LICENSE).

## Bundled: terminal fonts

The SSH terminal font choices are self-hosted from the `@fontsource` packages, so the UI makes no request to Google Fonts and works offline.

| Font | License |
| --- | --- |
| Fira Code | SIL Open Font License 1.1 |
| Source Code Pro | SIL Open Font License 1.1 |
| Inconsolata | SIL Open Font License 1.1 |
| Roboto Mono | SIL Open Font License 1.1 |
| Ubuntu Mono | Ubuntu Font Licence 1.0 |

## Optional: moonlight-web-stream (GPL-3.0)

[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) is used only when an operator sets `ENABLE_MOONLIGHT=1` (`true` / `yes` also work).

- It is **not** part of the default Docker image.
- It is **not** vendored in this repository.
- `scripts/fetch-moonlight-web.sh` downloads a **pinned** GitHub release and verifies a baked-in SHA-256. A mismatch or unknown target exits non-zero.

Pinned release: **v3.0.0**

Alpine (musl) images fetch the musl assets so the binary can run in-process. glibc hosts fetch the gnu assets.

| Asset | SHA-256 |
| --- | --- |
| `moonlight-web-x86_64-unknown-linux-musl.tar.gz` | `86b960f6295f6b8d5f166bceb7e5d97aaadc7a0562a1cf91071d66777c1beadf` |
| `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` | `6b1d679bfd545b7bb0748d02e9617a6abde02223d1957324c6489f6959acac3c` |
| `moonlight-web-aarch64-unknown-linux-gnu.tar.gz` | `7beb0ec95e9feda042878c18ba4363f962cef44ad8dd915bf3d17d7e82b6f733` |
| `moonlight-web-aarch64-unknown-linux-musl.tar.gz` | `7cc619bb232410ec6f35e776b8c642dafd8983ae7ccc6e80dd62586ff2074b64` |

Source and license: https://github.com/MrCreativ3001/moonlight-web-stream
