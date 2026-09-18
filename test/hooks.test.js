import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onDispatch, onResume, onArchive, onPurge } from '../lib/hooks.js';
import { PeerMessageStore } from '../lib/store.js';
import { _resetRepoKeyCache, _setGitOriginForTests } from '../lib/repo-key.js';

const BASE = 'https://registry.example.test';
const realFetch = globalThis.fetch;

function harness({ registryUrl = BASE } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-hooks-')), 'state.json');
  const store = new PeerMessageStore({ file });
  const calls = [];
  const logs = [];
  let rebuilds = 0;
  const host = {
    settings: { get: (k) => ({ registryUrl }[k]) },
    stores: { peerMessages: store },
    rebuild: () => { rebuilds += 1; },
    log: (...a) => logs.push(a.map(String).join(' ')),
  };
  return { host, store, calls, logs, rebuilds: () => rebuilds };
}

// A fetch that never settles, which is the whole point: a hook that RETURNED
// this promise would hang every dispatch on the board until the 5s timeout.
function hangingFetch(calls) {
  globalThis.fetch = (target, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${target}`);
    return new Promise(() => {});
  };
}

function okFetch(calls) {
  globalThis.fetch = async (target, opts = {}) => {
    calls.push({ url: String(target), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ session: {} }) };
  };
}

beforeEach(() => { _resetRepoKeyCache(); _setGitOriginForTests(async () => 'git@github.com:acme/app.git'); });
afterEach(() => { globalThis.fetch = realFetch; _setGitOriginForTests(null); _resetRepoKeyCache(); });

// ── THE FOOTGUN: the core AWAITS these hooks ─────────────────────────────────
// _fireExtHooks does `await fn(payload)`, inside dispatch() and _doResume().
// Returning the network promise would add the full 5s AbortSignal timeout to
// EVERY dispatch and EVERY resume on the board — worst of all exactly when the
// registry is down. These two tests are the guard.

test('onDispatch returns undefined, not a promise — the core awaits it', () => {
  const h = harness();
  hangingFetch(h.calls);
  const returned = onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  assert.equal(returned, undefined, 'a returned promise would hang every dispatch on the board');
});

test('onResume returns undefined too', () => {
  const h = harness();
  hangingFetch(h.calls);
  assert.equal(onResume({ sessionId: 'card-1', entry: { cwd: '/w/app' }, reason: 'message', host: h.host }), undefined);
});

test('a hook whose POST never settles still returns immediately', async () => {
  const h = harness();
  hangingFetch(h.calls);
  const before = Date.now();
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  assert.ok(Date.now() - before < 50, 'the hook did not wait on the network');
});

test('a rejected POST is swallowed rather than becoming an unhandled rejection', async () => {
  const h = harness();
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  // Let the detached promise settle; an unhandled rejection would fail the run.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /the sweep will retry/);
});

// ── What it publishes ────────────────────────────────────────────────────────

test('the published handle IS the card id, with intent and detail omitted', async () => {
  const h = harness();
  okFetch(h.calls);
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${BASE}/v1/sessions/card-1/note`);
  assert.deepEqual(h.calls[0].body, { repo: 'acme/app', messagingHandle: 'card-1', origin: 'local' });
});

test('no registry URL publishes nothing and says nothing — dispatch is far too frequent for a line', async () => {
  const h = harness({ registryUrl: null });
  okFetch(h.calls);
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.logs, []);
});

test('a card in a non-git folder publishes nothing, silently — it simply has no peers', async () => {
  const h = harness();
  _setGitOriginForTests(async () => null);
  okFetch(h.calls);
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/tmp/scratch' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.logs, []);
});

// ── Archive and purge ────────────────────────────────────────────────────────

test('archive drops pending and every standing approval, and rebuilds', () => {
  const h = harness();
  h.store.receive('card-1', { id: 'a', fromHandle: 'p', body: 'x' });
  h.store.approve('card-1', 'a', { allowAll: true, mode: 'live' });
  h.store.receive('card-1', { id: 'b', fromHandle: 'p', body: 'y' });
  onArchive({ sessionId: 'card-1', host: h.host });
  assert.deepEqual(h.store.pendingFor('card-1'), [], 'unapproved text did not outlive the session');
  assert.equal(h.store.isAutoAllowed('card-1', 'p'), false);
  assert.equal(h.store.threadFor('card-1', 'p').length, 1, 'the log of what did happen survived');
  assert.equal(h.rebuilds(), 1);
});

test('purge removes everything for the card', () => {
  const h = harness();
  h.store.receive('card-1', { id: 'a', fromHandle: 'p', body: 'x' });
  h.store.appendOut('card-1', 'p', 'my reply', 1);
  onPurge({ sessionId: 'card-1', host: h.host });
  assert.deepEqual(h.store.pendingFor('card-1'), []);
  assert.deepEqual(h.store.threadFor('card-1', 'p'), []);
  assert.deepEqual(h.store.channelsFor('card-1'), []);
  assert.equal(h.rebuilds(), 1);
});

test('archive and purge of a card with nothing stored do not rebuild for nothing', () => {
  const h = harness();
  onArchive({ sessionId: 'nobody', host: h.host });
  onPurge({ sessionId: 'nobody', host: h.host });
  assert.equal(h.rebuilds(), 0);
});

test('archive and purge are synchronous — the core awaits them too', () => {
  const h = harness();
  h.store.receive('card-1', { id: 'a', fromHandle: 'p', body: 'x' });
  assert.equal(onArchive({ sessionId: 'card-1', host: h.host }), undefined);
  assert.equal(onPurge({ sessionId: 'card-1', host: h.host }), undefined);
});
