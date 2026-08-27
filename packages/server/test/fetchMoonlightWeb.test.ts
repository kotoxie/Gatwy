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

  it('pins v2.10.0 SHA-256 digests and refuses other versions', () => {
    assert.match(script, /VERSION="\$\{2:-v2\.10\.0\}"/);
    assert.match(script, /PINNED_SHA_x86_64_unknown_linux_gnu=b17fa535676a1c118bc1eb009134644cab98190b36a0776fb1b4a505d569f5eb/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_gnu=1a6bb6845756883671a5a783c0797367e84166c8210f8cfa51059f434f0e5a3a/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_musl=f008a5bfee1e22386564d28308bf00bdde0b33732de74a56858bc013942d2bb0/);
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
});
