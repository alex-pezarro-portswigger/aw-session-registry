import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PeerMessageStore, MAX_PENDING_PER_SESSION, MAX_BODY_CHARS, SEEN_RING, MAX_THREAD_PER_PEER,
} from '../lib/store.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-store-'));
  return path.join(dir, 'state.json');
}

function store(file = tmpFile(), log = () => {}) {
  return new PeerMessageStore({ file, log });
}

function envelope(over = {}) {
  return {
    id: 'm1',
    fromHandle: 'peer-card',
    fromRepo: 'acme/app',
    fromDisplay: 'Sam Rivera',
    body: 'hold off on hooks/spawn-runner?',
    createdAt: '2026-09-18T10:00:00Z',
    ...over,
  };
}

test('receive stores a message and reports it', () => {
  const s = store();
  assert.equal(s.receive('card-1', envelope()), 'stored');
  const pending = s.pendingFor('card-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].body, 'hold off on hooks/spawn-runner?');
  assert.equal(pending[0].fromHandle, 'peer-card');
});

test('an unusable envelope is "invalid" and stores nothing', () => {
  const s = store();
  assert.equal(s.receive('card-1', null), 'invalid');
  assert.equal(s.receive('card-1', envelope({ id: '' })), 'invalid');
  assert.equal(s.receive('card-1', envelope({ fromHandle: '' })), 'invalid');
  assert.equal(s.receive('card-1', envelope({ body: '   ' })), 'invalid');
  assert.equal(s.receive('', envelope()), 'invalid');
  assert.deepEqual(s.pendingFor('card-1'), []);
});

// ── Caps ─────────────────────────────────────────────────────────────────────

test('pending is capped, checked BEFORE the append, and over-cap is "full"', () => {
  const s = store();
  for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
    assert.equal(s.receive('card-1', envelope({ id: `m${i}` })), 'stored');
  }
  assert.equal(s.pendingFor('card-1').length, MAX_PENDING_PER_SESSION);
  assert.equal(s.receive('card-1', envelope({ id: 'one-too-many' })), 'full');
  assert.equal(s.pendingFor('card-1').length, MAX_PENDING_PER_SESSION, 'a refused add did not partially land');
  // Still marked seen, so the caller can ack it and the relay stops
  // re-delivering it every sweep for ever.
  assert.equal(s.receive('card-1', envelope({ id: 'one-too-many' })), 'seen');
});

test('a body over the cap is truncated to what the relay would have carried', () => {
  const s = store();
  s.receive('card-1', envelope({ body: 'x'.repeat(MAX_BODY_CHARS + 500) }));
  assert.equal(s.pendingFor('card-1')[0].body.length, MAX_BODY_CHARS);
});

test('the body cap counts runes, not UTF-16 code units', () => {
  const s = store();
  const emoji = '😀'.repeat(MAX_BODY_CHARS);
  s.receive('card-1', envelope({ body: emoji }));
  assert.equal([...s.pendingFor('card-1')[0].body].length, MAX_BODY_CHARS);
  assert.equal(s.pendingFor('card-1')[0].body, emoji, 'an exactly-at-cap body survived unchanged');
});

test('the thread keeps the newest MAX_THREAD_PER_PEER entries, oldest off', () => {
  const s = store();
  for (let i = 0; i < MAX_THREAD_PER_PEER + 10; i++) s.appendOut('card-1', 'peer-card', `out ${i}`, i);
  const thread = s.threadFor('card-1', 'peer-card');
  assert.equal(thread.length, MAX_THREAD_PER_PEER);
  assert.equal(thread[0].body, `out ${10}`);
  assert.equal(thread.at(-1).body, `out ${MAX_THREAD_PER_PEER + 9}`);
});

// ── The seen ring: what makes a non-destructive drain idempotent ─────────────

test('a re-received id is "seen" and is not stored twice', () => {
  const s = store();
  assert.equal(s.receive('card-1', envelope({ id: 'm7' })), 'stored');
  assert.equal(s.receive('card-1', envelope({ id: 'm7' })), 'seen');
  assert.equal(s.pendingFor('card-1').length, 1);
});

test('a denied id stays seen, so an unacked redelivery cannot resurrect it', () => {
  const s = store();
  s.receive('card-1', envelope({ id: 'm7' }));
  assert.equal(s.deny('card-1', 'm7'), true);
  assert.deepEqual(s.pendingFor('card-1'), []);
  assert.equal(s.receive('card-1', envelope({ id: 'm7' })), 'seen');
  assert.deepEqual(s.pendingFor('card-1'), []);
});

