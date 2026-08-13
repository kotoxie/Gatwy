import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  moonlightBinariesPresent,
  moonlightUnavailablePayload,
  MOONLIGHT_UNAVAILABLE_BODY,
  MOONLIGHT_MISSING_HINT,
  filterListedConnections,
} from '../src/services/moonlightWeb.js';

describe('moonlightBinariesPresent', () => {
  it('is false when the directory is missing or empty', () => {
    assert.equal(moonlightBinariesPresent(undefined), false);
    assert.equal(moonlightBinariesPresent(null), false);
    assert.equal(moonlightBinariesPresent(''), false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-mlw-'));
    try {
      assert.equal(moonlightBinariesPresent(dir), false);
      fs.writeFileSync(path.join(dir, 'web-server'), '');
      assert.equal(moonlightBinariesPresent(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is true only when web-server and streamer both exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-mlw-'));
    try {
      fs.writeFileSync(path.join(dir, 'web-server'), '');
      fs.writeFileSync(path.join(dir, 'streamer'), '');
      assert.equal(moonlightBinariesPresent(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('moonlightUnavailablePayload', () => {
  it('returns the available: false JSON when the runtime is missing', () => {
    assert.equal(moonlightUnavailablePayload(true), null);
    assert.deepEqual(moonlightUnavailablePayload(false), MOONLIGHT_UNAVAILABLE_BODY);
    assert.equal(MOONLIGHT_UNAVAILABLE_BODY.available, false);
    assert.match(MOONLIGHT_UNAVAILABLE_BODY.error, /not available/i);
  });

  it('treats missing binaries as unavailable (no live Sunshine host required)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-mlw-'));
    try {
      const available = moonlightBinariesPresent(dir);
      assert.equal(available, false);
      const body = moonlightUnavailablePayload(available);
      assert.deepEqual(body, {
        error: 'Moonlight runtime not available in this installation',
        available: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filterListedConnections', () => {
  const rows = [
    { id: '1', protocol: 'rdp' },
    { id: '2', protocol: 'moonlight' },
    { id: '3', protocol: 'vnc' },
  ];

  it('keeps moonlight rows when the runtime is available', () => {
    assert.deepEqual(filterListedConnections(rows, true), rows);
  });

  it('omits moonlight rows when the runtime is unavailable (does not delete)', () => {
    assert.deepEqual(filterListedConnections(rows, false), [
      { id: '1', protocol: 'rdp' },
      { id: '3', protocol: 'vnc' },
    ]);
  });
});

describe('MOONLIGHT_MISSING_HINT', () => {
  it('mentions only ENABLE_MOONLIGHT=1', () => {
    assert.match(MOONLIGHT_MISSING_HINT, /ENABLE_MOONLIGHT=1/);
    assert.doesNotMatch(MOONLIGHT_MISSING_HINT, /MOONLIGHT_DOWNLOAD/);
    assert.doesNotMatch(MOONLIGHT_MISSING_HINT, /INCLUDE_MOONLIGHT/);
    assert.doesNotMatch(MOONLIGHT_MISSING_HINT, /MOONLIGHT_WEB_DIR/);
  });
});
