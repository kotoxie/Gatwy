import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitDomain } from '../src/services/credssp.js';

test('keeps an email-shaped username intact without guessing a domain', () => {
  assert.deepEqual(splitDomain('user@example.com'), { domain: '', user: 'user@example.com' });
});

test('supports a separate domain without splitting an email-shaped username', () => {
  assert.deepEqual(splitDomain('user@example.com', 'MicrosoftAccount'), {
    domain: 'MicrosoftAccount', user: 'user@example.com',
  });
});

test('retains local usernames and explicit Windows domain prefixes', () => {
  assert.deepEqual(splitDomain('local'), { domain: '', user: 'local' });
  assert.deepEqual(splitDomain('CORP\\user', 'OTHER'), { domain: 'CORP', user: 'user' });
  assert.deepEqual(splitDomain('MicrosoftAccount\\user@example.com'), {
    domain: 'MicrosoftAccount', user: 'user@example.com',
  });
});
