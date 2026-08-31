#!/bin/sh
# Download a pinned moonlight-web-stream release after verifying SHA-256.
#
# moonlight-web-stream is GPL-3.0. Gatwy is MIT. This script is opt-in only.
# The default Docker image does not run it and does not embed those binaries.
# Checksums are pinned below. A mismatch or unknown target exits non-zero
# (fail closed). There is no skip / ignore-checksum path.
#
# Usage:
#   fetch-moonlight-web [dest] [version] [arch]
#
# dest defaults to /opt/moonlight-web. The Gatwy entrypoint calls this when
# ENABLE_MOONLIGHT=1.
#
# arch: Docker TARGETARCH (amd64|arm64) or uname -m (x86_64|aarch64).
set -eu

DEST="${1:-/opt/moonlight-web}"
VERSION="${2:-v3.0.0-prerelease.5}"
ARCH_HINT="${3:-${TARGETARCH:-}}"

# GitHub release asset digests for moonlight-web-stream v3.0.0-prerelease.5
# https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/v3.0.0-prerelease.5
PINNED_SHA_x86_64_unknown_linux_gnu=a8371ae6c614d672737cf2fa7dfb61fd46627a45f5c4187480e258e4489327c2
PINNED_SHA_x86_64_unknown_linux_musl=bda8c825db233a50e2500d5bcfd93267ce4d2adc774bd964f325967133ba5b62
PINNED_SHA_aarch64_unknown_linux_gnu=eab9866eec4991db5884d95886cc4f3bec9695fa9e9e052cc64f19b6a72a7226
PINNED_SHA_aarch64_unknown_linux_musl=3f5bb7f1b44f16beaf06f946e7dea29f3cb07834c50e18a5e6a2a1966d1e7023

echo "moonlight-web-stream is licensed under GPL-3.0."
echo "Source:  https://github.com/MrCreativ3001/moonlight-web-stream"
echo "Release: https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/${VERSION}"
echo "Gatwy remains MIT; this download is optional and is not part of the default image."
echo

if [ -z "$ARCH_HINT" ]; then
  ARCH_HINT="$(uname -m)"
fi

detect_libc() {
  if [ -f /etc/alpine-release ]; then
    echo musl
    return
  fi
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    echo musl
    return
  fi
  echo gnu
}

LIBC="$(detect_libc)"

case "$ARCH_HINT" in
  amd64|x86_64)
    # gnu x86_64 does not run on Alpine; v3 publishes musl.
    if [ "$LIBC" = musl ]; then
      ML_ARCH=x86_64-unknown-linux-musl
      EXPECTED_SHA="$PINNED_SHA_x86_64_unknown_linux_musl"
    else
      ML_ARCH=x86_64-unknown-linux-gnu
      EXPECTED_SHA="$PINNED_SHA_x86_64_unknown_linux_gnu"
    fi
    ;;
  arm64|aarch64)
    if [ "$LIBC" = musl ]; then
      ML_ARCH=aarch64-unknown-linux-musl
      EXPECTED_SHA="$PINNED_SHA_aarch64_unknown_linux_musl"
    else
      ML_ARCH=aarch64-unknown-linux-gnu
      EXPECTED_SHA="$PINNED_SHA_aarch64_unknown_linux_gnu"
    fi
    ;;
  *)
    echo "Unsupported architecture: $ARCH_HINT" >&2
    exit 1
    ;;
esac

if [ "$VERSION" != "v3.0.0-prerelease.5" ]; then
  echo "Refusing unpinned moonlight-web-stream version: $VERSION" >&2
  echo "This script only installs v3.0.0-prerelease.5 with a baked-in SHA-256." >&2
  exit 1
fi

if [ -z "$EXPECTED_SHA" ]; then
  echo "No pinned SHA-256 for ${ML_ARCH} ${VERSION}" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download moonlight-web-stream" >&2
  exit 1
fi

sha256_of() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    echo "sha256sum, shasum, or openssl is required to verify the download" >&2
    exit 1
  fi
}

URL="https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/${VERSION}/moonlight-web-${ML_ARCH}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${URL}"
curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused \
  --connect-timeout 15 --max-time 180 \
  -o "$TMP_DIR/mlw.tar.gz" "$URL"

ACTUAL_SHA="$(sha256_of "$TMP_DIR/mlw.tar.gz")"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Checksum mismatch for ${URL}" >&2
  echo "expected ${EXPECTED_SHA}" >&2
  echo "got      ${ACTUAL_SHA}" >&2
  exit 1
fi
echo "SHA-256 OK (${ACTUAL_SHA})"

EXTRACT="$TMP_DIR/extract"
mkdir -p "$EXTRACT"
tar -xzf "$TMP_DIR/mlw.tar.gz" -C "$EXTRACT" --strip-components=1

if [ ! -f "$EXTRACT/web-server" ] && [ -f "$EXTRACT/package/web-server" ]; then
  EXTRACT="$EXTRACT/package"
fi

if [ ! -f "$EXTRACT/web-server" ]; then
  echo "Release archive is missing web-server" >&2
  exit 1
fi

chmod +x "$EXTRACT/web-server"

mkdir -p "$DEST"
cp -a "$EXTRACT"/. "$DEST"/
chmod +x "$DEST/web-server"

echo "moonlight-web-stream installed at $DEST"
echo "Gatwy looks for moonlight-web at /opt/moonlight-web."
