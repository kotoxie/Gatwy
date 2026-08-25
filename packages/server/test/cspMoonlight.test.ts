import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('global CSP stays tight', () => {
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');

  it('does not add unsafe-inline to helmet scriptSrc', () => {
    const helmetBlock = indexSrc.slice(
      indexSrc.indexOf('contentSecurityPolicy'),
      indexSrc.indexOf('app.use(\'/api/v1/smb'),
    );
    const scriptSrc = helmetBlock.match(/scriptSrc:\s*\[[^\]]+\]/)?.[0] ?? '';
    assert.match(scriptSrc, /scriptSrc:\s*\["'self'",\s*"'wasm-unsafe-eval'"\]/);
    assert.doesNotMatch(scriptSrc, /unsafe-inline/);
  });

  it('does not add stun: or turn: to the global connectSrc', () => {
    const helmetBlock = indexSrc.slice(
      indexSrc.indexOf('contentSecurityPolicy'),
      indexSrc.indexOf('app.use(\'/api/v1/smb'),
    );
    assert.match(helmetBlock, /connectSrc:\s*\["'self'",\s*"wss:",\s*"ws:",\s*"data:"\]/);
    assert.doesNotMatch(helmetBlock, /stun:/);
    assert.doesNotMatch(helmetBlock, /turn:/);
  });
});
