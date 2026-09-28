import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onDispatch, onResume, onPrompt, onArchive, onPurge } from '../lib/hooks.js';
import { PeerMessageStore } from '../lib/store.js';
import { _resetRepoKeyCache, _setGitOriginForTests } from '../lib/repo-key.js';
import { _setGitBranchForTests, _setGitIdentityForTests } from '../lib/git-facts.js';

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

// What the registry answers for a card it has never heard of, now that
// `postNote` sends no `origin` and so cannot create one. The COMMON case: most
// cards never register with the registry at all.
function notFoundFetch(calls) {
  globalThis.fetch = async (target, opts = {}) => {
    calls.push({ url: String(target), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'no such session on this repo, and no origin was supplied to create one' }),
    };
  };
}

beforeEach(() => {
  _resetRepoKeyCache();
  _setGitOriginForTests(async () => 'git@github.com:acme/app.git');
  _setGitBranchForTests(async () => 'feat/x');
  _setGitIdentityForTests(async () => ({ name: 'Sam Rivera', email: 'sam@example.com' }));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  _setGitOriginForTests(null); _setGitBranchForTests(null); _setGitIdentityForTests(null);
  _resetRepoKeyCache();
});

const notes = (calls) => calls.filter((c) => c.url.endsWith('/note'));

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

test('onPrompt adds same-prompt context at most three times and stops once noted', async () => {
  const h = harness();
  okFetch(h.calls);
  for (let i = 0; i < 3; i++) {
    const result = await onPrompt({ sessionId: 'card-1', cwd: '/w/app', entry: null, host: h.host });
    assert.match(result.additionalContext, /update_session_note/);
    assert.match(result.additionalContext, /card-1/);
  }
  assert.equal(await onPrompt({ sessionId: 'card-1', cwd: '/w/app', host: h.host }), undefined);
  assert.equal(h.store.markIntentNoted('card-2'), true);
  assert.equal(await onPrompt({ sessionId: 'card-2', cwd: '/w/app', host: h.host }), undefined);
});

