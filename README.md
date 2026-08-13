<div align="center">

# Gatwy
### ![alt text](https://github.com/kotoxie/Gatwy/blob/master/packages/client/public/favicon.png?raw=true)


### Self-host your entire remote access stack in one Docker container — 9 protocols, one interface: RDP, SSH, VNC, Telnet, SMB, SFTP, FTP, MySQL & PostgreSQL.


[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Image Size](https://img.shields.io/endpoint?url=https://gatwy-image-size.gatwy.dev)
[![Latest Release](https://img.shields.io/github/v/release/kotoxie/gatwy?label=release)](https://github.com/kotoxie/gatwy/releases/latest)
[![Docker Image](https://img.shields.io/badge/ghcr.io-kotoxie%2Fgatwy-blue?logo=docker)](https://ghcr.io/kotoxie/gatwy)

**No middleware. No Java. No server relay. WebAssembly-native RDP running directly in your browser — zero overhead across all 9 protocols.**

[Website](https://gatwy.dev) · [Documentation](https://docs.gatwy.dev) · [Gatwy vs Guacamole](https://docs.gatwy.dev/comparison)

</div>

---

## 🚀 Why Gatwy?

Most browser-based remote access tools relay your display through a server-side engine, adding latency and complexity. Gatwy's RDP client runs **entirely in your browser** using WebAssembly — pixel-perfect, low-latency RDP with no middleware, no Java, and no extra containers.

One container. Zero dependencies. Open your browser and connect.

---

## ✨ Highlights

- **9 protocols** — RDP (WebAssembly), SSH, VNC, Telnet, SMB, SFTP, FTP, PostgreSQL, MySQL
- **Split-pane workspace** — unlimited sessions side by side with drag-and-drop tabs
- **Session recording & audit** — encrypted RDP video, SSH asciinema, command-level audit log with auto-redacted passwords, file activity tracking
- **Granular RBAC** — fine-grained permissions, custom roles, per-connection sharing, protocol-level access control
- **Auth flexibility** — local accounts, LDAP/AD, OpenID Connect (SSO), MFA (TOTP), IP access rules
- **Alerting** — SMTP, Telegram, Slack, Webhook channels with a no-code rule builder
- **Encrypted backup & restore** — single-file `.geb` backup with AES-256 encryption

Optional Moonlight/Sunshine (GameStream) can be enabled as one more remote-control protocol — see below.

👉 **[Full feature list →](https://docs.gatwy.dev/features/overview)**

---

## 🐳 Quick Start

```yaml
# docker-compose.yml
services:
  gatwy:
    image: ghcr.io/kotoxie/gatwy:latest
    container_name: gatwy
    restart: unless-stopped
    ports:
      - '7443:7443'
    volumes:
      - ./data:/app/data
    environment:
      - GATWY_ENCRYPTION_KEY=your-64-char-hex-key  # openssl rand -hex 32
      # - ENABLE_MOONLIGHT=1  # optional: fetch moonlight-web-stream (GPL-3.0) on start
```

```bash
docker compose up -d
```

From this repository, `docker compose up --build -d` builds the default image **without** embedding moonlight-web-stream.

Open **`https://<YOUR_IP>:7443`** — on first launch you'll be prompted to create an admin account.

> ⚠️ The browser will warn about the self-signed certificate. Accept the exception to proceed, or [bring your own cert](https://docs.gatwy.dev).

---

## Optional: Moonlight / Sunshine

When the moonlight-web runtime is present, Remote Control includes **Moonlight** next to RDP and VNC. It streams a Sunshine (GameStream-compatible) host in a Gatwy tab. Without that runtime, the protocol reports `available: false` and other protocols are unchanged.

**Enable at runtime.** The default image stays MIT-clean until you opt in. Set one environment variable — that is enough. The entrypoint downloads [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) (GPL-3.0) into `/opt/moonlight-web`, applies Gatwy patches, and Moonlight reports `available: true`.

```yaml
environment:
  - ENABLE_MOONLIGHT=1
```

When `ENABLE_MOONLIGHT` is unset, Moonlight is hidden from the UI (protocol picker and existing Moonlight connections) and reports `available: false`. Connections stay in the database and reappear if you enable it later.

Manual install: `scripts/fetch-moonlight-web.sh` or a [release tarball](https://github.com/MrCreativ3001/moonlight-web-stream/releases) at `/opt/moonlight-web`.

**Use:** create a Moonlight connection (host = Sunshine PC, port `47989`). On first connect, enter the PIN Gatwy shows into the Sunshine web UI (`https://<pc>:47990`). Later connects skip PIN. Forget pairing from the connection editor or session panel to re-pair.

Gatwy turns on Moonlight **Optimize game settings** (`sops`) so Sunshine can follow client width×height. On the host, keep Audio/Video resolution on **client** / **automatic**. Session resolution defaults to Auto (tab size); presets and touch mode are in the right-hand panel (same pattern as RDP).

### Sunshine ports

| Port | Proto | Purpose |
|------|-------|---------|
| 47989 | TCP | GameStream HTTP |
| 47984 | TCP | GameStream HTTPS |
| 47990 | TCP | Sunshine web UI (PIN) |
| 48010 | TCP | RTSP |
| 47998–48000 | UDP | Video / audio / control |

The Gatwy container must reach those ports on the Sunshine PC (same LAN is typical). Browser transport defaults to **WebSocket** on Gatwy’s HTTPS port `7443`. For WebRTC, publish UDP `40000-40100`. Pairing material lives under `/app/data/moonlight-web` plus an encrypted backup in `/app/data/moonlight/pairings/`.

RBAC: `protocols.moonlight` (granted with RDP/VNC on default admin/user roles).

Credits: [Moonlight](https://moonlight-stream.org/), [Sunshine](https://github.com/LizardByte/Sunshine), [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream). License notes: [THIRD_PARTY.md](THIRD_PARTY.md).

---

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `GATWY_ENCRYPTION_KEY` | *(auto-generated file)* | 64-char hex AES-256 key. **Set this in production.** Generate with `openssl rand -hex 32` |
| `PORT` | `7443` | HTTPS port |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | *(auto)* | Custom TLS certificate & key paths |
| `DATA_DIR` | `/app/data` | Database, certs, recordings, and logs |
| `ENABLE_MOONLIGHT` | *(unset)* | Runtime opt-in: `1`/`true`/`yes` fetches moonlight-web-stream (GPL-3.0) on start into `/opt/moonlight-web`. **This is the one env var you need.** |

> ⚠️ If no encryption key env var is set, Gatwy auto-generates one at `/app/data/encryption.key` with a warning banner. Fine for home-lab — not recommended for production.

👉 **[Full configuration reference →](https://docs.gatwy.dev)**

---

## 🔄 Updating

```bash
docker compose pull && docker compose up -d
```

From git:

```bash
git pull
docker compose up --build -d
```

---

## 🛠️ Building from Source

```bash
git clone https://github.com/kotoxie/gatwy && cd Gatwy/

# With Docker (default: Moonlight runtime not bundled)
docker compose up --build -d

# Optional Moonlight/Sunshine: set ENABLE_MOONLIGHT=1 on the container (no rebuild)

# Without Docker (Node.js 22+)
npm install && npm run build && npm start
```

Bare-metal Moonlight needs a moonlight-web-stream install at `/opt/moonlight-web` (see [THIRD_PARTY.md](THIRD_PARTY.md)).

---

## 📄 License

[MIT](LICENSE) — Copyright kotoxie.

Optional Moonlight support uses [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) (GPL-3.0) only when you opt in. See [THIRD_PARTY.md](THIRD_PARTY.md).
