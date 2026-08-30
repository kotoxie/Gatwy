import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Moonlight runs inside Gatwy at runtime, not a sidecar', () => {
  const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'packages/server/src/services/moonlightWeb.ts'), 'utf8');
  const fetchScript = fs.readFileSync(path.join(root, 'scripts/fetch-moonlight-web.sh'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  it('entrypoint fetches moonlight-web-stream into /opt/moonlight-web when ENABLE_MOONLIGHT is set', () => {
    assert.match(entrypoint, /ENABLE_MOONLIGHT/);
    assert.match(entrypoint, /fetch-moonlight-web/);
    assert.match(entrypoint, /\/opt\/moonlight-web/);
    assert.doesNotMatch(entrypoint, /gcompat/);
  });

  it('Alpine Dockerfile copies the fetch helper and does not add a sidecar image', () => {
    assert.match(dockerfile, /fetch-moonlight-web/);
    assert.match(dockerfile, /FROM node:22-alpine/);
    assert.equal(fs.existsSync(path.join(root, 'Dockerfile.moonlight-web')), false);
    assert.equal(fs.existsSync(path.join(root, 'scripts/moonlight-web-entrypoint.sh')), false);
  });

  it('compose has a single gatwy service with no moonlight-web sidecar', () => {
    assert.doesNotMatch(compose, /moonlight-web:/);
    assert.doesNotMatch(compose, /Dockerfile\.moonlight-web/);
    assert.doesNotMatch(compose, /profiles:/);
  });

  it('server spawns web-server on loopback instead of proxying a sidecar hostname', () => {
    assert.match(service, /child_process/);
    assert.match(service, /spawn\(/);
    assert.match(service, /127\.0\.0\.1:19080/);
    assert.doesNotMatch(service, /moonlight-web:19080/);
    assert.doesNotMatch(service, /--streamer-path/);
  });

  it('fetch helper prefers musl on Alpine including x86_64', () => {
    assert.match(fetchScript, /x86_64-unknown-linux-musl/);
    assert.match(fetchScript, /PINNED_SHA_x86_64_unknown_linux_musl=/);
    assert.match(fetchScript, /v3\.0\.0-prerelease\.5/);
  });
});
