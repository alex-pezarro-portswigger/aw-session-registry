import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postmaster, _resetSweepState, SWEEP_MS, REPUBLISH_MS } from '../lib/sweep.js';
import { PeerMessageStore, MAX_PENDING_PER_SESSION } from '../lib/store.js';
import { setPerHandleFallback } from '../lib/registry.js';
import { _resetRepoKeyCache } from '../lib/repo-key.js';

const BASE = 'https://registry.example.test';
const realFetch = globalThis.fetch;

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-sweep-')), 'state.json');
}

// One harness: a `host` façade stub carrying only the keys this extension's
// `requires` would actually grant it, plus an observable call log.
function harness({ registryUrl = BASE, pollSeconds = undefined, sessions = [{ sessionId: 'card-1', cwd: '/w/app' }] } = {}) {
  const calls = [];   // every fetch, in order, as `METHOD /path`
  const logs = [];
  const delivered = [];
  const broadcasts = [];
  let rebuilds = 0;
  const store = new PeerMessageStore({ file: tmpFile() });
  const host = {
    id: 'peer-messaging',
    settings: { get: (k) => ({ registryUrl, pollSeconds }[k]), all: () => ({ registryUrl, pollSeconds }) },
    stores: { peerMessages: store },
    sessions: { list: () => sessions.map((s) => ({ archived: false, ...s })) },
    deliver: async (sessionId, text) => { delivered.push({ sessionId, text }); return { mode: 'live' }; },
    rebuild: () => { rebuilds += 1; },
    broadcast: (p) => broadcasts.push(p),
    log: (...a) => logs.push(a.map(String).join(' ')),
  };
  return {
    host, store, calls, logs, delivered, broadcasts,
    rebuilds: () => rebuilds,
    // A repo-key resolver, injected so no test needs a real git checkout.
    repoKey: async (cwd) => (cwd === '/w/app' ? 'acme/app' : cwd === '/w/other' ? 'acme/other' : null),
    stub(responder) {
      globalThis.fetch = async (target, opts = {}) => {
        const u = new URL(String(target));
        calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
        const r = (await responder(String(target), opts)) || {};
        if (r instanceof Error) throw r;
        return {
          ok: r.status == null || (r.status >= 200 && r.status < 300),
          status: r.status ?? 200,
          json: async () => r.json ?? {},
        };
      };
    },
  };
}

function envelope(over = {}) {
  return {
    id: 'm1', toHandle: 'card-1', toRepo: 'acme/app',
    fromHandle: 'peer-card', fromRepo: 'acme/app', fromDisplay: 'Sam Rivera',
    body: 'hold off on hooks/spawn-runner?', createdAt: '2026-09-18T10:00:00Z',
    ...over,
  };
}

beforeEach(() => { _resetSweepState(); _resetRepoKeyCache(); setPerHandleFallback(false); });
afterEach(() => { globalThis.fetch = realFetch; _resetSweepState(); setPerHandleFallback(false); });

// ── Inert ────────────────────────────────────────────────────────────────────

test('no registry URL is WHOLLY inert, with one line per process and never per tick', async () => {
  const h = harness({ registryUrl: null });
  h.stub(() => { throw new Error('should not reach the network'); });
  for (let i = 0; i < 5; i++) await postmaster({ host: h.host, now: i * SWEEP_MS, repoKey: h.repoKey });
  assert.deepEqual(h.calls, []);
  assert.equal(h.logs.length, 1, 'one line, not one per tick');
  assert.match(h.logs[0], /no registry URL set/);
  assert.equal(h.rebuilds(), 0);
});

test('a card with no resolvable repo has no peers and costs no request', async () => {
  const h = harness({ sessions: [{ sessionId: 'card-1', cwd: '/tmp/scratch' }] });
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.calls, []);
  assert.equal(h.rebuilds(), 0);
});

test('an archived session is filtered out even though the projection already excludes it', async () => {
  const h = harness({ sessions: [{ sessionId: 'card-1', cwd: '/w/app', archived: true }] });
  h.host.sessions.list = () => [{ sessionId: 'card-1', cwd: '/w/app', archived: true }];
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.calls, []);
});

// ── Drain ────────────────────────────────────────────────────────────────────

test('an empty drain stores nothing, acks nothing and does NOT rebuild', async () => {
  const h = harness();
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.startsWith('POST /v1/messages/ack')).length, 0);
  assert.equal(h.rebuilds(), 0, 'a rebuild per tick for nothing would be a second graph cadence');
});

test('one batched drain per repo, whatever the number of cards in it', async () => {
  const h = harness({ sessions: [
    { sessionId: 'card-1', cwd: '/w/app' },
    { sessionId: 'card-2', cwd: '/w/app' },
    { sessionId: 'card-3', cwd: '/w/other' },
  ] });
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  const drains = h.calls.filter((c) => c.startsWith('GET /v1/messages'));
  assert.equal(drains.length, 2, 'two repos, two requests — not one per card');
  assert.ok(drains.some((c) => c.includes('repo=acme%2Fapp') && c.includes('handles=card-1,card-2')));
  assert.ok(drains.some((c) => c.includes('repo=acme%2Fother') && c.includes('handles=card-3')));
});