test('onPrompt stays silent without a registry URL or git repo', async () => {
  const unconfigured = harness({ registryUrl: null });
  assert.equal(await onPrompt({ sessionId: 'card-1', cwd: '/w/app', host: unconfigured.host }), undefined);
  const h = harness();
  _setGitOriginForTests(async () => null);
  assert.equal(await onPrompt({ sessionId: 'card-1', cwd: '/tmp/scratch', host: h.host }), undefined);
  assert.equal(h.store.nextIntentReminder('card-1'), true, 'a no-repo prompt did not spend a reminder');
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

test('the published handle IS the card id, with intent and detail omitted from the note', async () => {
  const h = harness();
  okFetch(h.calls);
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  const n = notes(h.calls);
  assert.equal(n.length, 1);
  assert.equal(n[0].url, `${BASE}/v1/sessions/card-1/note`);
  assert.deepEqual(n[0].body, { repo: 'acme/app', messagingHandle: 'card-1' });
  // No `origin`: sending it made the note endpoint CREATE a blank ledger entry
  // for a card that had never registered. See lib/registry.js.
  assert.equal('origin' in n[0].body, false);
});

test('onDispatch registers THEN notes, with the card intent, a one-line detail, git branch and owner', async () => {
  const h = harness();
  okFetch(h.calls);
  const entry = { cwd: '/w/app', intent: 'wire the drain', runtime: 'runner', name: 'Drain work', worktree: { branch: 'wt/drain' } };
  onDispatch({ sessionId: 'card-1', entry, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls.map((c) => c.url), [`${BASE}/v1/sessions`, `${BASE}/v1/sessions/card-1/note`]);
  assert.deepEqual(h.calls[0].body, {
    repo: 'acme/app', sessionId: 'card-1', origin: 'runner', branch: 'feat/x',
    intent: 'wire the drain',
    detail: 'Agent Wrangler card · cwd /w/app · worktree wt/drain · task Drain work',
    ownerName: 'Sam Rivera', ownerEmail: 'sam@example.com',
  });
  assert.doesNotMatch(h.calls[0].body.detail, /\n/);
});

test('the first prompt receives the registry brief as context, without a separate delivered turn', async () => {
  const h = harness();
  const delivered = [];
  h.host.deliver = async (id, body) => { delivered.push({ id, body }); return { mode: 'live' }; };
  globalThis.fetch = async (target, opts = {}) => {
    h.calls.push({ url: String(target), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => String(target).endsWith('/v1/brief')
      ? { hookSpecificOutput: { additionalContext: '2 other sessions on acme/app\n    SendMessage to "peer-card"\n\nYou should set your intent with update_session_note now, before you edit, and\nPass messaging_handle from ListAgents.' } }
      : { session: {} } };
  };
  const first = await onPrompt({ sessionId: 'card-1', cwd: '/w/app', entry: null, prompt: 'start work', host: h.host });
  assert.match(first.additionalContext, /2 other sessions on acme\/app/);
  assert.match(first.additionalContext, /untrusted/);
  assert.match(first.additionalContext, /send_peer_message to "peer-card"/);
  assert.doesNotMatch(first.additionalContext, /ListAgents|SendMessage to/);
  assert.equal(h.calls[0].url, `${BASE}/v1/brief`);
  assert.equal(h.calls[0].body.onlyIfUnbriefed, true);
  assert.deepEqual(delivered, []);
  assert.equal(onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app', intent: 'work' }, host: h.host }), undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls.map((c) => c.url), [
    `${BASE}/v1/brief`, `${BASE}/v1/sessions`, `${BASE}/v1/sessions/card-1/note`,
  ]);
  await onPrompt({ sessionId: 'card-1', cwd: '/w/app', host: h.host });
  onResume({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.filter((c) => c.url.endsWith('/v1/brief')).length, 1);
});

test('an agent note written on the first prompt is not overwritten by dispatch', async () => {
  const h = harness();
  okFetch(h.calls);
  await onPrompt({ sessionId: 'card-1', cwd: '/w/app', entry: null, host: h.host });
  h.store.markIntentNoted('card-1');
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app', intent: 'stale launch intent' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  const registration = h.calls.find((c) => c.url === `${BASE}/v1/sessions`);
  assert.equal('intent' in registration.body, false);
  assert.equal('detail' in registration.body, false);
});

test('onResume registers then notes with intent and detail ABSENT, so the agent text survives', async () => {
  const h = harness();
  okFetch(h.calls);
  onResume({ sessionId: 'card-1', entry: { cwd: '/w/app', intent: 'stale card intent', name: 'x' }, reason: 'message', host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls.map((c) => c.url), [`${BASE}/v1/sessions`, `${BASE}/v1/sessions/card-1/note`]);
  assert.equal('intent' in h.calls[0].body, false);
  assert.equal('detail' in h.calls[0].body, false);
  assert.equal(h.calls[0].body.branch, 'feat/x');
});

test('runtime maps to the registry origin: runner, hosted, and local for everything else', async () => {
  for (const [runtime, origin] of [['runner', 'runner'], ['hosted', 'hosted'], ['devcontainer', 'local'], [undefined, 'local']]) {
    const h = harness();
    okFetch(h.calls);
    onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app', runtime }, host: h.host });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.calls[0].body.origin, origin, `runtime ${runtime}`);
  }
});

test('a register failure still attempts the note, and logs one line', async () => {
  const h = harness();
  globalThis.fetch = async (target, opts = {}) => {
    h.calls.push({ url: String(target), method: opts.method, body: JSON.parse(opts.body) });
    return String(target).endsWith('/v1/sessions')
      ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      : { ok: true, status: 200, json: async () => ({}) };
  };
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notes(h.calls).length, 1);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /could not register/);
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
  okFetch(h.calls);
  onArchive({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
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

// Found in verification: without this, an archived card kept its handle on the
// registry, peers were still offered it by list_peer_sessions, and a send to it
// ended up pending on a card nobody was looking at — with no receipts to say so.
// And it closes the row out: this extension registered it, so it ends it — and
// a finished row is the only kind the registry can prune under its per-repo cap.
test('archive closes the row out AND clears the handle, with an empty string (nil would leave it)', async () => {
  const h = harness();
  okFetch(h.calls);
  onArchive({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, `${BASE}/v1/sessions/card-1/close-out`);
  assert.deepEqual(h.calls[0].body, { repo: 'acme/app', branch: 'feat/x' });
  assert.equal(h.calls[1].url, `${BASE}/v1/sessions/card-1/note`);
  assert.deepEqual(h.calls[1].body, { repo: 'acme/app', messagingHandle: '' });
  assert.equal('origin' in h.calls[1].body, false);
});

test('archive returns undefined — the core awaits it, so the unpublish is fire-and-forget', () => {
  const h = harness();
  hangingFetch(h.calls);
  assert.equal(onArchive({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host }), undefined);
});

// onPurge's payload is {sessionId} alone — no entry, so no cwd, so no repo key.
// A purge always follows an archive, which has already cleared the handle.
test('purge does not try to reach the registry at all', async () => {
  const h = harness();
  okFetch(h.calls);
  onPurge({ sessionId: 'card-1', host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, []);
});

test('archive and purge of a card with nothing stored do not rebuild for nothing', () => {
  const h = harness();
  okFetch(h.calls);
  onArchive({ sessionId: 'nobody', entry: { cwd: '/w/app' }, host: h.host });
  onPurge({ sessionId: 'nobody', host: h.host });
  assert.equal(h.rebuilds(), 0);
});

test('archive and purge are synchronous — the core awaits them too', () => {
  const h = harness();
  okFetch(h.calls);
  h.store.receive('card-1', { id: 'a', fromHandle: 'p', body: 'x' });
  assert.equal(onArchive({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host }), undefined);
  assert.equal(onPurge({ sessionId: 'card-1', host: h.host }), undefined);
});

// ── A card with no ledger entry: the ordinary case, and it must be SILENT ────

test('a 404 on publish says nothing — most cards never registered, and the sweep cannot fix it', async () => {
  const h = harness();
  notFoundFetch(h.calls);
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notes(h.calls).length, 1, 'it still tried');
  assert.deepEqual(h.logs, [], 'a line here would be one per dispatch for a working system');
});

test('a 404 on the archive close-out and unpublish says nothing either — no entry, nothing to end', async () => {
  const h = harness();
  notFoundFetch(h.calls);
  onArchive({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.logs, []);
});

// The 404 silence must not swallow a real failure: a 500 is still worth a line.
test('a 500 on publish is STILL logged — only the missing-entry 404 is silent', async () => {
  const h = harness();
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  onDispatch({ sessionId: 'card-1', entry: { cwd: '/w/app' }, host: h.host });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /could not publish/);
});
