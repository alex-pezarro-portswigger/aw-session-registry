import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  postNote, listSessions, listAllSessions, send, drain, ack,
  setPerHandleFallback, usingPerHandleFallback,
  MAX_HANDLES_PER_DRAIN, MAX_IDS_PER_ACK,
} from '../lib/registry.js';

const BASE = 'https://registry.example.test';
const realFetch = globalThis.fetch;
let calls;

// A stubbed `fetch` rather than a real server: every assertion here is about
// the REQUEST this client makes (path, query, method, content-type, body) and
// about turning a failure into an `{ok:false}` instead of a throw.
function stub(responder) {
  calls = [];
  globalThis.fetch = async (target, opts = {}) => {
    calls.push({ url: String(target), ...opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = await responder(String(target), opts);
    if (r instanceof Error) throw r;
    return {
      ok: r.status == null || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      json: async () => { if (r.json === 'invalid') throw new Error('not json'); return r.json ?? {}; },
    };
  };
}

beforeEach(() => { setPerHandleFallback(false); });
afterEach(() => { globalThis.fetch = realFetch; setPerHandleFallback(false); });

// ── postNote ─────────────────────────────────────────────────────────────────

test('postNote posts exactly the two fields it has any business sending', async () => {
  stub(() => ({ json: { session: {} } }));
  const res = await postNote(BASE, 'card-1', { repo: 'acme/app', messagingHandle: 'card-1' });
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, `${BASE}/v1/sessions/card-1/note`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  // intent and detail are OMITTED, never sent empty: they are *string on the Go
  // side, so an empty string would CLEAR agent-authored text.
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['messagingHandle', 'repo']);
});

// THE REGRESSION THIS GUARDS: `origin` is what switches the note endpoint's
// upsert into a CREATE, and this extension notes every live card in a git repo.
// Sending it minted a shell ledger row — empty intent, empty detail, empty
// branch, no owner — for every card that had never registered. `NoteRequest`
// cannot carry branch or owner fields at all, so the row could never be filled
// in afterwards.
test('postNote NEVER sends origin — that is what created blank ledger entries', async () => {
  stub(() => ({ json: {} }));
  await postNote(BASE, 'card-1', { repo: 'acme/app', messagingHandle: 'card-1' });
  assert.equal('origin' in calls[0].body, false);
  // Not even when a caller tries to pass one: the option is gone, so an
  // `origin` in the options object must not reach the wire.
  await postNote(BASE, 'card-2', { repo: 'acme/app', messagingHandle: 'card-2', origin: 'local' });
  assert.equal('origin' in calls[1].body, false);
});

// With no origin the create path is closed, so the registry answers 404 for a
// card it has never heard of. Callers need to tell that apart from an outage,
// and `status === 404` at three call sites is a detail this module owns.
test('a 404 comes back flagged notFound, so callers need not read a status code', async () => {
  stub(() => ({ status: 404, json: { error: 'no such session on this repo, and no origin was supplied to create one' } }));
  const res = await postNote(BASE, 'card-1', { repo: 'acme/app', messagingHandle: 'card-1' });
  assert.equal(res.ok, false);
  assert.equal(res.notFound, true);
  assert.match(res.error, /no such session on this repo/);
});

test('notFound is false for every other failure, so an outage is never read as a missing entry', async () => {
  for (const status of [400, 500, 503]) {
    stub(() => ({ status, json: { error: 'boom' } }));
    const res = await postNote(BASE, 'card-1', { repo: 'acme/app', messagingHandle: 'card-1' });
    assert.equal(res.ok, false, `status ${status}`);
    assert.equal(res.notFound, false, `status ${status}`);
  }
  // A thrown fetch (refused, DNS, timeout) has no status at all.
  stub(() => new Error('ECONNREFUSED'));
  const res = await postNote(BASE, 'card-1', { repo: 'acme/app', messagingHandle: 'card-1' });
  assert.equal(res.ok, false);
  assert.ok(!res.notFound);
});

test('postNote url-encodes the card id into the path', async () => {
  stub(() => ({ json: {} }));
  await postNote(BASE, 'card/../evil', { repo: 'acme/app', messagingHandle: 'x' });
  assert.equal(calls[0].url, `${BASE}/v1/sessions/card%2F..%2Fevil/note`);
});

test('postNote refuses a missing card id or repo without touching the network', async () => {
  stub(() => ({ json: {} }));
  assert.equal((await postNote(BASE, '', { repo: 'acme/app' })).ok, false);
  assert.equal((await postNote(BASE, 'card-1', {})).ok, false);
  assert.equal(calls.length, 0);
});

// ── the base URL ─────────────────────────────────────────────────────────────

test('a base URL with a path keeps it, and a trailing slash is not doubled', async () => {
  stub(() => ({ json: {} }));
  await postNote('https://host.test/registry/', 'c', { repo: 'a/b', messagingHandle: 'c' });
  assert.equal(calls[0].url, 'https://host.test/registry/v1/sessions/c/note');
});

test('a non-http(s) or unparseable base URL is an error, not a fetch', async () => {
  stub(() => ({ json: {} }));
  for (const bad of ['', 'not a url', 'file:///etc/passwd', 'ftp://host/x', null, undefined]) {
    const res = await postNote(bad, 'c', { repo: 'a/b', messagingHandle: 'c' });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.match(res.error, /not a valid http\(s\) URL/);
  }
  assert.equal(calls.length, 0);
});

// ── listSessions ─────────────────────────────────────────────────────────────

test('listSessions hits the per-repo route and always returns an array', async () => {
  stub(() => ({ json: { repo: 'acme/app', sessions: [{ sessionId: 'a' }] } }));
  const res = await listSessions(BASE, 'acme/app');
  assert.equal(calls[0].url, `${BASE}/v1/repos/acme/app/sessions`);
  assert.deepEqual(res.sessions, [{ sessionId: 'a' }]);

  stub(() => ({ json: {} }));
  assert.deepEqual((await listSessions(BASE, 'acme/app')).sessions, []);
});

test('listSessions refuses anything that is not <owner>/<repo>', async () => {
  stub(() => ({ json: {} }));
  for (const bad of ['acme', 'acme/app/extra', '/app', 'acme/', '']) {
    assert.equal((await listSessions(BASE, bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});

// ── send ─────────────────────────────────────────────────────────────────────

test('send posts the payload through and returns the assigned envelope', async () => {
  stub(() => ({ json: { message: { id: 'srv-1', createdAt: 'now' } } }));
  const payload = { toRepo: 'acme/app', toHandle: 'them', fromRepo: 'acme/app', fromHandle: 'me', body: 'hi' };
  const res = await send(BASE, payload);
  assert.equal(calls[0].url, `${BASE}/v1/messages`);
  assert.deepEqual(calls[0].body, payload);
  assert.deepEqual(res.message, { id: 'srv-1', createdAt: 'now' });
});

// ── drain: batched ───────────────────────────────────────────────────────────

test('the batched drain is ONE request for many handles', async () => {
  stub(() => ({ json: { messages: [{ id: 'a', toHandle: 'h1' }, { id: 'b', toHandle: 'h3' }] } }));
  const res = await drain(BASE, 'acme/app', ['h1', 'h2', 'h3']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/v1/messages?repo=acme%2Fapp&handles=h1,h2,h3`);
  assert.deepEqual(res.messages.map((m) => m.id), ['a', 'b']);
});

test('the batched drain chunks at the registry"s 100-handle cap', async () => {
  stub(() => ({ json: { messages: [] } }));
  const handles = Array.from({ length: MAX_HANDLES_PER_DRAIN + 5 }, (_, i) => `h${i}`);
  await drain(BASE, 'acme/app', handles);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.split('handles=')[1].split(',').length, MAX_HANDLES_PER_DRAIN);
  assert.equal(calls[1].url.split('handles=')[1].split(',').length, 5);
});

test('an empty or duplicate-only handle list makes no request at all', async () => {
  stub(() => ({ json: { messages: [] } }));
  assert.deepEqual((await drain(BASE, 'acme/app', [])).messages, []);
  assert.deepEqual((await drain(BASE, 'acme/app', [null, '', undefined])).messages, []);
  assert.equal(calls.length, 0);
  await drain(BASE, 'acme/app', ['h1', 'h1', 'h1']);
  assert.equal(calls[0].url.endsWith('handles=h1'), true, 'handles are de-duplicated');
});

// ── drain: the per-handle fallback ───────────────────────────────────────────

test('the per-handle fallback is one request PER handle — the cost C exists to remove', async () => {
  setPerHandleFallback(true);
  assert.equal(usingPerHandleFallback(), true);
  stub((target) => ({ json: { messages: [{ id: target.endsWith('h1') ? 'a' : 'b' }] } }));
  const res = await drain(BASE, 'acme/app', ['h1', 'h2']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${BASE}/v1/messages?repo=acme%2Fapp&handle=h1`);
  assert.equal(calls[1].url, `${BASE}/v1/messages?repo=acme%2Fapp&handle=h2`);
  assert.deepEqual(res.messages.map((m) => m.id), ['a', 'b']);
});

// ── failure ──────────────────────────────────────────────────────────────────

test('a network failure is {ok:false}, never a throw — a throwing sweep logs every tick', async () => {
  stub(() => new Error('ECONNREFUSED'));
  for (const call of [
    () => postNote(BASE, 'c', { repo: 'a/b', messagingHandle: 'c' }),
    () => listSessions(BASE, 'a/b'),
    () => send(BASE, {}),
    () => drain(BASE, 'a/b', ['h']),
    () => ack(BASE, 'a/b', [{ id: 'x', toHandle: 'h' }]),
  ]) {
    const res = await call();
    assert.equal(res.ok, false);
    assert.match(res.error, /ECONNREFUSED/);
  }
});

test('a timeout says so, and names the budget', async () => {
  stub(() => Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
  const res = await listSessions(BASE, 'a/b');
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out after 5000ms/);
});

test('every request carries an abort signal, so a hung registry cannot wedge a sweep', async () => {
  stub(() => ({ json: {} }));
  await listSessions(BASE, 'a/b');
  assert.ok(calls[0].signal, 'no AbortSignal on the request');
});

test('a 5xx becomes {ok:false} carrying the registry"s own error text and the status', async () => {
  stub(() => ({ status: 503, json: { error: 'redis is unavailable' } }));
  const res = await drain(BASE, 'a/b', ['h']);
  assert.equal(res.ok, false);
  assert.match(res.error, /redis is unavailable/);
});

test('a non-JSON error body falls back to the status code', async () => {
  stub(() => ({ status: 502, json: 'invalid' }));
  const res = await listSessions(BASE, 'a/b');
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 502/);
});

test('a 200 with an unreadable body is still ok, with an empty payload', async () => {
  stub(() => ({ status: 200, json: 'invalid' }));
  assert.deepEqual((await listSessions(BASE, 'a/b')).sessions, []);
});

test('a partly-failed multi-chunk drain reports what it missed rather than hiding it', async () => {
  let n = 0;
  stub(() => (n++ === 0 ? { json: { messages: [{ id: 'a' }] } } : { status: 500, json: { error: 'boom' } }));
  const handles = Array.from({ length: MAX_HANDLES_PER_DRAIN + 1 }, (_, i) => `h${i}`);
  const res = await drain(BASE, 'acme/app', handles);
  assert.equal(res.ok, true, 'what did arrive is still usable');
  assert.deepEqual(res.messages.map((m) => m.id), ['a']);
  assert.equal(res.partial.length, 1);
});

// ── ack ──────────────────────────────────────────────────────────────────────

test('the batched ack is one request of bare ids, spanning handles', async () => {
  stub(() => ({ json: { acked: 2 } }));
  const res = await ack(BASE, 'acme/app', [{ id: 'a', toHandle: 'h1' }, { id: 'b', toHandle: 'h2' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/v1/messages/ack`);
  assert.deepEqual(calls[0].body, { repo: 'acme/app', ids: ['a', 'b'] });
  assert.equal(res.acked, 2);
});

test('the batched ack chunks at the registry"s 500-id cap and de-duplicates', async () => {
  stub(() => ({ json: { acked: 1 } }));
  const items = Array.from({ length: MAX_IDS_PER_ACK + 3 }, (_, i) => ({ id: `m${i}`, toHandle: 'h' }));
  await ack(BASE, 'acme/app', [...items, ...items.slice(0, 5)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.ids.length, MAX_IDS_PER_ACK);
  assert.equal(calls[1].body.ids.length, 3);
});

test('the per-handle ack groups ids by their target handle', async () => {
  setPerHandleFallback(true);
  stub(() => ({ json: { acked: 1 } }));
  await ack(BASE, 'acme/app', [{ id: 'a', toHandle: 'h1' }, { id: 'b', toHandle: 'h2' }, { id: 'c', toHandle: 'h1' }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { repo: 'acme/app', handle: 'h1', ids: ['a', 'c'] });
  assert.deepEqual(calls[1].body, { repo: 'acme/app', handle: 'h2', ids: ['b'] });
});

test('acking nothing is a no-op, not a request', async () => {
  stub(() => ({ json: { acked: 0 } }));
  assert.deepEqual(await ack(BASE, 'acme/app', []), { ok: true, acked: 0 });
  assert.deepEqual(await ack(BASE, 'acme/app', [{ id: '' }, null]), { ok: true, acked: 0 });
  assert.equal(calls.length, 0);
});

// ── listAllSessions ──────────────────────────────────────────────────────────

test('listAllSessions hits GET /v1/sessions and returns the repo map', async () => {
  stub(() => ({ json: { repos: { 'acme/app': [{ sessionId: 'a' }] }, since: '24h0m0s' } }));
  const res = await listAllSessions(BASE);
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, `${BASE}/v1/sessions`);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].headers, {}, 'a GET carries no body and so no content-type');
  assert.equal(calls[0].body, null);
  assert.deepEqual(res.repos, { 'acme/app': [{ sessionId: 'a' }] });
});

// The graph tick may not throw, so nothing malformed may reach it.
test('listAllSessions normalises a missing or non-object repos to an empty map', async () => {
  for (const json of [{}, { repos: null }, { repos: [] }, { repos: 'nope' }, { repos: 7 }]) {
    stub(() => ({ json }));
    assert.deepEqual((await listAllSessions(BASE)).repos, {}, JSON.stringify(json));
  }
  stub(() => ({ json: { repos: { 'acme/app': 'not an array', 'acme/other': [{ sessionId: 'b' }] } } }));
  assert.deepEqual((await listAllSessions(BASE)).repos, { 'acme/app': [], 'acme/other': [{ sessionId: 'b' }] });
});

test('a network failure from listAllSessions is {ok:false}, never a throw', async () => {
  stub(() => new Error('ECONNREFUSED'));
  const res = await listAllSessions(BASE);
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

test('a 500 from listAllSessions carries the registry"s own reason and status', async () => {
  stub(() => ({ status: 500, json: { error: 'list failed' } }));
  const res = await listAllSessions(BASE);
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.match(res.error, /list failed/);
});

test('an unusable base URL is an error rather than a fetch, here too', async () => {
  stub(() => ({ json: {} }));
  assert.equal((await listAllSessions('file:///etc/passwd')).ok, false);
  assert.equal(calls.length, 0);
});
