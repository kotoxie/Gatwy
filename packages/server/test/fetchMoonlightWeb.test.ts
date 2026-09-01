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

  it('pins v3.0.0-prerelease.5 SHA-256 digests and refuses other versions', () => {
    assert.match(script, /VERSION="\$\{2:-v3\.0\.0-prerelease\.5\}"/);
    assert.match(script, /PINNED_SHA_x86_64_unknown_linux_musl=bda8c825db233a50e2500d5bcfd93267ce4d2adc774bd964f325967133ba5b62/);
    assert.match(script, /PINNED_SHA_x86_64_unknown_linux_gnu=a8371ae6c614d672737cf2fa7dfb61fd46627a45f5c4187480e258e4489327c2/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_gnu=eab9866eec4991db5884d95886cc4f3bec9695fa9e9e052cc64f19b6a72a7226/);
    assert.match(script, /PINNED_SHA_aarch64_unknown_linux_musl=3f5bb7f1b44f16beaf06f946e7dea29f3cb07834c50e18a5e6a2a1966d1e7023/);
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
