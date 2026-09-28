import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPeerMessageTool, listPeerSessionsTool, listRepoSessionsTool, updateSessionNoteTool } from '../lib/tools.js';
import { PeerMessageStore, MAX_BODY_CHARS } from '../lib/store.js';
import { _resetRepoKeyCache, _setGitOriginForTests } from '../lib/repo-key.js';
import { onBeforeDispatch } from '../lib/hooks.js';
import { clearPromptCwd } from '../lib/prompt-context.js';
import { _resetGitNameCache, _setGitNameForTests } from '../lib/git-identity.js';

const BASE = 'https://registry.example.test';
const realFetch = globalThis.fetch;

function harness({ registryUrl = BASE, sessions = { 'card-1': { cwd: '/w/app' } } } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peer-tools-')), 'state.json');
  const store = new PeerMessageStore({ file });
  const calls = [];
  let rebuilds = 0;
  const host = {
    settings: { get: (k) => ({ registryUrl }[k]) },
    stores: { peerMessages: store },
    sessions: { get: (id) => sessions[id] ?? null },
    rebuild: () => { rebuilds += 1; },
  };
  return {
    host, store, calls, rebuilds: () => rebuilds,
    stub(responder) {
      globalThis.fetch = async (target, opts = {}) => {
        calls.push({ url: String(target), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        const r = (await responder(String(target))) || {};
        return { ok: r.status == null || r.status < 300, status: r.status ?? 200, json: async () => r.json ?? {} };
      };
    },
  };
}

// repoKeyFor shells out to `git remote get-url origin`; the tools reach it
// through an MCP handler signature with nowhere to thread an option, so the
// answer is injected at the module seam instead of by standing up a real
// checkout.
function fakeGit(originUrl) {
  _setGitOriginForTests(async () => originUrl);
}

// Same seam for `git config user.name`.
function fakeGitName(name) {
  _setGitNameForTests(async () => name);
}

function text(result) {
  return result.content.map((c) => c.text).join('\n');
}

beforeEach(() => { _resetRepoKeyCache(); _resetGitNameCache(); fakeGitName(null); });
afterEach(() => {
  globalThis.fetch = realFetch;
  _setGitOriginForTests(null); _resetRepoKeyCache();
  _setGitNameForTests(null); _resetGitNameCache();
});

// ── send_peer_message ────────────────────────────────────────────────────────

test('send_peer_message resolves the caller"s repo, sets fromDisplay from the git name, and logs it outbound', async () => {
  fakeGit('git@github.com:acme/app.git');
  fakeGitName('Sam Rivera\n');
  const h = harness();
  h.stub(() => ({ json: { message: { id: 'srv-9' } } }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'peer-card', text: 'ping' });

  assert.equal(res.isError, undefined);
  assert.equal(h.calls[0].url, `${BASE}/v1/messages`);
  // toRepo === fromRepo BY CONSTRUCTION: same-repo only, and there is no
  // parameter through which to ask for anything else.
  assert.deepEqual(h.calls[0].body, {
    toRepo: 'acme/app', toHandle: 'peer-card', fromRepo: 'acme/app', fromHandle: 'card-1', body: 'ping',
    fromDisplay: 'Sam Rivera',
  });

  assert.deepEqual(h.store.threadFor('card-1', 'peer-card').map((x) => [x.dir, x.body]), [['out', 'ping']]);
  assert.equal(h.rebuilds(), 1);
  assert.match(text(res), /has to approve it/);
});

test('omits fromDisplay entirely when no git name is configured', async () => {
  fakeGit('git@github.com:acme/app.git');
  fakeGitName(null);
  const h = harness();
  h.stub(() => ({ json: { message: { id: 'srv-10' } } }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'peer-card', text: 'ping' });
  assert.equal(res.isError, undefined);
  // Absent, never '': the Go side treats an empty string as a clear.
  assert.equal('fromDisplay' in h.calls[0].body, false);
  assert.notEqual(h.calls[0].body.fromDisplay, '');
});

test('a caller whose folder is not a git checkout is told that, clearly', async () => {
  fakeGit(null);
  const h = harness();
  h.stub(() => ({ json: {} }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'x', text: 'y' });
  assert.equal(res.isError, true);
  assert.match(text(res), /not a git checkout with an origin remote/);
  assert.equal(h.calls.length, 0);
});

test('an unknown or absent caller is refused rather than sent unattributed', async () => {
  const h = harness();
  h.stub(() => ({ json: {} }));
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: null }, { to: 'x', text: 'y' })), /which session is calling/);
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: 'ghost' }, { to: 'x', text: 'y' })), /No Agent Wrangler session is registered/);
  assert.equal(h.calls.length, 0);
});

