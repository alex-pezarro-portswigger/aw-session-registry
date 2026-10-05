import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxOwnedByMod, launchContext } from '../lib/launch-context.js';

const host = (registryUrl) => ({ settings: { get: (k) => ({ registryUrl }[k]) } });

test('a Claude launch hands its inbox to the mod, with the configured registry', () => {
  assert.deepEqual(launchContext({ agent: 'claude', host: host('https://r.example.test') }), {
    env: { PEER_MESSAGES_INBOX: 'mod', PEER_MESSAGES_URL: 'https://r.example.test' },
  });
});

test('a Codex launch gets nothing and keeps the card flow', () => {
  assert.deepEqual(launchContext({ agent: 'codex', host: host('https://r.example.test') }), {});
});

test('only a card that says it is Claude is owned by the mod', () => {
  assert.equal(inboxOwnedByMod({ agent: 'claude' }), true);
  assert.equal(inboxOwnedByMod({ agent: 'codex' }), false);
  assert.equal(inboxOwnedByMod({}), false);
  assert.equal(inboxOwnedByMod(null), false);
});
