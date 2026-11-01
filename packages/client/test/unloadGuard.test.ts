import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmUnload, hasLiveTerminalSession, isReloadShortcut, noteReloadShortcut } from '../src/lib/unloadGuard.js';

const key = (k: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...o });

describe('reload shortcuts do not trigger the prompt', () => {
  it('recognises F5, Ctrl+R and Cmd+R', () => {
    assert.equal(isReloadShortcut(key('F5')), true);
    assert.equal(isReloadShortcut(key('r', { ctrlKey: true })), true);
    assert.equal(isReloadShortcut(key('R', { metaKey: true })), true);
  });

  it('ignores other keys and keys a terminal already handled', () => {
    assert.equal(isReloadShortcut(key('r')), false);
    assert.equal(isReloadShortcut(key('w', { ctrlKey: true })), false);
    assert.equal(isReloadShortcut(key('F5', { defaultPrevented: true })), false);
    assert.equal(isReloadShortcut(key('r', { ctrlKey: true, altKey: true })), false);
  });

  it('skips the prompt right after a reload shortcut, then arms again', () => {
    noteReloadShortcut(key('F5'), 10_000);
    let prevented = false;
    const e = { preventDefault: () => { prevented = true; } };
    confirmUnload(e, 10_500);
    assert.equal(prevented, false);
    confirmUnload(e, 12_000);
    assert.equal(prevented, true);
  });
});

describe('hasLiveTerminalSession', () => {
  it('is false with no tabs', () => {
    assert.equal(hasLiveTerminalSession([]), false);
  });

  it('is true for a connected ssh tab', () => {
    assert.equal(hasLiveTerminalSession([{ protocol: 'ssh', status: 'connected' }]), true);
  });

  it('is true for a connected telnet tab', () => {
    assert.equal(hasLiveTerminalSession([{ protocol: 'telnet', status: 'connected' }]), true);
  });

  it('ignores terminal tabs that are connecting or disconnected', () => {
    assert.equal(hasLiveTerminalSession([
      { protocol: 'ssh', status: 'connecting' },
      { protocol: 'ssh', status: 'disconnected' },
    ]), false);
  });

  it('ignores connected non-terminal tabs', () => {
    assert.equal(hasLiveTerminalSession([
      { protocol: 'rdp', status: 'connected' },
      { protocol: 'vnc', status: 'connected' },
      { protocol: 'sftp', status: 'connected' },
    ]), false);
  });

  it('is true when one live terminal sits among other tabs', () => {
    assert.equal(hasLiveTerminalSession([
      { protocol: 'rdp', status: 'connected' },
      { protocol: 'ssh', status: 'connected' },
    ]), true);
  });
});

describe('confirmUnload', () => {
  it('cancels the event and sets a returnValue so the prompt shows', () => {
    let prevented = false;
    const e: { preventDefault(): void; returnValue?: unknown } = { preventDefault: () => { prevented = true; } };
    confirmUnload(e);
    assert.equal(prevented, true);
    assert.equal(e.returnValue, '');
  });
});
