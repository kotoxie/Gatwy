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
VERSION="${2:-v2.10.0}"
ARCH_HINT="${3:-${TARGETARCH:-}}"

# GitHub release asset digests for moonlight-web-stream v2.10.0
# https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/v2.10.0
PINNED_SHA_x86_64_unknown_linux_gnu=b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb
PINNED_SHA_aarch64_unknown_linux_gnu=1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a
PINNED_SHA_aarch64_unknown_linux_musl=f008a5bfee1e22386564d28308bf00bdde0b33732de74a56858bc013942d2bb0

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
    # Upstream does not publish an x86_64 musl tarball for v2.10.0.
    ML_ARCH=x86_64-unknown-linux-gnu
    EXPECTED_SHA="$PINNED_SHA_x86_64_unknown_linux_gnu"
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

if [ "$VERSION" != "v2.10.0" ]; then
  echo "Refusing unpinned moonlight-web-stream version: $VERSION" >&2
  echo "This script only installs v2.10.0 with a baked-in SHA-256." >&2
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

if [ ! -f "$EXTRACT/web-server" ] || [ ! -f "$EXTRACT/streamer" ]; then
  echo "Release archive is missing web-server and/or streamer" >&2
  exit 1
fi

chmod +x "$EXTRACT/web-server" "$EXTRACT/streamer"

mkdir -p "$DEST"
cp -a "$EXTRACT"/. "$DEST"/
chmod +x "$DEST/web-server" "$DEST/streamer"

echo "moonlight-web-stream installed at $DEST"
echo "Gatwy looks for moonlight-web at /opt/moonlight-web."