test('no configured registry URL uses the plugin default', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness({ registryUrl: null });
  h.stub(() => ({ json: {} }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'x', text: 'y' });
  assert.equal(res.isError, undefined);
  assert.match(h.calls[0].url, /^https:\/\/session-registry\.platform-dev\.portswigger\.io\//);
});

test('missing arguments and messaging yourself are refused before the network', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: {} }));
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { text: 'y' })), /`to` is required/);
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'x' })), /`text` is required/);
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: '  ', text: 'y' })), /`to` is required/);
  assert.match(text(await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'card-1', text: 'y' })), /own handle/);
  assert.equal(h.calls.length, 0);
});

// Refused, not truncated: the relay would cut it silently, and a message whose
// last sentence vanished is worse than being told to shorten it.
test('an over-long body is REFUSED with the limit named, not silently truncated', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: {} }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'p', text: 'x'.repeat(MAX_BODY_CHARS + 1) });
  assert.equal(res.isError, true);
  assert.match(text(res), new RegExp(`${MAX_BODY_CHARS}-character limit`));
  assert.equal(h.calls.length, 0);
});

test('a registry failure is reported and NOTHING is logged as sent', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ status: 503, json: { error: 'redis down' } }));
  const res = await sendPeerMessageTool.handler({ host: h.host, caller: 'card-1' }, { to: 'p', text: 'ping' });
  assert.equal(res.isError, true);
  assert.match(text(res), /redis down/);
  assert.deepEqual(h.store.threadFor('card-1', 'p'), [], 'a failed send is not in the thread as if it went');
  assert.equal(h.rebuilds(), 0);
});

// ── list_peer_sessions ───────────────────────────────────────────────────────

test('list_peer_sessions excludes self, finished rows and handle-less rows', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: { repo: 'acme/app', sessions: [
    { sessionId: 'card-1', messagingHandle: 'card-1', owner: 'Me', finishedAt: null },
    { sessionId: 'p1', messagingHandle: 'peer-a', owner: 'Sam Rivera', origin: 'local', intent: 'refactor hooks', branch: 'x', finishedAt: null },
    { sessionId: 'p2', messagingHandle: 'peer-b', finishedAt: '2026-09-18T09:00:00Z' },
    { sessionId: 'p3', messagingHandle: '', owner: 'No handle', finishedAt: null },
    { sessionId: 'p4', owner: 'Also no handle', finishedAt: null },
  ] } }));
  const res = await listPeerSessionsTool.handler({ host: h.host, caller: 'card-1' });
  assert.equal(h.calls[0].url, `${BASE}/v1/repos/acme/app/sessions`);
  const payload = JSON.parse(text(res));
  assert.deepEqual(payload.peers.map((p) => p.handle), ['peer-a']);
  assert.equal(payload.peers[0].owner, 'Sam Rivera');
  assert.equal(payload.repo, 'acme/app');
});

test('a row with no owner is "unattributed", which is a value not a gap', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: { sessions: [{ messagingHandle: 'peer-a', finishedAt: null }] } }));
  const payload = JSON.parse(text(await listPeerSessionsTool.handler({ host: h.host, caller: 'card-1' })));
  assert.equal(payload.peers[0].owner, 'unattributed');
});

