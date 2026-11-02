import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CODE_TO_SCANCODE,
  LOCK_CODES,
  NO_REPEAT_CODES,
  SCANCODE_TO_CODE,
  rdpKeyAction,
  type RdpKeyEvent,
} from '../src/lib/rdpKeyboard.js';

function key(type: 'keydown' | 'keyup', code: string, overrides: Partial<RdpKeyEvent> = {}): RdpKeyEvent {
  return { type, code, key: '', repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...overrides };
}

describe('scancode table', () => {
  it('maps both Shift keys to their Set-1 scancodes', () => {
    assert.equal(CODE_TO_SCANCODE.ShiftLeft, 0x2A);
    assert.equal(CODE_TO_SCANCODE.ShiftRight, 0x36);
  });

  it('marks extended keys with the 0xE0 prefix', () => {
    assert.equal(CODE_TO_SCANCODE.ControlRight, 0xE01D);
    assert.equal(CODE_TO_SCANCODE.AltRight, 0xE038);
    assert.equal(CODE_TO_SCANCODE.NumpadEnter, 0xE01C);
  });

  it('has no code mapped from two scancodes', () => {
    assert.equal(Object.keys(CODE_TO_SCANCODE).length, Object.keys(SCANCODE_TO_CODE).length);
  });

  it('knows every modifier and lock key it special-cases', () => {
    for (const code of [...NO_REPEAT_CODES, ...LOCK_CODES]) {
      assert.ok(CODE_TO_SCANCODE[code] !== undefined, `${code} has no scancode`);
    }
  });
});

describe('rdpKeyAction', () => {
  it('forwards a Right Shift press and release', () => {
    assert.deepEqual(rdpKeyAction(key('keydown', 'ShiftRight', { key: 'Shift' })), { kind: 'scancode', pressed: true, scancode: 0x36 });
    assert.deepEqual(rdpKeyAction(key('keyup', 'ShiftRight', { key: 'Shift' })), { kind: 'scancode', pressed: false, scancode: 0x36 });
  });

  // IronRDP turns a press of an already-pressed key into release+press, so forwarding
  // auto-repeat for a held modifier makes the remote see rapid taps (Sticky Keys, IME toggles).
  it('drops auto-repeat for held modifiers', () => {
    for (const code of NO_REPEAT_CODES) {
      assert.equal(rdpKeyAction(key('keydown', code, { repeat: true })), null, code);
    }
  });

  it('keeps auto-repeat for normal keys', () => {
    assert.deepEqual(rdpKeyAction(key('keydown', 'KeyA', { key: 'a', repeat: true })), { kind: 'scancode', pressed: true, scancode: 0x1E });
    assert.deepEqual(rdpKeyAction(key('keydown', 'ArrowDown', { key: 'ArrowDown', repeat: true })), { kind: 'scancode', pressed: true, scancode: 0xE050 });
  });

  // Lock state is set only by the lock-key sync; forwarding the key too inverted the remote.
  it('never forwards lock keys', () => {
    for (const code of LOCK_CODES) {
      assert.equal(rdpKeyAction(key('keydown', code)), null, `${code} keydown`);
      assert.equal(rdpKeyAction(key('keyup', code)), null, `${code} keyup`);
    }
  });

  it('falls back to the character for keys with no scancode', () => {
    assert.deepEqual(rdpKeyAction(key('keydown', '', { key: 'é' })), { kind: 'unicode', pressed: true, key: 'é' });
    assert.deepEqual(rdpKeyAction(key('keyup', '', { key: 'é' })), { kind: 'unicode', pressed: false, key: 'é' });
  });

  it('sends nothing for unmapped keys with a modifier or a non-character key', () => {
    assert.equal(rdpKeyAction(key('keydown', '', { key: 'é', ctrlKey: true })), null);
    assert.equal(rdpKeyAction(key('keydown', '', { key: 'é', altKey: true })), null);
    assert.equal(rdpKeyAction(key('keydown', '', { key: 'é', metaKey: true })), null);
    assert.equal(rdpKeyAction(key('keydown', '', { key: 'Process' })), null);
  });

  describe('unicode mode', () => {
    it('sends printable characters as unicode regardless of the layout', () => {
      assert.deepEqual(rdpKeyAction(key('keydown', 'KeyY', { key: 'z' }), true), { kind: 'unicode', pressed: true, key: 'z' });
      assert.deepEqual(rdpKeyAction(key('keydown', 'Digit2', { key: '"' }), true), { kind: 'unicode', pressed: true, key: '"' });
    });

    it('keeps scancodes for non-character keys and shortcuts', () => {
      assert.deepEqual(rdpKeyAction(key('keydown', 'Enter', { key: 'Enter' }), true), { kind: 'scancode', pressed: true, scancode: 0x1C });
      assert.deepEqual(rdpKeyAction(key('keydown', 'KeyC', { key: 'c', ctrlKey: true }), true), { kind: 'scancode', pressed: true, scancode: 0x2E });
      assert.deepEqual(rdpKeyAction(key('keydown', 'KeyA', { key: 'a', metaKey: true }), true), { kind: 'scancode', pressed: true, scancode: 0x1E });
    });

    it('sends AltGr characters as unicode', () => {
      const altGr = key('keydown', 'Digit2', { key: '@', ctrlKey: true, altKey: true, getModifierState: (k: string) => k === 'AltGraph' });
      assert.deepEqual(rdpKeyAction(altGr, true), { kind: 'unicode', pressed: true, key: '@' });
    });

    it('is off by default', () => {
      assert.deepEqual(rdpKeyAction(key('keydown', 'KeyY', { key: 'z' })), { kind: 'scancode', pressed: true, scancode: 0x15 });
    });
  });
});
