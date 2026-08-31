# Third-party notices

Gatwy is MIT-licensed. See [LICENSE](LICENSE).

## Optional: moonlight-web-stream (GPL-3.0)

[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) is used only when an operator sets `ENABLE_MOONLIGHT=1` (`true` / `yes` also work).

- It is **not** part of the default Docker image.
- It is **not** vendored in this repository.
- `scripts/fetch-moonlight-web.sh` downloads a **pinned** GitHub release and verifies a baked-in SHA-256. A mismatch or unknown target exits non-zero.

Pinned release: **v3.0.0-prerelease.5**

Alpine (musl) images fetch the musl assets so the binary can run in-process. glibc hosts fetch the gnu assets.

| Asset | SHA-256 |
| --- | --- |
| `moonlight-web-x86_64-unknown-linux-musl.tar.gz` | `bda8c825db233a50e2500d5bcfd93267ce4d2adc774bd964f325967133ba5b62` |
| `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` | `a8371ae6c614d672737cf2fa7dfb61fd46627a45f5c4187480e258e4489327c2` |
| `moonlight-web-aarch64-unknown-linux-gnu.tar.gz` | `eab9866eec4991db5884d95886cc4f3bec9695fa9e9e052cc64f19b6a72a7226` |
| `moonlight-web-aarch64-unknown-linux-musl.tar.gz` | `3f5bb7f1b44f16beaf06f946e7dea29f3cb07834c50e18a5e6a2a1966d1e7023` |

Source and license: https://github.com/MrCreativ3001/moonlight-web-stream
