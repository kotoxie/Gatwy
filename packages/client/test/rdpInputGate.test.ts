import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { whenActive } from '../src/lib/rdpInputGate.js';

describe('whenActive', () => {
  it('forwards the event while the tab is active', () => {
    const seen: string[] = [];
    whenActive(() => true, (e: string) => seen.push(e))('a');
    assert.deepEqual(seen, ['a']);
  });

  it('drops the event while the tab is hidden', () => {
    const seen: string[] = [];
    whenActive(() => false, (e: string) => seen.push(e))('a');
    assert.deepEqual(seen, []);
  });

  it('reads the active state on every event, not when it is created', () => {
    let active = true;
    const seen: string[] = [];
    const handler = whenActive(() => active, (e: string) => seen.push(e));
    handler('a');
    active = false;
    handler('b');
    active = true;
    handler('c');
    assert.deepEqual(seen, ['a', 'c']);
  });

  it('only the active one of two tabs reacts to the same event', () => {
    const hits = { rdp1: 0, rdp2: 0 };
    const rdp1 = whenActive(() => false, () => { hits.rdp1++; });
    const rdp2 = whenActive(() => true, () => { hits.rdp2++; });
    for (const handler of [rdp1, rdp2]) handler('keydown');
    assert.deepEqual(hits, { rdp1: 0, rdp2: 1 });
  });
});
