// BASE_PATH support for running Gatwy behind a reverse-proxy path prefix (e.g. Traefik's
// PathPrefix('/sys/ftp')). Without this, the built client's root-absolute asset references
// (`src="/assets/index-<hash>.js"`) and the server's route mounts ignore the prefix, so a
// browser requests the asset at the host root instead of under the prefix — 404, or the wrong
// app's HTML served back as "JS" (NS_ERROR_CORRUPTED_CONTENT in Firefox).
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { normalizeBasePath } = await import('../src/config.js');
const { renderIndexHtml } = await import('../src/services/indexHtml.js');

describe('normalizeBasePath', () => {
  it('defaults to root for unset/empty input (no regression for existing deployments)', () => {
    assert.equal(normalizeBasePath(undefined), '');
    assert.equal(normalizeBasePath(''), '');
    assert.equal(normalizeBasePath('   '), '');
    assert.equal(normalizeBasePath('/'), '');
  });

  it('ensures exactly one leading slash and no trailing slash', () => {
    assert.equal(normalizeBasePath('sys/ftp'), '/sys/ftp');
    assert.equal(normalizeBasePath('/sys/ftp'), '/sys/ftp');
    assert.equal(normalizeBasePath('/sys/ftp/'), '/sys/ftp');
    assert.equal(normalizeBasePath('sys/ftp/'), '/sys/ftp');
  });
});

describe('renderIndexHtml', () => {
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-index-html-test-'));
  const indexPath = path.join(clientDir, 'index.html');
  fs.writeFileSync(
    indexPath,
    [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '  <head>',
      '    <link rel="icon" type="image/png" href="/favicon.png" />',
      '    <link rel="manifest" href="/manifest.webmanifest" />',
      '    <link rel="stylesheet" href="/assets/index-abc123.css" />',
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/assets/index-abc123.js"></script>',
      '  </body>',
      '</html>',
    ].join('\n'),
  );

  after(() => {
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  it('leaves root-absolute references untouched at the root (no regression)', () => {
    const html = renderIndexHtml(clientDir, '');
    assert.match(html, /href="\/favicon\.png"/);
    assert.match(html, /href="\/manifest\.webmanifest"/);
    assert.match(html, /href="\/assets\/index-abc123\.css"/);
    assert.match(html, /src="\/assets\/index-abc123\.js"/);
    assert.match(html, /<base href="\/" \/>/);
    assert.match(html, /<meta name="gatwy-base-path" content="" \/>/);
  });

  it('prefixes every root-absolute asset reference with BASE_PATH', () => {
    const html = renderIndexHtml(clientDir, '/sys/ftp');
    assert.match(html, /href="\/sys\/ftp\/favicon\.png"/);
    assert.match(html, /href="\/sys\/ftp\/manifest\.webmanifest"/);
    assert.match(html, /href="\/sys\/ftp\/assets\/index-abc123\.css"/);
    assert.match(html, /src="\/sys\/ftp\/assets\/index-abc123\.js"/);
    assert.match(html, /<base href="\/sys\/ftp\/" \/>/);
    assert.match(html, /<meta name="gatwy-base-path" content="\/sys\/ftp" \/>/);
  });
});
