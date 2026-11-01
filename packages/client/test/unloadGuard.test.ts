import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmUnload, hasLiveTerminalSession } from '../src/lib/unloadGuard.js';

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
