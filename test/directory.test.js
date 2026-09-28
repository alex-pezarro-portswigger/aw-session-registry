import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTORY_FIELDS, _resetDirectory, directorySnapshot, noteDirectory } from '../lib/directory.js';

// The whole point of this module is the `changed` answer: it is what the sweep
// turns into a `host.rebuild()`, and a fetch that returns identical rows every
// 15 seconds must NOT rebuild the board — that would be a second cadence doing
// no work, which is the thing the sweep's own tests pin everywhere else.

function entry(over = {}) {
  return {
    sessionId: 'sess-1',
    origin: 'local',
    intent: 'wiring the drain',
    detail: '',
    branch: 'main',
    startedAt: '2026-09-20T09:00:00Z',
    finishedAt: null,
    messagingHandle: 'card-1',
    owner: 'Sam Rivera',
    ownerKey: 'abc123',
    briefedAt: null,
    ...over,
  };
}

const okWith = (repos) => ({ ok: true, repos });

beforeEach(() => { _resetDirectory(); });

test('the first successful fetch is a change, and carries the rows and the time', () => {
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry()] }), 1000), true);
  const snap = directorySnapshot();
  assert.deepEqual(Object.keys(snap.repos), ['acme/app']);
  assert.equal(snap.repos['acme/app'][0].sessionId, 'sess-1');
  assert.equal(snap.fetchedAt, 1000);
  assert.equal(snap.error, null);
});

test('an identical second fetch is NOT a change, but the "as of" still advances', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry()] }), 2000), false);
  assert.equal(directorySnapshot().fetchedAt, 2000, 'so the view"s "as of" is honest');
});

test('a projected field changing is a change; an unprojected one is not', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry({ intent: 'something else' })] }), 2000), true);
  // ownerKey is an identity hash the board never carries, so moving it must
  // not cost a rebuild.
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry({ intent: 'something else', ownerKey: 'zzz' })] }), 3000), false);
});

test('a session ending is a change', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry({ finishedAt: '2026-09-20T10:00:00Z' })] }), 2000), true);
});

test('a repo appearing or disappearing is a change', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry()], 'acme/other': [entry({ sessionId: 's2' })] }), 2000), true);
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry()] }), 3000), true);
});

// A Go map does not promise field order on the wire, so a comparison that went
// through JSON.stringify would read a re-marshal as a change and rebuild the
// board for nothing.
test('the same entry with its keys in a different order is not a change', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  const reordered = {};
  for (const k of Object.keys(entry()).reverse()) reordered[k] = entry()[k];
  assert.equal(noteDirectory(okWith({ 'acme/app': [reordered] }), 2000), false);
});

test('a failure keeps the last good snapshot, reports once, and recovery reports again', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  assert.equal(noteDirectory({ ok: false, error: 'ECONNREFUSED' }, 2000), true);
  const snap = directorySnapshot();
  assert.deepEqual(Object.keys(snap.repos), ['acme/app'], 'stale beats blank on a blip');
  assert.equal(snap.fetchedAt, 1000, 'and the "as of" does not lie about when');
  assert.equal(snap.error, 'ECONNREFUSED');

  assert.equal(noteDirectory({ ok: false, error: 'ECONNREFUSED' }, 3000), false, 'down→down is silent');
  assert.equal(noteDirectory({ ok: false, error: 'timed out' }, 4000), true, 'a different reason is a transition');

  // Coming back is a change even with byte-identical rows: the warning note
  // has to come off the view.
  assert.equal(noteDirectory(okWith({ 'acme/app': [entry()] }), 5000), true);
  assert.equal(directorySnapshot().error, null);
});

test('a malformed repos map cannot reach the graph', () => {
  for (const repos of [null, undefined, [], 'nope', 42]) {
    _resetDirectory();
    noteDirectory({ ok: true, repos }, 1000);
    assert.deepEqual(directorySnapshot().repos, {});
  }
  _resetDirectory();
  noteDirectory({ ok: true, repos: { 'acme/app': 'not an array' } }, 1000);
  assert.deepEqual(directorySnapshot().repos, { 'acme/app': [] });
});

test('_resetDirectory empties everything, so a test starts clean', () => {
  noteDirectory(okWith({ 'acme/app': [entry()] }), 1000);
  noteDirectory({ ok: false, error: 'boom' }, 2000);
  _resetDirectory();
  assert.deepEqual(directorySnapshot(), { repos: {}, fetchedAt: null, error: null });
});

test('the projected field list is the nine the view draws', () => {
  assert.deepEqual([...DIRECTORY_FIELDS].sort(), [
    'branch', 'detail', 'finishedAt', 'intent', 'messagingHandle',
    'origin', 'owner', 'sessionId', 'startedAt',
  ]);
});
