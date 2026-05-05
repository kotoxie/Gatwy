<div align="center">

# Gatwy
### ![alt text](https://github.com/kotoxie/Gatwy/blob/master/packages/client/public/favicon.png?raw=true) 


### Lightning-fast, self-hosted remote access — RDP, SSH, VNC, Telnet, SMB, SFTP, FTP, PostgreSQL & MySQL in one Docker container.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Image Size](https://img.shields.io/endpoint?url=https://gatwy-image-size.gatwy.dev)
[![Latest Release](https://img.shields.io/github/v/release/kotoxie/gatwy?label=release)](https://github.com/kotoxie/gatwy/releases/latest)
[![Docker Image](https://img.shields.io/badge/ghcr.io-kotoxie%2Fgatwy-blue?logo=docker)](https://ghcr.io/kotoxie/gatwy)

**No Web-sockets. No middleware. No Java. Just raw WebAssembly RDP at full speed.**

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
- **Granular RBAC** — 27 fine-grained permissions, custom roles, per-connection sharing, protocol-level access control
- **Auth flexibility** — local accounts, LDAP/AD, OpenID Connect (SSO), MFA (TOTP), IP access rules
- **Alerting** — SMTP, Telegram, Slack, Webhook channels with a no-code rule builder
- **Encrypted backup & restore** — single-file `.geb` backup with AES-256 encryption

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
```

```bash
docker compose up -d
```

Open **`https://<YOUR_IP>:7443`** — on first launch you'll be prompted to create an admin account.

> ⚠️ The browser will warn about the self-signed certificate. Accept the exception to proceed, or [bring your own cert](https://docs.gatwy.dev).

---

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `GATWY_ENCRYPTION_KEY` | *(auto-generated file)* | 64-char hex AES-256 key. **Set this in production.** Generate with `openssl rand -hex 32` |
| `PORT` | `7443` | HTTPS port |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | *(auto)* | Custom TLS certificate & key paths |
| `DATA_DIR` | `/app/data` | Database, certs, recordings, and logs |

> ⚠️ If no encryption key env var is set, Gatwy auto-generates one at `/app/data/encryption.key` with a warning banner. Fine for home-lab — not recommended for production.

👉 **[Full configuration reference →](https://docs.gatwy.dev)**

---

## 🔄 Updating

```bash
docker compose pull && docker compose up -d
```

---

## 🛠️ Building from Source

```bash
git clone https://github.com/kotoxie/gatwy && cd Gatwy/

# With Docker
docker compose up --build -d

# Without Docker (Node.js 20+)
npm install && npm run build && npm start
```

---

## 📄 License

[MIT](LICENSE)
