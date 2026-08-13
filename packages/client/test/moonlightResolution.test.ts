import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ML_RESOLUTION_AUTO,
  appendStreamLaunchParams,
  normalizeMlResolution,
  parseResolutionPreset,
  resolutionToMlwVideoSize,
  sizesDiffer,
  snapStreamSize,
} from '../src/lib/moonlightResolution.ts';

describe('normalizeMlResolution', () => {
  it('defaults unset and invalid values to auto', () => {
    assert.equal(normalizeMlResolution(undefined), ML_RESOLUTION_AUTO);
    assert.equal(normalizeMlResolution(''), 'auto');
    assert.equal(normalizeMlResolution('native'), 'auto');
    assert.equal(normalizeMlResolution('not-a-size'), 'auto');
  });

  it('accepts presets and custom WIDTHxHEIGHT', () => {
    assert.equal(normalizeMlResolution('1920x1080'), '1920x1080');
    assert.equal(normalizeMlResolution(' 1280X720 '), '1280x720');
    assert.equal(normalizeMlResolution('1366x768'), '1366x768');
  });
});

describe('parseResolutionPreset / snapStreamSize / sizesDiffer', () => {
  it('parses WxH and returns null for auto', () => {
    assert.deepEqual(parseResolutionPreset('1920x1080'), { width: 1920, height: 1080 });
    assert.equal(parseResolutionPreset('auto'), null);
  });

  it('snaps to even dimensions with a floor', () => {
    assert.deepEqual(snapStreamSize(1921, 1081), { width: 1920, height: 1080 });
    assert.deepEqual(snapStreamSize(10, 10), { width: 640, height: 360 });
  });

  it('compares sizes with a threshold', () => {
    assert.equal(sizesDiffer({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }), false);
    assert.equal(sizesDiffer({ width: 1920, height: 1080 }, { width: 1924, height: 1080 }), false);
    assert.equal(sizesDiffer({ width: 1920, height: 1080 }, { width: 1930, height: 1080 }), true);
  });
});

describe('resolutionToMlwVideoSize', () => {
  it('always launches as custom WxH', () => {
    const preset = resolutionToMlwVideoSize('1920x1080', null);
    assert.equal(preset.videoSize, 'custom');
    assert.deepEqual(preset.videoSizeCustom, { width: 1920, height: 1080 });

    const auto = resolutionToMlwVideoSize('auto', { width: 1601, height: 901 });
    assert.equal(auto.videoSize, 'custom');
    assert.deepEqual(auto.videoSizeCustom, { width: 1600, height: 900 });
  });
});

describe('appendStreamLaunchParams', () => {
  it('writes bitrate, fps, custom size, websocket transport, and sops', () => {
    const path = appendStreamLaunchParams(
      '/mlw/stream.html?hostId=1&appId=2',
      {
        bitrateKbps: 20000,
        fps: 60,
        resolution: '1920x1080',
        clientArea: null,
      },
      'https://gatwy.example',
    );
    const url = new URL(path, 'https://gatwy.example');
    assert.equal(url.searchParams.get('bitrate'), '20000');
    assert.equal(url.searchParams.get('fps'), '60');
    assert.equal(url.searchParams.get('videoSize'), 'custom');
    assert.equal(url.searchParams.get('videoSizeCustom.width'), '1920');
    assert.equal(url.searchParams.get('videoSizeCustom.height'), '1080');
    assert.equal(url.searchParams.get('dataTransport'), 'websocket');
    assert.equal(url.searchParams.get('sops'), 'true');
  });
});