test('the seen ring evicts the oldest id past SEEN_RING', () => {
  const s = store();
  // Deny as we go, so the pending cap is not what stops us.
  for (let i = 0; i < SEEN_RING; i++) {
    s.receive('card-1', envelope({ id: `m${i}` }));
    s.deny('card-1', `m${i}`);
  }
  assert.equal(s.receive('card-1', envelope({ id: 'm0' })), 'seen', 'the first id is still remembered at exactly SEEN_RING');
  // One more DISTINCT id pushes the ring past its cap and evicts the oldest,
  // which is m0 — re-receiving 'm0' is "seen" above precisely because that
  // outcome does not re-mark it and so does not move it up the ring.
  s.receive('card-1', envelope({ id: 'fresh' }));
  s.deny('card-1', 'fresh');
  assert.equal(s.receive('card-1', envelope({ id: 'm0' })), 'stored', 'the oldest id was evicted and is no longer skipped');
  // Re-storing 'm0' marks it seen again, which pushes the ring over once more
  // and evicts m1 in its turn — so m2 is the oldest id still remembered.
  assert.equal(s.receive('card-1', envelope({ id: 'm2' })), 'seen', 'ids inside the ring are still remembered');
});

// ── Persistence ──────────────────────────────────────────────────────────────

test('persistence is a side effect of mutation — a second instance sees the write', () => {
  const file = tmpFile();
  const a = store(file);
  a.receive('card-1', envelope());
  a.appendOut('card-1', 'peer-card', 'my reply', 123);
  a.block('card-1', 'noisy-peer');
  const b = store(file);
  assert.equal(b.pendingFor('card-1').length, 1);
  assert.equal(b.threadFor('card-1', 'peer-card')[0].body, 'my reply');
  assert.equal(b.receive('card-1', envelope({ id: 'x', fromHandle: 'noisy-peer' })), 'blocked');
  assert.equal(b.receive('card-1', envelope()), 'seen', 'the seen ring survived the reload');
});

test('a corrupt state file is moved aside, reported, and the store still comes up', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const lines = [];
  const s = store(file, (m) => lines.push(String(m)));
  assert.deepEqual(s.pendingFor('card-1'), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /is corrupt/);
  assert.ok(fs.existsSync(`${file}.corrupt`), 'the bytes were kept, not discarded');
  // And the store is usable — a corrupt file must not stop the extension.
  assert.equal(s.receive('card-1', envelope()), 'stored');
});

test('an unrecognised state version starts empty and says so rather than guessing', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 99, pending: { 'card-1': [envelope()] } }));
  const lines = [];
  const s = store(file, (m) => lines.push(String(m)));
  assert.deepEqual(s.pendingFor('card-1'), []);
  assert.match(lines[0], /version 99/);
});

