#!/bin/sh
# Download a pinned moonlight-web-stream release and apply Gatwy chrome patches.
#
# moonlight-web-stream is GPL-3.0. Gatwy is MIT. This script is opt-in only —
# the default Docker image does not run it and does not embed those binaries.
#
# Usage:
#   fetch-moonlight-web [dest] [version] [arch]
#
# dest defaults to /opt/moonlight-web. The Gatwy entrypoint calls this when
# ENABLE_MOONLIGHT=1; no extra env vars are required for that path.
#
# arch: Docker TARGETARCH (amd64|arm64) or uname -m (x86_64|aarch64).
set -eu

DEST="${1:-/opt/moonlight-web}"
VERSION="${2:-v2.10.0}"
ARCH_HINT="${3:-${TARGETARCH:-}}"

echo "moonlight-web-stream is licensed under GPL-3.0."
echo "Source:  https://github.com/MrCreativ3001/moonlight-web-stream"
echo "Release: https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/${VERSION}"
echo "Gatwy remains MIT; this download is optional and is not part of the default image."
echo

if [ -z "$ARCH_HINT" ]; then
  ARCH_HINT="$(uname -m)"
fi
case "$ARCH_HINT" in
  amd64|x86_64) ML_ARCH=x86_64-unknown-linux-gnu ;;
  arm64|aarch64) ML_ARCH=aarch64-unknown-linux-gnu ;;
  *)
    echo "Unsupported architecture: $ARCH_HINT" >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download moonlight-web-stream" >&2
  exit 1
fi

URL="https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/${VERSION}/moonlight-web-${ML_ARCH}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${URL}"
curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused \
  --connect-timeout 15 --max-time 180 \
  -o "$TMP_DIR/mlw.tar.gz" "$URL"

EXTRACT="$TMP_DIR/extract"
mkdir -p "$EXTRACT"
tar -xzf "$TMP_DIR/mlw.tar.gz" -C "$EXTRACT" --strip-components=1

# Release layout is package/{web-server,streamer,static}. If strip-components
# was a no-op (flat archive) or left an extra package/ dir, flatten it.
if [ ! -f "$EXTRACT/web-server" ] && [ -f "$EXTRACT/package/web-server" ]; then
  EXTRACT="$EXTRACT/package"
fi

if [ ! -f "$EXTRACT/web-server" ] || [ ! -f "$EXTRACT/streamer" ]; then
  echo "Release archive is missing web-server and/or streamer" >&2
  exit 1
fi

# Upstream tarballs ship the binaries as 0644; the node user must be able to exec.
chmod +x "$EXTRACT/web-server" "$EXTRACT/streamer"

if [ -x "$EXTRACT/web-server" ]; then
  "$EXTRACT/web-server" -V \
    || "$EXTRACT/web-server" --help \
    || "$EXTRACT/web-server" help \
    || true
fi

PATCH_DIR="${MLW_PATCH_DIR:-}"
if [ -z "$PATCH_DIR" ]; then
  if [ -d /opt/gatwy/mlw-patches ]; then
    PATCH_DIR=/opt/gatwy/mlw-patches
  else
    SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    if [ -d "$SCRIPT_DIR/../docker/mlw-patches" ]; then
      PATCH_DIR="$SCRIPT_DIR/../docker/mlw-patches"
    fi
  fi
fi

if [ -n "${PATCH_DIR}" ] && [ -f "$PATCH_DIR/patch-static.sh" ]; then
  echo "Applying Gatwy stream chrome patches from $PATCH_DIR"
  chmod +x "$PATCH_DIR/patch-static.sh" 2>/dev/null || true
  sh "$PATCH_DIR/patch-static.sh" "$EXTRACT/static" "$PATCH_DIR"
else
  echo "No Gatwy mlw-patches directory found; skipped static patches."
fi

mkdir -p "$DEST"
cp -a "$EXTRACT"/. "$DEST"/
chmod +x "$DEST/web-server" "$DEST/streamer"

echo "moonlight-web-stream installed at $DEST"
echo "Gatwy looks for moonlight-web at /opt/moonlight-web."
