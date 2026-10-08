import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  addActiveSession,
  removeActiveSession,
  setActiveSessionStatus,
  listActiveSessions,
} from '../src/ws/activeSessions.js';

const base = {
  userId: 'u1', connectionId: 'c1', connectionName: 'router', protocol: 'ssh' as const,
};

describe('activeSessions registry', () => {
  beforeEach(() => {
    for (const s of listActiveSessions()) removeActiveSession(s.id);
  });

  it('adds a session as connected and lists it', () => {
    addActiveSession({ ...base, id: 's1' });
    const list = listActiveSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 's1');
    assert.equal(list[0].status, 'connected');
    assert.ok(list[0].startedAt <= Date.now());
  });

  it('follows grace and reattach', () => {
    addActiveSession({ ...base, id: 's1' });
    setActiveSessionStatus('s1', 'grace');
    assert.equal(listActiveSessions()[0].status, 'grace');
    setActiveSessionStatus('s1', 'connected');
    assert.equal(listActiveSessions()[0].status, 'connected');
  });

  it('removes a session, and a repeated remove or status update on it is harmless', () => {
    addActiveSession({ ...base, id: 's1' });
    removeActiveSession('s1');
    removeActiveSession('s1');
    setActiveSessionStatus('s1', 'grace');
    assert.equal(listActiveSessions().length, 0);
  });

  it('lists sessions oldest first', async () => {
    addActiveSession({ ...base, id: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    addActiveSession({ ...base, id: 'b', protocol: 'rdp' });
    assert.deepEqual(listActiveSessions().map((s) => s.id), ['a', 'b']);
  });
});
