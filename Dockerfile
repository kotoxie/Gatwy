# Stage 1: Build — always runs on the host's native platform so tsc/vite aren't QEMU-emulated
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install all dependencies (--ignore-scripts skips native compilation, safe for TS build stage)
RUN npm install --ignore-scripts

# Copy source
COPY tsconfig.base.json ./
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

# Build client then server
RUN npm run build --workspace=packages/client
RUN npm run build --workspace=packages/server

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies (su-exec for privilege drop in entrypoint — pure C, no Go)
RUN apk add --no-cache ca-certificates curl su-exec openssl

# Opt-in fetch helper only. moonlight-web-stream is NOT copied into the image.
# ENABLE_MOONLIGHT=1 downloads a pinned release at container start.
COPY scripts/fetch-moonlight-web.sh /usr/local/bin/fetch-moonlight-web
RUN chmod +x /usr/local/bin/fetch-moonlight-web

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
# cpu-features (ssh2 optional dep) skipped — ssh2 works without it; avoids hours of QEMU ARM64 compilation
RUN npm install --omit=dev --ignore-scripts --workspace=packages/server

# Copy built server
COPY --from=builder /app/packages/server/dist packages/server/dist/

# Copy built client
COPY --from=builder /app/packages/client/dist packages/client/dist/

# Pre-create data directory with correct ownership BEFORE declaring VOLUME.
# Docker initialises the volume mount from the image layer at this path;
# setting ownership here is preserved when an anonymous/named volume is first
# created.  For bind-mounts the host directory must be writable by uid 1000.
RUN mkdir -p /app/data && chown -R node:node /app

# Copy entrypoint — runs as root, chowns /app/data, then drops to node user
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7443

VOLUME /app/data

ENV DATA_DIR=/app/data
ENV NODE_ENV=production
# @marsaud/smb2 uses ntlm which calls DES-ECB — a legacy cipher disabled in OpenSSL 3.
# Enable the OpenSSL legacy provider so SMB NTLM authentication works on modern Node runtimes.
ENV NODE_OPTIONS="--openssl-legacy-provider"

# start-period covers first-boot ENABLE_MOONLIGHT fetch (~15MB) before listen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsk https://localhost:7443/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
