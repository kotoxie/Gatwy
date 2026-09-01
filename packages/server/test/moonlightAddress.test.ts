import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveMoonlightHostAddress } from '../src/services/moonlightAddress.js';

describe('resolveMoonlightHostAddress', () => {
  it('returns IPv4 addresses unchanged', async () => {
    assert.equal(await resolveMoonlightHostAddress('192.0.2.10'), '192.0.2.10');
    assert.equal(await resolveMoonlightHostAddress(' 198.51.100.20 '), '198.51.100.20');
  });

  it('returns IPv6 addresses unchanged', async () => {
    assert.equal(await resolveMoonlightHostAddress('::1'), '::1');
  });

  it('resolves hostnames to an IP (moonlight RTSP cannot parse DNS names)', async () => {
    const ip = await resolveMoonlightHostAddress('localhost');
    assert.match(ip, /^(127\.0\.0\.1|::1)$/);
  });

  it('rejects an empty host', async () => {
    await assert.rejects(
      () => resolveMoonlightHostAddress(''),
      /empty/i,
    );
  });
});