test('a drained message lands in pending, is NOT delivered, and rebuilds', async () => {
  const h = harness();
  h.stub(() => ({ json: { messages: [envelope()] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(h.store.pendingFor('card-1').length, 1);
  assert.deepEqual(h.delivered, [], 'THE FIREBREAK: an unapproved message never reaches an agent');
  assert.equal(h.rebuilds(), 1);
});

test('an envelope addressed to a handle we did not ask for is ignored', async () => {
  const h = harness();
  h.stub(() => ({ json: { messages: [envelope({ toHandle: 'someone-elses-card' })] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.store.pendingFor('someone-elses-card'), []);
  assert.equal(h.calls.filter((c) => c.startsWith('POST /v1/messages/ack')).length, 0);
});

// ── PERSIST, THEN ACK — the whole of the at-least-once contract ──────────────

test('the ack goes out AFTER the message is persisted, asserted by call order', async () => {
  const h = harness();
  let persistedBeforeAck = null;
  h.stub((target, opts) => {
    if (opts.method === 'POST' && target.includes('/messages/ack')) {
      // At the moment the ack leaves, the message must already be on disk.
      persistedBeforeAck = new PeerMessageStore({ file: h.store.file }).pendingFor('card-1').length;
      return { json: { acked: 1 } };
    }
    return { json: { messages: [envelope()] } };
  });
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(persistedBeforeAck, 1, 'a crash between the two must re-deliver, never lose');
  assert.deepEqual(h.calls.filter((c) => c.includes('/messages')).map((c) => c.split('?')[0]), [
    'GET /v1/messages', 'POST /v1/messages/ack',
  ]);
});

test('a redelivered (unacked) message is skipped by id, not shown twice', async () => {
  const h = harness();
  h.stub(() => ({ json: { messages: [envelope()], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.store.pendingFor('card-1').length, 1);
  assert.equal(h.rebuilds(), 1, 'the second tick changed nothing, so it did not rebuild');
});

test('an over-cap message is dropped AND acked, so the relay stops re-sending it for ever', async () => {
  const h = harness();
  for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) h.store.receive('card-1', envelope({ id: `pre${i}` }));
  h.stub(() => ({ json: { messages: [envelope({ id: 'over' })], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(h.store.pendingFor('card-1').length, MAX_PENDING_PER_SESSION);
  assert.equal(h.calls.filter((c) => c.startsWith('POST /v1/messages/ack')).length, 1);
});

test('a blocked peer"s message is dropped AND acked', async () => {
  const h = harness();
  h.store.block('card-1', 'peer-card');
  h.stub(() => ({ json: { messages: [envelope()], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.store.pendingFor('card-1'), []);
  assert.equal(h.calls.filter((c) => c.startsWith('POST /v1/messages/ack')).length, 1);
});

// ── The firebreak's one gate ─────────────────────────────────────────────────

test('an auto-allowed PAIR is delivered framed; every other message is not', async () => {
  const h = harness();
  h.store.receive('card-1', envelope({ id: 'seed' }));
  h.store.approve('card-1', 'seed', { allowAll: true, mode: 'live' });
  h.stub(() => ({ json: {
    messages: [envelope({ id: 'from-approved' }), envelope({ id: 'from-stranger', fromHandle: 'stranger' })],
    acked: 2,
  } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });

  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, 'card-1');
  assert.match(h.delivered[0].text, /^\[peer message · untrusted · from Sam Rivera · session peer-card · repo acme\/app · you approved at /);
  assert.match(h.delivered[0].text, /\[end peer message\]$/);
  // The approved one left pending; the stranger's is still waiting for a click.
  assert.deepEqual(h.store.pendingFor('card-1').map((e) => e.id), ['from-stranger']);
  assert.equal(h.store.threadFor('card-1', 'peer-card').at(-1).mode, 'live');
  assert.ok(h.broadcasts.some((b) => b.kind === 'auto-delivered' && b.messageId === 'from-approved'));
});

test('an approval for ONE pair does not auto-deliver another peer"s message to the same card', async () => {
  const h = harness();
  h.store.receive('card-1', envelope({ id: 'seed' }));
  h.store.approve('card-1', 'seed', { allowAll: true, mode: 'live' });
  h.stub(() => ({ json: { messages: [envelope({ id: 'x', fromHandle: 'other-peer' })], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.delivered, []);
});

test('an approval on one CARD does not auto-deliver to another card', async () => {
  const h = harness({ sessions: [{ sessionId: 'card-1', cwd: '/w/app' }, { sessionId: 'card-2', cwd: '/w/app' }] });
  h.store.receive('card-1', envelope({ id: 'seed' }));
  h.store.approve('card-1', 'seed', { allowAll: true, mode: 'live' });
  h.stub(() => ({ json: { messages: [envelope({ id: 'x', toHandle: 'card-2' })], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.delivered, []);
  assert.equal(h.store.pendingFor('card-2').length, 1);
});

test('an auto-delivery that fails is recorded as such rather than looking delivered', async () => {
  const h = harness();
  h.host.deliver = async () => ({ mode: 'error', error: 'session is archived' });
  h.store.receive('card-1', envelope({ id: 'seed' }));
  h.store.approve('card-1', 'seed', { allowAll: true, mode: 'live' });
  h.stub(() => ({ json: { messages: [envelope({ id: 'x' })], acked: 1 } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(h.store.threadFor('card-1', 'peer-card').at(-1).mode, 'error');
});

// ── pollSeconds throttling ───────────────────────────────────────────────────

test('pollSeconds coarsens the cadence — three 15s ticks at 45s is ONE real drain', async () => {
  const h = harness({ pollSeconds: 45 });
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
  await postmaster({ host: h.host, now: 2 * SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.startsWith('GET /v1/messages')).length, 1);
  // And the fourth tick, 45s on, drains again.
  await postmaster({ host: h.host, now: 3 * SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.startsWith('GET /v1/messages')).length, 2);
});

test('pollSeconds at or under the 15s floor cannot make it faster — the floor is everyMs', async () => {
  for (const pollSeconds of [undefined, 0, 5, 15, -1, Number.NaN]) {
    _resetSweepState();
    const h = harness({ pollSeconds });
    h.stub(() => ({ json: { messages: [] } }));
    await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
    await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
    assert.equal(h.calls.filter((c) => c.startsWith('GET /v1/messages')).length, 2, `pollSeconds=${pollSeconds}`);
  }
});

// ── Reachability: one line on a TRANSITION, never per tick ───────────────────

test('a down registry logs ONCE and stays quiet for the next three ticks', async () => {
  const h = harness();
  h.stub(() => new Error('ECONNREFUSED'));
  for (let i = 0; i < 4; i++) await postmaster({ host: h.host, now: i * SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /unreachable/);
  assert.match(h.logs[0], /nothing is lost/);
});

test('coming back up is a line too, and the FIRST-ever result is not a transition', async () => {
  const h = harness();
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.logs, [], 'a board that was never down says nothing on its first tick');
  h.stub(() => new Error('ECONNREFUSED'));
  await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 2 * SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[1], /reachable again/);
});

test('nothing is lost across an outage: the messages come back on the next sweep', async () => {
  const h = harness();
  h.stub(() => new Error('ECONNREFUSED'));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.deepEqual(h.store.pendingFor('card-1'), []);
  h.stub(() => ({ json: { messages: [envelope()], acked: 1 } }));
  await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.store.pendingFor('card-1').length, 1);
});

// ── The handle re-assert (step 8) ────────────────────────────────────────────

test('the re-assert runs on its OWN slow clock, not once per live card per tick', async () => {
  const h = harness({ sessions: [{ sessionId: 'card-1', cwd: '/w/app' }, { sessionId: 'card-2', cwd: '/w/app' }] });
  h.stub(() => ({ json: { messages: [] } }));
  await postmaster({ host: h.host, now: 0, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.includes('/note')).length, 2, 'both cards published on the first sweep');
  await postmaster({ host: h.host, now: SWEEP_MS, repoKey: h.repoKey });
  await postmaster({ host: h.host, now: 2 * SWEEP_MS, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.includes('/note')).length, 2, 'and not again on the next two');
  await postmaster({ host: h.host, now: REPUBLISH_MS, repoKey: h.repoKey });
  assert.equal(h.calls.filter((c) => c.includes('/note')).length, 4);
});

// ── The sweep must never throw: a throwing sweep is logged EVERY tick ────────

test('a 500 from every endpoint is reported once and does not throw', async () => {
  const h = harness();
  h.stub(() => ({ status: 500, json: { error: 'boom' } }));
  await assert.doesNotReject(() => postmaster({ host: h.host, now: 0, repoKey: h.repoKey }));
  assert.equal(h.logs.length, 1);
});

test('a failed ack does not throw, and the message stays stored for the retry', async () => {
  const h = harness();
  h.stub((target, opts) => (opts.method === 'POST' && target.includes('/ack')
    ? { status: 503, json: { error: 'redis down' } }
    : { json: { messages: [envelope()] } }));
  await assert.doesNotReject(() => postmaster({ host: h.host, now: 0, repoKey: h.repoKey }));
  assert.equal(h.store.pendingFor('card-1').length, 1);
  assert.match(h.logs[0], /unreachable/);
});
