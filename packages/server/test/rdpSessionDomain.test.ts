import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatwy-rdp-domain-test-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'rdp-session-domain-test-secret';

const { initDb, closeDb } = await import('../src/db/index.js');
const { execute } = await import('../src/db/helpers.js');
const { initJwt, signToken } = await import('../src/services/jwt.js');
const { default: connectionsRouter } = await import('../src/routes/connections.js');
const { default: express } = await import('express');

const USER = 'u-rdp-domain';
let server: Server;
let baseUrl: string;
let token: string;

// A session payload is what the browser hands to IronRDP as username/password/
// server-domain, so the domain key is the explicit qualification path for
// accounts whose address must not be split at '@'.
async function session(connectionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/${connectionId}/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as Record<string, unknown>;
}

before(async () => {
  await initDb();
  initJwt();

  execute(
    `INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
    [USER, 'rdp-domain-user', 'x', 'RDP Domain User', 'admin'],
  );
  // Library credentials carry the domain; the route must pass it through for RDP
  // and withhold it everywhere else.
  execute(
    `INSERT INTO credentials (id, user_id, name, type, username, encrypted_password, private_key, encrypted_passphrase, shared, domain)
     VALUES (?, ?, ?, 'password', ?, NULL, NULL, NULL, 0, ?)`,
    ['cred-msa', USER, 'Microsoft account', 'me@example.com', 'MicrosoftAccount'],
  );
  execute(
    `INSERT INTO credentials (id, user_id, name, type, username, encrypted_password, private_key, encrypted_passphrase, shared, domain)
     VALUES (?, ?, ?, 'password', ?, NULL, NULL, NULL, 0, NULL)`,
    ['cred-no-domain', USER, 'No domain', 'plainuser'],
  );

  const addConnection = (id: string, protocol: string, credentialId: string | null) => {
    execute(
      `INSERT INTO connections (id, user_id, name, protocol, host, port, username, sort_order, shared, credential_id)
       VALUES (?, ?, ?, ?, 'host.example', 3389, NULL, 0, 0, ?)`,
      [id, USER, id, protocol, credentialId],
    );
  };
  addConnection('rdp-msa', 'rdp', 'cred-msa');
  addConnection('rdp-no-domain', 'rdp', 'cred-no-domain');
  addConnection('ssh-msa', 'ssh', 'cred-msa');

  token = signToken({ userId: USER, username: 'rdp-domain-user', role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/connections', connectionsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1/connections`;
});

after(() => new Promise<void>((resolve) => server.close(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  resolve();
})));

describe('GET /:id/session — explicit Windows domain for RDP', () => {
  it('returns the credential domain with the email-shaped username left whole', async () => {
    const body = await session('rdp-msa');
    assert.equal(body.username, 'me@example.com');
    assert.equal(body.domain, 'MicrosoftAccount');
  });

  it('omits the domain when the credential has none', async () => {
    const body = await session('rdp-no-domain');
    assert.equal(body.username, 'plainuser');
    assert.equal('domain' in body, false);
  });

  it('never sends a domain for non-RDP protocols', async () => {
    const body = await session('ssh-msa');
    assert.equal('domain' in body, false);
  });
});