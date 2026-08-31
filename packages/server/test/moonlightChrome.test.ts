import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { injectGatwyMoonlightChrome, shouldThemeMoonlightHtml } from '../src/ws/moonlightChrome.js';

const STREAM_HTML = `<!doctype html><html class="stream"><head><title>Stream</title></head><body class="stream"></body></html>`;

describe('injectGatwyMoonlightChrome', () => {
  it('loads the Gatwy overlay stylesheet on stream pages', () => {
    const html = injectGatwyMoonlightChrome(STREAM_HTML);
    assert.match(html, /href="\/moonlight-overlay\.css"/);
  });

  it('forces the moonlight-web sidebar onto the right edge before its script runs', () => {
    const html = injectGatwyMoonlightChrome(STREAM_HTML);
    assert.match(html, /sidebarEdge/);
    assert.match(html, /['"]right['"]/);
  });

  it('is idempotent', () => {
    const once = injectGatwyMoonlightChrome(STREAM_HTML);
    const twice = injectGatwyMoonlightChrome(once);
    assert.equal(once, twice);
  });
});

describe('shouldThemeMoonlightHtml', () => {
  it('themes only the stream document', () => {
    assert.equal(shouldThemeMoonlightHtml('/mlw/stream.html?hostId=1'), true);
    assert.equal(shouldThemeMoonlightHtml('/mlw/index.html'), false);
    assert.equal(shouldThemeMoonlightHtml('/mlw/api/host'), false);
  });
});
