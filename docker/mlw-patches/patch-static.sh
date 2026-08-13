#!/bin/sh
# Patch bundled moonlight-web static assets for Gatwy chrome, sops, and
# fullscreen fill hit-testing (skip letterbox correction under gatwy-fullscreen).
# POSIX sh only — production image is node:*-slim (no bash/python3).
set -eu

STATIC_DIR="${1:-/opt/moonlight-web/static}"
PATCH_DIR="${2:-/tmp/gatwy-mlw-patches}"

if [ ! -d "$STATIC_DIR" ]; then
  echo "moonlight-web static dir missing: $STATIC_DIR" >&2
  exit 1
fi

install -m 0644 "$PATCH_DIR/gatwy-stream.css" "$STATIC_DIR/styles/gatwy-stream.css"
install -m 0644 "$PATCH_DIR/gatwy-sops.js" "$STATIC_DIR/gatwy-sops.js"
install -m 0644 "$PATCH_DIR/gatwy-stream-rect.js" "$STATIC_DIR/gatwy-stream-rect.js"

STREAM_HTML="$STATIC_DIR/stream.html"
if [ -f "$STREAM_HTML" ] && ! grep -q 'gatwy-stream.css' "$STREAM_HTML"; then
  # Insert Gatwy CSS + early sops hook after the standard stylesheet link.
  sed -i \
    's#<link rel="stylesheet" href="styles/standard.css" id="style">#<link rel="stylesheet" href="styles/standard.css" id="style">\n    <link rel="stylesheet" href="styles/gatwy-stream.css" id="gatwy-style">\n    <script src="gatwy-sops.js"></script>\n    <script src="gatwy-stream-rect.js"></script>#' \
    "$STREAM_HTML"
elif [ -f "$STREAM_HTML" ] && ! grep -q 'gatwy-stream-rect.js' "$STREAM_HTML"; then
  # Image already had CSS/sops from an older patch — add stream-rect next to sops.
  sed -i \
    's#<script src="gatwy-sops.js"></script>#<script src="gatwy-sops.js"></script>\n    <script src="gatwy-stream-rect.js"></script>#' \
    "$STREAM_HTML"
fi

STREAM_INDEX="$STATIC_DIR/stream/index.js"
if [ -f "$STREAM_INDEX" ] && ! grep -q 'sops:' "$STREAM_INDEX"; then
  # Insert sops: true next to hdr in StartStream settings (MLW v2.10.0).
  # Use node (always present) — avoid sed BRE '.' wildcards on the hdr line.
  # Idempotent: skipped above when sops: is already present.
  node -e '
const fs = require("fs");
const path = process.argv[1];
let text = fs.readFileSync(path, "utf8");
const exact =
  "hdr: (_a = this.settings.hdr) !== null && _a !== void 0 ? _a : false,";
const insert = exact + "\n                sops: true,";
let n = 0;
if (text.includes(exact)) {
  text = text.replace(exact, insert);
  n = 1;
} else {
  const pat = /(hdr:\s*(?:\([^)]+\)|[^\n,]+),)/m;
  if (pat.test(text)) {
    text = text.replace(pat, (chunk) => chunk + "\n                sops: true,");
    n = 1;
  }
}
if (n === 0) {
  console.error("warning: could not patch sops into stream/index.js");
  process.exit(0);
}
fs.writeFileSync(path, text);
console.log("patched sops into " + path);
' "$STREAM_INDEX"
fi

# Skip getStreamRectCorrected letterbox math when html.gatwy-fullscreen
# (object-fit: fill). Windowed contain still uses the original corrected rect.
# MLW v2.10.0 exports this from stream/video/index.js (older trees had it in
# stream/index.js). Idempotent: skipped when gatwy-fullscreen is already present.
patch_stream_rect() {
  target="$1"
  if [ ! -f "$target" ] || grep -q 'gatwy-fullscreen' "$target"; then
    return 0
  fi
  node -e '
const fs = require("fs");
const path = process.argv[1];
let text = fs.readFileSync(path, "utf8");
const early =
  "if (typeof document !== \"undefined\" && document.documentElement && document.documentElement.classList.contains(\"gatwy-fullscreen\")) { return boundingRect; }";
const re = /function getStreamRectCorrected\s*\(\s*boundingRect\s*,\s*videoSize\s*\)\s*\{/;
if (!re.test(text)) {
  process.exit(0);
}
text = text.replace(re, (chunk) => chunk + "\n    " + early);
fs.writeFileSync(path, text);
console.log("patched getStreamRectCorrected fill skip into " + path);
' "$target"
}
patch_stream_rect "$STREAM_INDEX"
patch_stream_rect "$STATIC_DIR/stream/video/index.js"

echo "Gatwy moonlight-web static patches applied in $STATIC_DIR"
