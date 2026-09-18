import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerMessagingGraph, noteRegistryUp, MAX_GRAPH_BODY_CHARS } from '../lib/graph.js';
import { PeerMessageStore, MAX_BODY_CHARS, MAX_PENDING_PER_SESSION } from '../lib/store.js';

function harness({ registryUrl = 'https://r.test', withStore = true } = {}) {
  const store = withStore
    ? new PeerMessageStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-graph-')), 'state.json') })
    : undefined;
  return {
    store,
    host: {
      settings: { get: (k) => ({ registryUrl }[k]) },
      stores: withStore ? { peerMessages: store } : {},
    },
  };
}

function envelope(over = {}) {
  return { id: 'm1', fromHandle: 'peer-card', fromRepo: 'acme/app', fromDisplay: 'Sam Rivera', body: 'ping', ...over };
}

beforeEach(() => { noteRegistryUp(null); });

// `assertGraphKeys` runs the contributor once per activation against
// `{graph: {}}`; a throw there quarantines the whole extension.
test('it never throws on an empty graph, and reads nothing off the one it is given', () => {
  const h = harness();
  assert.doesNotThrow(() => peerMessagingGraph({ host: h.host, graph: {} }));
  const out = peerMessagingGraph({ host: h.host, graph: {} });
  assert.deepEqual(Object.keys(out), ['peerMessaging'], 'exactly one key, and not a reserved one');
});

test('a host with no store yet still answers honestly rather than throwing', () => {
  const h = harness({ withStore: false });
  const g = peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging;
  assert.deepEqual(g.bySession, {});
  assert.deepEqual(g.inbox, {});
});

test('a card with no peer traffic at all is absent from bySession entirely', () => {
  const h = harness();
  assert.deepEqual(peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.bySession, {});
});

test('bySession carries three integers per card and no bodies', () => {
  const h = harness();
  h.store.receive('card-1', envelope({ id: 'a' }));
  h.store.receive('card-1', envelope({ id: 'b' }));
  h.store.receive('card-1', envelope({ id: 'c', fromHandle: 'trusted' }));
  h.store.approve('card-1', 'c', { allowAll: true, mode: 'live' });
  h.store.block('card-1', 'noisy');
  const row = peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.bySession['card-1'];
  assert.deepEqual(row, { pending: 2, allowAll: 1, blocked: 1 });
  assert.equal(JSON.stringify(row).includes('ping'), false);
});

// The §B.10 (a) decision: the approval card needs the body on FIRST paint, and
// there is no ctx.reply for an extension handler to answer a request with.
test('inbox carries the pending bodies, per card, for the panel to draw', () => {
  const h = harness();
  h.store.receive('card-1', envelope({ body: 'hold off on hooks/spawn-runner?' }));
  const inbox = peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.inbox['card-1'];
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].body, 'hold off on hooks/spawn-runner?');
  assert.deepEqual(Object.keys(inbox.messages[0]).sort(), ['body', 'createdAt', 'fromDisplay', 'fromHandle', 'fromRepo', 'id', 'receivedAt']);
});

// An array with a property hung off it loses that property in JSON.stringify,
// so the channel list would never reach the browser.
test('inbox survives a JSON round trip, channels included', () => {
  const h = harness();
  h.store.receive('card-1', envelope());
  h.store.approve('card-1', 'm1', { allowAll: true, mode: 'live' });
  const g = JSON.parse(JSON.stringify(peerMessagingGraph({ host: h.host, graph: {} }))).peerMessaging;
  assert.equal(g.inbox['card-1'].channels.length, 1);
  assert.equal(g.inbox['card-1'].channels[0].peerHandle, 'peer-card');
  assert.equal(g.inbox['card-1'].channels[0].allowAll, true);
});

test('a channel with nothing pending still carries the last OUTCOME, and no prose', () => {
  const h = harness();
  h.store.receive('card-1', envelope({ body: 'secret peer prose' }));
  h.store.approve('card-1', 'm1', { at: 900, mode: 'dormant' }); // allowed once, nothing standing
  const g = peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging;
  assert.deepEqual(g.bySession['card-1'], { pending: 0, allowAll: 0, blocked: 0 });
  const ch = g.inbox['card-1'].channels[0];
  assert.deepEqual(ch.lastIn, { at: 900, mode: 'dormant' }, 'so "woke the card and delivered" survives a reload');
  assert.equal(ch.inCount, 1);
  // The thread's BODIES are deliberately not on the graph: already in the pane
  // and in the agent's context, and no decision depends on them.
  assert.equal(JSON.stringify(g).includes('secret peer prose'), false);
});

test('a peer nobody has ever heard from is not a graph entry', () => {
  const h = harness();
  h.store.unblock('card-1', 'never-seen');
  assert.deepEqual(peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.bySession, {});
});

// The per-card caps bound ONE card; a board can have many, which is what the
// whole-tick budget is for. Four cards each at the pending cap with maximal
// bodies is ~800KB of prose, twice the budget.
test('a body-heavy BOARD degrades to counts rather than a vast graph, and SAYS so', () => {
  const h = harness();
  const big = 'x'.repeat(MAX_BODY_CHARS);
  const cards = ['card-1', 'card-2', 'card-3', 'card-4'];
  for (const card of cards) {
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) h.store.receive(card, envelope({ id: `${card}-m${i}`, body: big }));
  }
  const g = peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging;
  assert.equal(g.truncated, true);
  const carried = cards.reduce((n, c) => n + g.inbox[c].messages.length, 0);
  assert.ok(carried < cards.length * MAX_PENDING_PER_SESSION, 'not every body was carried');
  assert.ok(carried * MAX_BODY_CHARS <= MAX_GRAPH_BODY_CHARS, 'and what was carried is inside the budget');
  // The COUNTS are still exact for every card, which is what the pill draws —
  // a human is told there are 50 waiting even where the bodies were dropped.
  for (const c of cards) assert.equal(g.bySession[c].pending, MAX_PENDING_PER_SESSION);
});

test('configured says whether there is anywhere to look', () => {
  assert.equal(peerMessagingGraph({ host: harness().host, graph: {} }).peerMessaging.configured, true);
  assert.equal(peerMessagingGraph({ host: harness({ registryUrl: null }).host, graph: {} }).peerMessaging.configured, false);
});

test('registryUp is null until the sweep has tried, then whatever it last saw', () => {
  const h = harness();
  assert.equal(peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.registryUp, null);
  noteRegistryUp(false);
  assert.equal(peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.registryUp, false);
  noteRegistryUp(true);
  assert.equal(peerMessagingGraph({ host: h.host, graph: {} }).peerMessaging.registryUp, true);
});
