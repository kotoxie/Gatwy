# Third-party notices

Gatwy is MIT-licensed. See [LICENSE](LICENSE).

## Optional: moonlight-web-stream (GPL-3.0)

[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) is used only when an operator sets `ENABLE_MOONLIGHT=1` (`true` / `yes` also work).

- It is **not** part of the default Docker image.
- It is **not** vendored in this repository.
- `scripts/fetch-moonlight-web.sh` downloads a **pinned** GitHub release and verifies a baked-in SHA-256. A mismatch or unknown target exits non-zero.

Pinned release: **v2.10.0**

| Asset | SHA-256 |
| --- | --- |
| `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` | `b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb` |
| `moonlight-web-aarch64-unknown-linux-gnu.tar.gz` | `1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a` |
| `moonlight-web-aarch64-unknown-linux-musl.tar.gz` | `f008a5bfee1e22386564d28308bf00bdde0b33732de74a56858bc013942d2bb0` |

Source and license: https://github.com/MrCreativ3001/moonlight-web-stream
