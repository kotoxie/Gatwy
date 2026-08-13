# Third-party components

Gatwy is licensed under the [MIT License](LICENSE) (Copyright kotoxie).

## moonlight-web-stream (optional)

[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) is licensed under **GPL-3.0**.

It is **not** part of Gatwy’s default source tree or default Docker image. Gatwy only downloads those binaries when you opt in:

- **Runtime:** set `ENABLE_MOONLIGHT=1` on the container. That one env var is enough — the entrypoint fetches moonlight-web-stream into `/opt/moonlight-web`.
- **Manual / bare metal:** `scripts/fetch-moonlight-web.sh` or a [release tarball](https://github.com/MrCreativ3001/moonlight-web-stream/releases) installed at `/opt/moonlight-web`.

Pinned release used by the opt-in helper: **v2.10.0**.

Without that runtime, the Moonlight protocol reports `available: false` and is hidden from the UI. Other protocols are unchanged.

Related projects: [Moonlight](https://moonlight-stream.org/), [Sunshine](https://github.com/LizardByte/Sunshine).