test('emptied keys are pruned rather than persisted as empty lists', () => {
  const file = tmpFile();
  const s = store(file);
  s.receive('card-1', envelope());
  s.deny('card-1', 'm1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.pending, {});
});

// ── Approve / deny ───────────────────────────────────────────────────────────

test('approve removes from pending, logs the thread with the delivered mode, and grants nothing on its own', () => {
  const s = store();
  s.receive('card-1', envelope());
  assert.equal(s.approve('card-1', 'm1', { at: 500, mode: 'dormant' }), true);
  assert.deepEqual(s.pendingFor('card-1'), []);
  const thread = s.threadFor('card-1', 'peer-card');
  assert.deepEqual(thread, [{ id: 'm1', dir: 'in', body: 'hold off on hooks/spawn-runner?', at: 500, mode: 'dormant' }]);
  assert.equal(s.isAutoAllowed('card-1', 'peer-card'), false, 'allowing once granted no standing approval');
});

test('approve with allowAll sets the standing per-pair approval', () => {
  const s = store();
  s.receive('card-1', envelope());
  s.approve('card-1', 'm1', { allowAll: true, at: 500, mode: 'live' });
  assert.equal(s.isAutoAllowed('card-1', 'peer-card'), true);
  assert.equal(s.isAutoAllowed('card-1', 'someone-else'), false, 'the approval is per PAIR');
  assert.equal(s.isAutoAllowed('card-2', 'peer-card'), false, 'and per CARD');
  assert.equal(s.channelsFor('card-1')[0].allowedAt, 500);
});

test('approve and deny are no-ops for an unknown id rather than throws', () => {
  const s = store();
  assert.equal(s.approve('card-1', 'nope'), false);
  assert.equal(s.deny('card-1', 'nope'), false);
});

test('deny leaves NO archive of the denied text anywhere', () => {
  const file = tmpFile();
  const s = store(file);
  s.receive('card-1', envelope({ body: 'secret peer prose' }));
  s.deny('card-1', 'm1');
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret peer prose'), false);
  assert.deepEqual(s.threadFor('card-1', 'peer-card'), []);
});

// ── Channels ─────────────────────────────────────────────────────────────────

test('block drops THAT peer"s pending only and refuses its future messages', () => {
  const s = store();
  s.receive('card-1', envelope({ id: 'a', fromHandle: 'noisy' }));
  s.receive('card-1', envelope({ id: 'b', fromHandle: 'other' }));
  s.block('card-1', 'noisy', { at: 700 });
  assert.deepEqual(s.pendingFor('card-1').map((e) => e.id), ['b']);
  assert.equal(s.receive('card-1', envelope({ id: 'c', fromHandle: 'noisy' })), 'blocked');
  assert.equal(s.receive('card-1', envelope({ id: 'd', fromHandle: 'other' })), 'stored');
});

test('block withdraws any standing approval too — the two must never coexist', () => {
  const s = store();
  s.receive('card-1', envelope());
  s.approve('card-1', 'm1', { allowAll: true });
  s.block('card-1', 'peer-card');
  assert.equal(s.isAutoAllowed('card-1', 'peer-card'), false);
});

test('unblock reopens the channel and does not restore what was dropped', () => {
  const s = store();
  s.receive('card-1', envelope());
  s.block('card-1', 'peer-card');
  assert.equal(s.unblock('card-1', 'peer-card'), true);
  assert.equal(s.unblock('card-1', 'peer-card'), false, 'already unblocked');
  assert.deepEqual(s.pendingFor('card-1'), []);
  assert.equal(s.receive('card-1', envelope({ id: 'later' })), 'stored');
});

test('revoke clears the standing approval ONLY — pending and thread survive', () => {
  const s = store();
  s.receive('card-1', envelope({ id: 'a' }));
  s.approve('card-1', 'a', { allowAll: true, mode: 'live' });
  s.receive('card-1', envelope({ id: 'b' }));
  assert.equal(s.revoke('card-1', 'peer-card'), true);
  assert.equal(s.isAutoAllowed('card-1', 'peer-card'), false);
  assert.deepEqual(s.pendingFor('card-1').map((e) => e.id), ['b'], 'what was already waiting was not binned');
  assert.equal(s.threadFor('card-1', 'peer-card').length, 1);
  assert.equal(s.revoke('card-1', 'peer-card'), false);
});

test('the peer"s asserted display name is remembered on the channel', () => {
  const s = store();
  s.receive('card-1', envelope());
  assert.equal(s.channelsFor('card-1')[0].lastDisplay, 'Sam Rivera');
});

// ── Session lifecycle ────────────────────────────────────────────────────────

test('archive drops pending and every standing approval, keeps threads and seen', () => {
  const s = store();
  s.receive('card-1', envelope({ id: 'a' }));
  s.approve('card-1', 'a', { allowAll: true, mode: 'live' });
  s.receive('card-1', envelope({ id: 'b' }));
  assert.equal(s.closeSession('card-1'), true);
  assert.deepEqual(s.pendingFor('card-1'), [], 'unapproved text did not outlive the session');
  assert.equal(s.isAutoAllowed('card-1', 'peer-card'), false);
  assert.equal(s.threadFor('card-1', 'peer-card').length, 1, 'the human"s log of what happened survived');
  assert.equal(s.receive('card-1', envelope({ id: 'b' })), 'seen', 'seen survived, so an unacked redelivery is still skipped');
});

test('purge removes absolutely everything for that card', () => {
  const file = tmpFile();
  const s = store(file);
  s.receive('card-1', envelope({ body: 'unapproved prose' }));
  s.appendOut('card-1', 'peer-card', 'and my reply', 1);
  s.receive('card-2', envelope({ id: 'z' }));
  assert.equal(s.forgetSession('card-1'), true);
  assert.deepEqual(s.pendingFor('card-1'), []);
  assert.deepEqual(s.threadFor('card-1', 'peer-card'), []);
  assert.deepEqual(s.channelsFor('card-1'), []);
  assert.equal(s.receive('card-1', envelope()), 'stored', 'even the seen ring went');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('and my reply'), false);
  assert.equal(s.pendingFor('card-2').length, 1, 'another card was untouched');
});

test('archive and purge are no-ops for a card with nothing stored', () => {
  const s = store();
  assert.equal(s.closeSession('nobody'), false);
  assert.equal(s.forgetSession('nobody'), false);
});

// ── The graph snapshot ───────────────────────────────────────────────────────

test('snapshot is a deep copy — a caller cannot reach into the store through it', () => {
  const s = store();
  s.receive('card-1', envelope());
  const snap = s.snapshot();
  snap.pending['card-1'][0].body = 'clobbered';
  snap.pending['card-1'].push(envelope({ id: 'injected' }));
  assert.equal(s.pendingFor('card-1')[0].body, 'hold off on hooks/spawn-runner?');
  assert.equal(s.pendingFor('card-1').length, 1);
});

test('pendingMessage hands back a copy, never the stored object', () => {
  const s = store();
  s.receive('card-1', envelope());
  const m = s.pendingMessage('card-1', 'm1');
  m.body = 'clobbered';
  assert.equal(s.pendingFor('card-1')[0].body, 'hold off on hooks/spawn-runner?');
  assert.equal(s.pendingMessage('card-1', 'nope'), null);
});

// The whole class is synchronous on purpose: the sweep and six control handlers
// write in one process, and an await between a read and its write is where one
// clobbers the other.
test('no mutator returns a promise', () => {
  const s = store();
  const results = [
    s.receive('card-1', envelope()),
    s.approve('card-1', 'm1', { mode: 'live' }),
    s.deny('card-1', 'gone'),
    s.block('card-1', 'p'),
    s.unblock('card-1', 'p'),
    s.revoke('card-1', 'p'),
    s.appendOut('card-1', 'p', 'x', 1),
    s.closeSession('card-1'),
    s.forgetSession('card-1'),
  ];
  for (const r of results) assert.equal(typeof r?.then, 'undefined');
});
