# Stage 1: Build
# moonlight-web-stream glibc binaries need GLIBC_2.38+; bookworm is 2.36.
# node:22-noble is not published — use Debian trixie (glibc ≥ 2.39) so the
# optional Moonlight runtime can load when ENABLE_MOONLIGHT=1. Default builds
# do not embed those binaries.
FROM node:22-trixie-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install all dependencies
RUN npm install

# Copy source
COPY tsconfig.base.json ./
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

# Build client then server
RUN npm run build --workspace=packages/client
RUN npm run build --workspace=packages/server

# Stage 2: Production
FROM node:22-trixie-slim

WORKDIR /app

# Runtime deps: curl/ca-certs for healthcheck and optional MLW fetch
# (ENABLE_MOONLIGHT=1), gosu for privilege drop, openssl for TLS helpers,
# libgcc-s1 for the moonlight-web gnu binaries when they are fetched at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gosu openssl libgcc-s1 \
  && rm -rf /var/lib/apt/lists/*

# Gatwy chrome patches + fetch helper. Patches are MIT Gatwy code; the
# moonlight-web-stream binaries (GPL-3.0) are only downloaded when opted in.
COPY docker/mlw-patches/ /opt/gatwy/mlw-patches/
COPY scripts/fetch-moonlight-web.sh /usr/local/bin/fetch-moonlight-web
RUN chmod +x /usr/local/bin/fetch-moonlight-web /opt/gatwy/mlw-patches/patch-static.sh

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm install --omit=dev --workspace=packages/server

# Copy built server
COPY --from=builder /app/packages/server/dist packages/server/dist/

# Copy built client
COPY --from=builder /app/packages/client/dist packages/client/dist/

# Pre-create data directory with correct ownership BEFORE declaring VOLUME.
RUN mkdir -p /app/data && chown -R node:node /app \
  && if [ -d /opt/moonlight-web ]; then chown -R node:node /opt/moonlight-web; fi

# Copy entrypoint — runs as root, chowns /app/data, then drops to node user
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7443
# Optional WebRTC UDP range when not using WebSocket transport
EXPOSE 40000-40100/udp

VOLUME /app/data

ENV DATA_DIR=/app/data
ENV NODE_ENV=production
# @marsaud/smb2 uses ntlm which calls DES-ECB — a legacy cipher disabled in OpenSSL 3.
ENV NODE_OPTIONS="--openssl-legacy-provider"

# start-period covers first-boot ENABLE_MOONLIGHT fetch (≈15MB GitHub) before listen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsk https://localhost:7443/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
