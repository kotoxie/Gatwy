import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'http';
import { authorizeMoonlightAccess, parseCookie } from '../src/ws/moonlightAuth.js';
import { MLW_FRAME_CSP } from '../src/ws/moonlightProxy.js';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('parseCookie', () => {
  it('reads gatwy_token from a cookie header', () => {
    assert.equal(parseCookie('a=1; gatwy_token=abc%2Fdef; b=2', 'gatwy_token'), 'abc/def');
    assert.equal(parseCookie(undefined, 'gatwy_token'), null);
    assert.equal(parseCookie('other=1', 'gatwy_token'), null);
  });
});

describe('authorizeMoonlightAccess (HTTP GET /mlw/* and WS upgrade)', () => {
  it('rejects missing JWT cookie / Bearer the same way for any /mlw request', () => {
    const result = authorizeMoonlightAccess(fakeReq({}));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.match(result.error, /Authentication required/);
    }
  });

  it('rejects a malformed Bearer token', () => {
    const result = authorizeMoonlightAccess(fakeReq({ authorization: 'Bearer not-a-jwt' }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
    }
  });
});

describe('MLW_FRAME_CSP', () => {
  it('scopes stun: / turn: to the /mlw frame policy only', () => {
    assert.match(MLW_FRAME_CSP, /stun:/);
    assert.match(MLW_FRAME_CSP, /turn:/);
    assert.match(MLW_FRAME_CSP, /frame-ancestors 'self'/);
  });
});
