import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/fetch-moonlight-web.sh',
);

describe('scripts/fetch-moonlight-web.sh integrity pin', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('pins v3.0.0 SHA-256 digests and refuses other versions', () => {
    assert.match(script, /VERSION="\$\{2:-v3\.0\.0\}"/);
    assert.match(script, /PINNED_SHA_x86_64_unknown_linux_musl=86b960f6295f6b8d5f166bceb7e5d97aaadc7a0562a1cf91071d66777c1beadf/);
    assert.match(script, /PINNED_SHA_x86_64_unknown_linux_gnu=6b1d679bfd545b7bb0748d02e9617a6abde02223d1957324c6489f6959acac3c/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_gnu=7beb0ec95e9feda042878c18ba4363f962cef44ad8dd915bf3d17d7e82b6f733/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_musl=7cc619bb232410ec6f35e776b8c642dafd8983ae7ccc6e80dd62586ff2074b64/);
    assert.match(script, /Refusing unpinned moonlight-web-stream version/);
  });

  it('fails closed on checksum mismatch', () => {
    assert.match(script, /Checksum mismatch/);
    assert.match(script, /expected \$\{EXPECTED_SHA\}/);
    assert.match(script, /got      \$\{ACTUAL_SHA\}/);
    const mismatchBlock = script.slice(script.indexOf('if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]'));
    assert.match(mismatchBlock, /exit 1/);
    assert.doesNotMatch(script, /IGNORE_CHECKSUM|skip.?checksum|NO_VERIFY/i);
  });

  it('installs web-server without requiring a separate streamer binary', () => {
    assert.match(script, /web-server/);
    assert.doesNotMatch(script, /missing web-server and\/or streamer/);
  });
});
