#!/bin/sh
set -e

# Ensure the data directory (which may be a bind-mount owned by root on the
# host) is writable by the node user before dropping privileges.
chown -R node:node /app/data

# Optional opt-in: download moonlight-web-stream (GPL-3.0) at container start.
# Never runs unless ENABLE_MOONLIGHT is 1/true/yes.
ml_flag=$(printf '%s' "${ENABLE_MOONLIGHT:-0}" | tr '[:upper:]' '[:lower:]')
case "$ml_flag" in
  1|true|yes)
    dest="/opt/moonlight-web"
    mkdir -p "$dest"
    # Official x86_64 moonlight-web builds are glibc. gcompat is best-effort on Alpine.
    if [ -f /etc/alpine-release ]; then
      echo "[Gatwy] ENABLE_MOONLIGHT set; installing gcompat for glibc moonlight-web binaries"
      apk add --no-cache gcompat || echo "[Gatwy] WARNING: apk add gcompat failed — moonlight-web may fail to start. Ensure outbound network access is available during container startup, or use a glibc-based host OS."
    fi
    if [ ! -x "$dest/web-server" ] || [ ! -x "$dest/streamer" ]; then
      echo "[Gatwy] ENABLE_MOONLIGHT=$ENABLE_MOONLIGHT: fetching moonlight-web-stream (GPL-3.0) into $dest"
      fetch-moonlight-web "$dest"
    else
      echo "[Gatwy] ENABLE_MOONLIGHT set; moonlight-web already present at $dest"
    fi
    chmod +x "$dest/web-server" "$dest/streamer"
    chown -R node:node "$dest"
    ;;
esac

exec su-exec node "$@"