// An empty list has two very different causes, and an agent that assumes the
// wrong one either gives up or retries for ever.
test('an empty peer list says there is nobody to message', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: { sessions: [] } }));
  assert.match(text(await listPeerSessionsTool.handler({ host: h.host, caller: 'card-1' })), /nobody to message/);
});

test('list_peer_sessions never involves message bodies at all', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: { sessions: [{ messagingHandle: 'peer-a', finishedAt: null, detail: 'long detail' }] } }));
  const payload = JSON.parse(text(await listPeerSessionsTool.handler({ host: h.host, caller: 'card-1' })));
  assert.deepEqual(Object.keys(payload.peers[0]).sort(), ['branch', 'handle', 'intent', 'origin', 'owner', 'startedAt']);
});

test('both tools declare a zod-shaped inputSchema the MCP SDK can register', () => {
  assert.equal(typeof sendPeerMessageTool.inputSchema.to.parse, 'function');
  assert.equal(typeof sendPeerMessageTool.inputSchema.text.parse, 'function');
  assert.deepEqual(listPeerSessionsTool.inputSchema, {});
});

test('update_session_note writes only agent-supplied fields to this card', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: { session: { intent: 'make registry tools', detail: 'lib/tools.js' } } }));
  const res = await updateSessionNoteTool.handler({ host: h.host, caller: 'card-1' },
    { intent: 'make registry tools', detail: 'lib/tools.js' });
  assert.equal(res.isError, undefined);
  assert.equal(h.calls[0].url, `${BASE}/v1/sessions/card-1/note`);
  assert.deepEqual(h.calls[0].body, { repo: 'acme/app', intent: 'make registry tools', detail: 'lib/tools.js' });
  assert.match(text(res), /make registry tools/);
  assert.equal(h.store.isIntentNoted('card-1'), true);
});

test('a failed registry note leaves the prompt reminder armed', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ status: 503, json: { error: 'down' } }));
  assert.equal((await updateSessionNoteTool.handler({ host: h.host, caller: 'card-1' }, { intent: 'work' })).isError, true);
  assert.equal(h.store.isIntentNoted('card-1'), false);
});

test('a first-turn note resolves its repo before dispatch saves the card', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness({ sessions: {} });
  h.stub(() => ({ json: { session: { intent: 'first turn' } } }));
  onBeforeDispatch({ sessionId: 'card-early', cwd: '/w/app' });
  const res = await updateSessionNoteTool.handler({ host: h.host, caller: 'card-early' }, { intent: 'first turn' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(h.calls[0].body, { repo: 'acme/app', intent: 'first turn' });
  clearPromptCwd('card-early');
});

test('registry note tool refuses a stale repo or session id before writing', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  h.stub(() => ({ json: {} }));
  for (const args of [{ repo: 'wrong/repo', intent: 'x' }, { session_id: 'other', intent: 'x' },
    { messaging_handle: 'other', intent: 'x' }, { messaging_handle: 'card-1' }]) {
    assert.equal((await updateSessionNoteTool.handler({ host: h.host, caller: 'card-1' }, args)).isError, true);
  }
  assert.equal(h.calls.length, 0);
});

test('list_repo_sessions includes handle-less and finished peers, with filters', async () => {
  fakeGit('git@github.com:acme/app.git');
  const h = harness();
  const recent = new Date().toISOString();
  h.stub(() => ({ json: { sessions: [
    { sessionId: 'card-1', startedAt: recent },
    { sessionId: 'peer-a', startedAt: recent, intent: 'work' },
    { sessionId: 'peer-b', startedAt: recent, finishedAt: recent },
  ] } }));
  const all = JSON.parse(text(await listRepoSessionsTool.handler({ host: h.host, caller: 'card-1' })));
  assert.deepEqual(all.sessions.map((s) => s.sessionId), ['peer-a', 'peer-b']);
  const live = JSON.parse(text(await listRepoSessionsTool.handler({ host: h.host, caller: 'card-1' }, { live_only: true })));
  assert.deepEqual(live.sessions.map((s) => s.sessionId), ['peer-a']);
});
