import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMoonlightSettingsPatch,
  mergeMoonlightExtra,
  moonlightSettingsResponse,
  normalizeMoonlightResolution,
  normalizeMoonlightTouchMode,
  parseMoonlightExtra,
  resolveHttpPort,
} from '../src/services/moonlightPairing.js';

describe('normalizeMoonlightResolution', () => {
  it('defaults unset and invalid values to auto', () => {
    assert.equal(normalizeMoonlightResolution(undefined), 'auto');
    assert.equal(normalizeMoonlightResolution(''), 'auto');
    assert.equal(normalizeMoonlightResolution('native'), 'auto');
    assert.equal(normalizeMoonlightResolution('nope'), 'auto');
    assert.equal(normalizeMoonlightResolution(12), 'auto');
  });

  it('accepts WIDTHxHEIGHT and lowercases', () => {
    assert.equal(normalizeMoonlightResolution('1920x1080'), '1920x1080');
    assert.equal(normalizeMoonlightResolution(' 1920X1080 '), '1920x1080');
  });
});

describe('normalizeMoonlightTouchMode', () => {
  it('defaults unset and invalid values to pointAndDrag', () => {
    assert.equal(normalizeMoonlightTouchMode(undefined), 'pointAndDrag');
    assert.equal(normalizeMoonlightTouchMode(''), 'pointAndDrag');
    assert.equal(normalizeMoonlightTouchMode('trackpad'), 'pointAndDrag');
  });

  it('accepts known moonlight-web modes', () => {
    assert.equal(normalizeMoonlightTouchMode('pointAndDrag'), 'pointAndDrag');
    assert.equal(normalizeMoonlightTouchMode('localCursor'), 'localCursor');
    assert.equal(normalizeMoonlightTouchMode('mouseRelative'), 'mouseRelative');
    assert.equal(normalizeMoonlightTouchMode('touch'), 'touch');
  });
});

describe('parseMoonlightExtra / mergeMoonlightExtra', () => {
  it('parses JSON and returns {} on empty or invalid input', () => {
    assert.deepEqual(parseMoonlightExtra(null), {});
    assert.deepEqual(parseMoonlightExtra(''), {});
    assert.deepEqual(parseMoonlightExtra('not-json'), {});
    assert.deepEqual(parseMoonlightExtra('{"appName":"Desktop","fps":60}'), {
      appName: 'Desktop',
      fps: 60,
    });
  });

  it('merges patches without dropping existing fields', () => {
    const merged = mergeMoonlightExtra(
      { appName: 'Desktop', paired: true, mlHostId: 3 },
      { fps: 120, paired: true },
    );
    assert.equal(merged.appName, 'Desktop');
    assert.equal(merged.mlHostId, 3);
    assert.equal(merged.fps, 120);
    assert.equal(merged.paired, true);
  });
});

describe('resolveHttpPort', () => {
  it('prefers extra.httpPort, then connection port, then 47989', () => {
    assert.equal(resolveHttpPort(47989, { httpPort: 47999 }), 47999);
    assert.equal(resolveHttpPort(47989, {}), 47989);
    assert.equal(resolveHttpPort(0, {}), 47989);
  });
});

describe('applyMoonlightSettingsPatch', () => {
  it('ignores empty or non-object bodies', () => {
    const extra = { bitrateKbps: 20000, fps: 60 };
    assert.deepEqual(applyMoonlightSettingsPatch(extra, null), extra);
    assert.deepEqual(applyMoonlightSettingsPatch(extra, undefined), extra);
  });

  it('clamps bitrate and fps', () => {
    const low = applyMoonlightSettingsPatch({}, { bitrateKbps: 500, fps: 10 });
    assert.equal(low.bitrateKbps, 1000);
    assert.equal(low.fps, 15);

    const high = applyMoonlightSettingsPatch({}, { bitrateKbps: 200000, fps: 300 });
    assert.equal(high.bitrateKbps, 150000);
    assert.equal(high.fps, 240);
  });

  it('ignores non-numeric bitrate/fps', () => {
    const extra = applyMoonlightSettingsPatch({}, { bitrateKbps: 'fast', fps: 'high' });
    assert.equal(extra.bitrateKbps, undefined);
    assert.equal(extra.fps, undefined);
  });

  it('normalizes resolution and touchMode', () => {
    const extra = applyMoonlightSettingsPatch({}, {
      resolution: '1920X1080',
      touchMode: 'localCursor',
    });
    assert.equal(extra.resolution, '1920x1080');
    assert.equal(extra.touchMode, 'localCursor');

    const invalid = applyMoonlightSettingsPatch({}, {
      resolution: 'uhd',
      touchMode: 'stylus',
    });
    assert.equal(invalid.resolution, 'auto');
    assert.equal(invalid.touchMode, 'pointAndDrag');
  });

  it('returns the settings API shape', () => {
    const extra = applyMoonlightSettingsPatch({}, { bitrateKbps: 8000, fps: 30 });
    assert.deepEqual(moonlightSettingsResponse(extra), {
      ok: true,
      bitrateKbps: 8000,
      fps: 30,
      resolution: 'auto',
      touchMode: 'pointAndDrag',
    });
  });
});
