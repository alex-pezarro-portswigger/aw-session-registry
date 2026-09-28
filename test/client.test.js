import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// A DOM stub rather than jsdom, matching the board's own public/ tests
// (slots.test.js, checklist-dom.test.js). It records how text got in, which is
// the point: the ONE rule this file exists to prove is that every peer-supplied
// string lands via textContent and never as parsed markup.
function stubDocument() {
  const created = [];
  function make(tag = 'div') {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      type: '',
      title: '',
      disabled: false,
      children: [],
      parentNode: null,
      dataset: {},
      listeners: {},
      attrs: {},
      hidden: false,
      _text: '',
      _value: '',
      // A <select>'s value is whatever was set IF an option still carries it,
      // else the first option — the browser's own rule, and the one the
      // view's "only accept a stored repo the options contain" depends on.
      get options() {
        return this.tagName === 'SELECT' ? this.children.filter((c) => c.tagName === 'OPTION') : [];
      },
      get value() {
        if (this.tagName !== 'SELECT') return this._value;
        const opts = this.options;
        if (!opts.length) return '';
        return opts.some((o) => o.value === this._value) ? this._value : opts[0].value;
      },
      set value(v) { this._value = String(v); },
      // The ONLY text channel this stub offers. There is deliberately no
      // innerHTML setter: a client that tried to use one would throw here and
      // the test would fail rather than pass quietly.
      get textContent() {
        return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) { this._text = String(v); this.children = []; },
      appendChild(c) { this.children.push(c); c.parentNode = node; return c; },
      replaceChildren(...kids) {
        for (const c of this.children) c.parentNode = null;
        this.children = kids;
        for (const c of kids) c.parentNode = node;
        this._text = '';
      },
      removeAttribute() {},
      setAttribute(name, v) { node.attrs[name] = String(v); },
      // Nothing in the view is inside a <details> unless a test says so, so
      // the honest default is null; the details-swallows-the-click test
      // overrides it on the one node it is about.
      closest() { return null; },
      addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
      querySelector(sel) { return find(node, sel); },
      querySelectorAll(sel) { return all(node, sel.replace(/^\./, '')); },
      click(ev) { for (const fn of node.listeners.click || []) fn(ev || { target: node }); },
    };
    created.push(node);
    return node;
  }
  // Enough of a selector engine for `.class` lookups, which is all the client
  // uses.
  function find(root, sel) {
    const want = sel.replace(/^\./, '');
    for (const c of root.children) {
      if (String(c.className).split(/\s+/).includes(want)) return c;
      const deeper = find(c, sel);
      if (deeper) return deeper;
    }
    return null;
  }
  return { createElement: make, make, created, find };
}

function all(node, className, out = []) {
  for (const c of node.children || []) {
    if (String(c.className).split(/\s+/).includes(className)) out.push(c);
    all(c, className, out);
  }
  return out;
}

function findButton(node, label) {
  return all(node, 'peer-btn').find((b) => b.textContent === label)
    || all(node, 'peer-btn-ok').find((b) => b.textContent === label);
}

// A slots registrar the module registers into, plus the api a mount receives.
function harness(mod) {
  const doc = stubDocument();
  globalThis.document = doc;
  const contributions = new Map();
  const listeners = [];
  const sent = [];
  let panelRenders = 0;
  const api = {
    send: (f) => sent.push(f),
    requestPanelRender: () => { panelRenders += 1; },
    selectedSessionId: () => 'card-1',
    storage: { get: () => null, set: () => {}, remove: () => {} },
    onMessage: (fn) => { listeners.push(fn); return () => {}; },
  };
  mod.register({
    register: (slot, c) => contributions.set(slot, c),
    onMessage: (fn) => { listeners.push(fn); return () => {}; },
  });
  return {
    doc, api, sent, contributions, listeners,
    panelRenders: () => panelRenders,
    dispatch: (frame) => { for (const fn of listeners) fn(frame); },
    mountPanel() {
      const host = doc.make();
      contributions.get('panel.section').mount(host, api);
      return host;
    },
    mountPill() {
      const host = doc.make();
      contributions.get('card.pill').mount(host, api);
      return host;
    },
    mountView() {
      const host = doc.make();
      contributions.get('view').mount(host, api);
      return host;
    },
    view: () => contributions.get('view'),
  };
}

function graphWith(over = {}) {
  return {
    peerMessaging: {
      bySession: {}, inbox: {}, configured: true, registryUp: true, truncated: false, maxBodyChars: 4096,
      registry: { repos: {}, fetchedAt: null, error: null, truncated: false },
      ...over,
    },
  };
}

function message(over = {}) {
  return {
    id: 'm1', fromHandle: 'peer-card', fromRepo: 'acme/app', fromDisplay: 'Sam Rivera',
    body: 'hold off on hooks/spawn-runner?', receivedAt: Date.now(), ...over,
  };
}

// A localStorage that records, so the "persist the filter" test can assert on
// the writes rather than on a round trip through a real browser store.
function stubStorage() {
  const map = new Map();
  const sets = [];
  return {
    sets,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); sets.push([k, String(v)]); },
    removeItem: (k) => { map.delete(k); },
  };
}

let mod;
let storage;
beforeEach(async () => {
  globalThis.document = stubDocument();
  storage = stubStorage();
  globalThis.localStorage = storage;
  globalThis.location = { hash: '' };
  // Re-imported per test so the module's own `liveNotice` never leaks between
  // them (an ESM module is cached per URL, hence the cache-buster).
  mod = (await import(`../public/client.js?t=${Math.random()}`)).default;
});
afterEach(() => {
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.location;
});

test('it registers exactly the three slots it has hosts for, and nothing else', () => {
  const h = harness(mod);
  assert.deepEqual([...h.contributions.keys()].sort(), ['card.pill', 'panel.section', 'view']);
  assert.equal(h.contributions.get('card.pill').id, 'pill');
  assert.equal(h.contributions.get('panel.section').id, 'panel');
  const view = h.contributions.get('view');
  assert.equal(view.id, 'directory');
  assert.equal(view.label, 'Session registry');
  // The icon goes in via innerHTML by design (app.js), so it is the module's
  // OWN markup — a constant string, with nothing from the registry in it.
  assert.equal(typeof view.icon, 'string');
  assert.ok(view.icon.startsWith('<svg'));
});

test('it subscribes to its own ext: frames once, at register time', () => {
  const h = harness(mod);
  assert.equal(h.listeners.length, 1, 'once per module load, not once per host element');
});

// ── The rule: every peer string via textContent ──────────────────────────────

test('an injected <img src=x onerror=…> becomes TEXT and creates no element', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    bySession: { 'card-1': { pending: 1, allowAll: 0, blocked: 0 } },
    inbox: { 'card-1': { messages: [message({ body: nasty, fromDisplay: nasty, fromHandle: nasty, fromRepo: nasty })], channels: [] } },
  }));
  // The hostile string is present, verbatim, as text.
  assert.ok(all(host, 'peer-msg-text')[0].textContent.includes(nasty));
  assert.ok(all(host, 'peer-from-name')[0].textContent.includes('<img'));
  // And nothing in the tree is an IMG or a SCRIPT — the stub only ever creates
  // what the client asked createElement for.
  const tags = h.doc.created.map((n) => n.tagName);
  assert.equal(tags.includes('IMG'), false);
  assert.equal(tags.includes('SCRIPT'), false);
  assert.deepEqual([...new Set(tags)].sort(), ['BUTTON', 'DIV', 'P', 'PRE', 'SPAN']);
});

test('a missing display name renders "unattributed"', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [message({ fromDisplay: '' })], channels: [] } },
  }));
  assert.equal(all(host, 'peer-from-name')[0].textContent, 'unattributed');
});

// ── No Enter-to-approve ──────────────────────────────────────────────────────

test('nothing in the panel binds a key event — approving is a CLICK only', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [message()], channels: [{ peerHandle: 'p', allowAll: true, inCount: 1 }] } },
  }));
  const bound = new Set();
  (function walk(n) {
    for (const k of Object.keys(n.listeners || {})) bound.add(k);
    for (const c of n.children || []) walk(c);
  }(host));
  assert.deepEqual([...bound], ['click']);
});

// ── The frames it sends ──────────────────────────────────────────────────────

test('each button sends its own registered frame type, with the ids it acts on', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [message()], channels: [] } },
  }));
  findButton(host, 'Allow once').click();
  findButton(host, 'Allow all from this session').click();
  findButton(host, 'Deny').click();
  findButton(host, 'Block').click();
  assert.deepEqual(h.sent, [
    { type: 'peer-approve', sessionId: 'card-1', messageId: 'm1' },
    { type: 'peer-allow-all', sessionId: 'card-1', messageId: 'm1' },
    { type: 'peer-deny', sessionId: 'card-1', messageId: 'm1' },
    { type: 'peer-block', sessionId: 'card-1', peerHandle: 'peer-card' },
  ]);
});

test('the allow-all consequence is stated in the UI, not only in a tooltip', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [message()], channels: [] } },
  }));
  const hint = all(host, 'peer-hint')[0];
  assert.match(hint.textContent, /with no click/);
  assert.match(hint.textContent, /composer/);
  assert.match(findButton(host, 'Allow all from this session').title, /composer/);
});

test('a channel row offers revoke and block when allowed, unblock when blocked', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const panel = h.contributions.get('panel.section');
  panel.update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [], channels: [{ peerHandle: 'p1', allowAll: true, inCount: 2, outCount: 1 }] } },
  }));
  findButton(host, 'Stop allowing without a click').click();
  assert.deepEqual(h.sent.at(-1), { type: 'peer-revoke', sessionId: 'card-1', peerHandle: 'p1' });

  panel.update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [], channels: [{ peerHandle: 'p1', blocked: true, inCount: 2 }] } },
  }));
  assert.equal(findButton(host, 'Stop allowing without a click'), undefined);
  findButton(host, 'Unblock').click();
  assert.deepEqual(h.sent.at(-1), { type: 'peer-unblock', sessionId: 'card-1', peerHandle: 'p1' });
});

test('the last delivery outcome is drawn from the graph, so it survives a reload', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [], channels: [{ peerHandle: 'p1', allowAll: true, inCount: 1, lastIn: { at: Date.now(), mode: 'dormant' } }] } },
  }));
  assert.match(all(host, 'peer-last')[0].textContent, /Woke the card and delivered/);
});

// ── The inbound seam (onMessage) ─────────────────────────────────────────────

test('an ext: frame for the selected card draws a live notice and asks for a re-render', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const panel = h.contributions.get('panel.section');
  panel.update(host, { sessionId: 'card-1' }, graphWith());
  h.dispatch({ type: 'ext:peer-messaging', kind: 'approved', sessionId: 'card-1', messageId: 'm1', mode: 'dormant' });
  assert.equal(h.panelRenders(), 1);
  panel.update(host, { sessionId: 'card-1' }, graphWith());
  assert.match(all(host, 'peer-note')[0].textContent, /Woke the card and delivered/);
});

test('a notice for ANOTHER card never shows on this one"s panel', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const panel = h.contributions.get('panel.section');
  h.dispatch({ type: 'ext:peer-messaging', kind: 'denied', sessionId: 'card-2', messageId: 'm1' });
  panel.update(host, { sessionId: 'card-1' }, graphWith());
  assert.deepEqual(host.querySelector('.peer-panel').children, []);
});

test('a failed delivery says so, with the reason the server gave', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const panel = h.contributions.get('panel.section');
  h.dispatch({ type: 'ext:peer-messaging', kind: 'approved', sessionId: 'card-1', mode: 'error', error: 'session is archived' });
  panel.update(host, { sessionId: 'card-1' }, graphWith());
  assert.match(all(host, 'peer-note')[0].textContent, /Could not deliver: session is archived/);
});

test('a malformed inbound frame is ignored rather than thrown on', () => {
  const h = harness(mod);
  for (const bad of [null, undefined, 'string', 42, {}, { kind: 'approved' }]) {
    assert.doesNotThrow(() => h.dispatch(bad));
  }
  assert.equal(h.panelRenders(), 0);
});

// ── Defensive against a graph that has not caught up ────────────────────────

test('a missing graph.peerMessaging does not throw — the first tick after a reconnect', () => {
  const h = harness(mod);
  const panelHost = h.mountPanel();
  const pillHost = h.mountPill();
  const panel = h.contributions.get('panel.section');
  const pill = h.contributions.get('card.pill');
  for (const graph of [null, undefined, {}, { peerMessaging: null }, { peerMessaging: 'nope' }, { peerMessaging: {} }]) {
    assert.doesNotThrow(() => panel.update(panelHost, { sessionId: 'card-1' }, graph));
    assert.doesNotThrow(() => pill.update(pillHost, { sessionId: 'card-1' }, graph));
  }
});

test('a malformed inbox is treated as empty rather than iterated', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  const panel = h.contributions.get('panel.section');
  for (const inbox of [{ 'card-1': null }, { 'card-1': [] }, { 'card-1': { messages: 'x', channels: 3 } }]) {
    assert.doesNotThrow(() => panel.update(host, { sessionId: 'card-1' }, graphWith({ inbox })));
  }
});

test('no selected session draws nothing at all', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, null, graphWith());
  assert.deepEqual(host.querySelector('.peer-panel').children, []);
});

// ── card.pill ────────────────────────────────────────────────────────────────

test('the pill is amber with a count when something waits, quiet when a peer is allowed, empty otherwise', () => {
  const h = harness(mod);
  const host = h.mountPill();
  const pill = h.contributions.get('card.pill');
  const node = host.querySelector('.peer-pill');

  pill.update(host, { sessionId: 'card-1' }, graphWith({ bySession: { 'card-1': { pending: 3, allowAll: 0, blocked: 0 } } }));
  assert.match(node.className, /peer-pill-waiting/);
  assert.match(node.textContent, /3/);
  assert.match(node.title, /3 peer messages waiting/);

  pill.update(host, { sessionId: 'card-1' }, graphWith({ bySession: { 'card-1': { pending: 0, allowAll: 2, blocked: 0 } } }));
  assert.match(node.className, /peer-pill-open/);
  assert.match(node.title, /without a click/);

  pill.update(host, { sessionId: 'card-1' }, graphWith({ bySession: { 'card-1': { pending: 0, allowAll: 0, blocked: 1 } } }));
  assert.equal(node.className, 'peer-pill');
  assert.equal(node.textContent, '');
});

// Each per-card host is updated with ITS OWN card's session (slots.syncHosts),
// so the pill must read the session it is handed and nothing else.
test('each pill reads the session it was handed, never a selected one', () => {
  const h = harness(mod);
  const a = h.mountPill();
  const b = h.mountPill();
  const pill = h.contributions.get('card.pill');
  const graph = graphWith({ bySession: { 'card-1': { pending: 5, allowAll: 0, blocked: 0 } } });
  pill.update(a, { sessionId: 'card-1' }, graph);
  pill.update(b, { sessionId: 'card-2' }, graph);
  assert.match(a.querySelector('.peer-pill').textContent, /5/);
  assert.equal(b.querySelector('.peer-pill').textContent, '');
});

// ── State the panel has to explain rather than hide ─────────────────────────

test('an unconfigured extension says where a human sets the URL, and draws no cards', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({ configured: false }));
  assert.match(all(host, 'peer-note')[0].textContent, /Extensions tab/);
  assert.deepEqual(all(host, 'peer-msg'), []);
});

test('an unreachable registry is reported as not-lost, and the cards still draw', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    registryUp: false,
    inbox: { 'card-1': { messages: [message()], channels: [] } },
  }));
  assert.match(all(host, 'peer-note')[0].textContent, /Nothing is lost/);
  assert.equal(all(host, 'peer-msg').length, 1);
});

test('a truncated graph tells the human to clear the backlog', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    truncated: true,
    inbox: { 'card-1': { messages: [message()], channels: [] } },
  }));
  assert.ok(all(host, 'peer-note').some((n) => /more waiting than the board will carry/.test(n.textContent)));
});

// ── view: the Session registry ───────────────────────────────────────────────

function fire(node, name) {
  for (const fn of node.listeners[name] || []) fn();
}

function entry(over = {}) {
  return {
    sessionId: 'sess-1',
    origin: 'local',
    intent: 'wiring the drain',
    detail: '',
    branch: 'main',
    startedAt: new Date(Date.now() - 20 * 60000).toISOString(),
    finishedAt: null,
    messagingHandle: '',
    owner: 'Sam Rivera',
    ...over,
  };
}

function regGraph(repos, over = {}, graphOver = {}) {
  return {
    ...graphWith({ registry: { repos, fetchedAt: 1_700_000_000_000, error: null, truncated: false, ...over } }),
    ...graphOver,
  };
}

test('entries are grouped by repo, live before ended, and the busiest repo first', () => {
  const h = harness(mod);
  const host = h.mountView();
  const older = new Date(Date.now() - 10 * 3600000).toISOString();
  const newer = new Date(Date.now() - 5 * 60000).toISOString();
  h.view().update(host, null, regGraph({
    'acme/app': [entry({ sessionId: 'a1', startedAt: older }), entry({ sessionId: 'a2', startedAt: older, finishedAt: older })],
    'zeta/tool': [entry({ sessionId: 'z1', startedAt: newer })],
  }));

  const sections = all(host, 'peer-dir-repo');
  assert.deepEqual(sections.map((s) => s.dataset.repoKey), ['zeta/tool', 'acme/app'],
    'most recently active repo first, which is buildUIPage"s sort');
  // Within a repo: the heading, then live, then the "recently ended" heading
  // and its block — never interleaved.
  const acme = sections[1];
  assert.deepEqual(acme.children.map((c) => c.className),
    ['peer-dir-repo-name', 'peer-dir-live', 'peer-dir-ended-heading', 'peer-dir-ended']);
  assert.equal(all(host, 'peer-dir-card').length, 3);
  assert.match(host.querySelector('.peer-dir-meta').textContent,
    /^3 session\(s\) started in the last 24 hours, across 2 repo\(s\)\. As of \d\d:\d\d\.$/);
});

test('the state chip says exactly "no end recorded" or "ended Nm ago"', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({
    'acme/app': [
      entry({ sessionId: 'live-1' }),
      entry({ sessionId: 'done-1', finishedAt: new Date(Date.now() - 7 * 60000).toISOString() }),
    ],
  }));
  const chips = all(host, 'peer-dir-chip').map((c) => c.textContent);
  assert.deepEqual(chips, ['no end recorded', 'ended 7m ago']);
});

test('an empty intent renders the italic placeholder, and every agent string is textContent', () => {
  const h = harness(mod);
  const host = h.mountView();
  const nasty = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  h.view().update(host, null, regGraph({
    'acme/app': [
      entry({ sessionId: 'no-intent', intent: '' }),
      entry({ sessionId: nasty, intent: nasty, detail: nasty, messagingHandle: nasty, owner: nasty, branch: nasty }),
    ],
  }));
  const intents = all(host, 'peer-dir-intent');
  assert.equal(intents[0].textContent, 'no intent set');
  assert.match(intents[0].className, /absent/);
  assert.ok(intents[1].textContent.includes(nasty));
  assert.equal(all(host, 'peer-dir-detail')[0].textContent, nasty);
  const tags = h.doc.created.map((n) => n.tagName);
  assert.equal(tags.includes('IMG'), false);
  assert.equal(tags.includes('SCRIPT'), false);
});

test('the author is labelled, and a missing one is stated rather than left blank', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({
    'acme/app': [
      entry({ sessionId: 'has-owner', owner: 'Alex Pezarro' }),
      entry({ sessionId: 'no-owner', owner: '', startedAt: new Date(Date.now() - 1000).toISOString() }),
    ],
  }));
  const owners = all(host, 'peer-dir-owner');
  assert.deepEqual(owners.map((n) => n.textContent), ['author Alex Pezarro', 'no author recorded']);
  assert.match(owners[1].className, /absent/);
});

test('the branch name carries no label, and the session id is not drawn at all', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry({ sessionId: 'sid-1', branch: 'claude/car-rental' })] }));
  assert.deepEqual(all(host, 'peer-dir-branch').map((n) => n.textContent), ['claude/car-rental']);
  assert.equal(all(host, 'peer-dir-shortid').length, 0);
  assert.equal(all(host, 'peer-dir-handle').length, 0);
});

test('start and end sit together in one group', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry({ sessionId: 'live-1' })] }));
  const times = all(host, 'peer-dir-times');
  assert.equal(times.length, 1);
  const inside = times[0].children.map((n) => n.className);
  assert.deepEqual(inside, ['peer-dir-started', 'peer-dir-chip']);
});

test('an origin the registry does not know is "unknown-origin", never a guess', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry({ origin: 'something-else' })] }));
  assert.equal(all(host, 'peer-dir-origin')[0].textContent, 'unknown-origin');
});

test('a handle matching a board session gets the "this board" tag and a click sets the hash', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph(
    {
      'acme/app': [
        entry({ sessionId: 'mine', messagingHandle: 'card-1' }),
        entry({ sessionId: 'theirs', messagingHandle: 'card-9' }),
      ],
    },
    {},
    { sessions: [{ sessionId: 'card-1' }] },
  ));
  const cards = all(host, 'peer-dir-card');
  const mine = cards.find((c) => /peer-dir-mine/.test(c.className));
  const theirs = cards.find((c) => !/peer-dir-mine/.test(c.className));
  assert.ok(mine, 'the board"s own card is marked');
  assert.equal(all(mine, 'peer-tag')[0].textContent, 'this board');
  assert.equal(mine.attrs.role, 'link');
  mine.click();
  assert.equal(globalThis.location.hash, '#session=card-1');
  // And the other card is inert: no tag and no listener at all.
  assert.deepEqual(all(theirs, 'peer-tag'), []);
  assert.deepEqual(Object.keys(theirs.listeners), []);
});

test('a click inside <details> does not navigate away from the view', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph(
    { 'acme/app': [entry({ sessionId: 'mine', messagingHandle: 'card-1', detail: 'the long version' })] },
    {},
    { sessions: [{ sessionId: 'card-1' }] },
  ));
  const card = all(host, 'peer-dir-card')[0];
  card.click({ target: { closest: (sel) => (sel === 'details' ? {} : null) } });
  assert.equal(globalThis.location.hash, '', 'the disclosure is about the detail, not the card');
});

test('nothing the view draws binds a key event — navigating is a CLICK only', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph(
    { 'acme/app': [entry({ messagingHandle: 'card-1' })] },
    {},
    { sessions: [{ sessionId: 'card-1' }] },
  ));
  const bound = new Set();
  (function walk(n) {
    for (const k of Object.keys(n.listeners || {})) bound.add(k);
    for (const c of n.children || []) walk(c);
  }(host));
  assert.deepEqual([...bound].sort(), ['change', 'click']);
});

test('the status and repo filters hide blocks and sections, and persist the choice', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({
    'acme/app': [entry({ sessionId: 'a1' }), entry({ sessionId: 'a2', finishedAt: new Date().toISOString() })],
    'acme/other': [entry({ sessionId: 'b1', startedAt: new Date(Date.now() - 3600000).toISOString() })],
  }));
  const statusSel = host.querySelector('.peer-dir-status');
  const repoSel = host.querySelector('.peer-dir-repo-filter');
  assert.equal(host.querySelector('.peer-dir-summary').textContent, 'showing all 2 repo(s)');

  statusSel.value = 'ended';
  fire(statusSel, 'change');
  assert.deepEqual(storage.sets.at(-1), ['peer-messaging:dir:status', 'ended']);
  assert.equal(all(host, 'peer-dir-live')[0].hidden, true);
  assert.equal(all(host, 'peer-dir-ended')[0].hidden, false);
  // acme/other has nothing ended, so its whole section goes.
  const other = all(host, 'peer-dir-repo').find((s) => s.dataset.repoKey === 'acme/other');
  assert.equal(other.hidden, true);
  assert.equal(host.querySelector('.peer-dir-summary').textContent, 'showing 1 of 2 repo(s)');

  statusSel.value = 'all';
  fire(statusSel, 'change');
  repoSel.value = 'acme/other';
  fire(repoSel, 'change');
  assert.deepEqual(storage.sets.at(-1), ['peer-messaging:dir:repo', 'acme/other']);
  assert.equal(all(host, 'peer-dir-repo').find((s) => s.dataset.repoKey === 'acme/app').hidden, true);
  assert.equal(other.hidden, false);
});

test('a filter that matches nothing says so rather than showing a blank page', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }));
  const statusSel = host.querySelector('.peer-dir-status');
  statusSel.value = 'ended';
  fire(statusSel, 'change');
  assert.equal(host.querySelector('.peer-dir-nomatch').hidden, false);
  assert.match(host.querySelector('.peer-dir-nomatch').textContent, /Widen it to see sessions again/);
});

test('an unconfigured extension says where a human sets the URL, and the view draws no cards', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }, {}, {}));
  h.view().update(host, null, graphWith({ configured: false }));
  assert.match(all(host, 'peer-note')[0].textContent, /Extensions tab/);
  assert.deepEqual(all(host, 'peer-dir-card'), []);
});

test('an unreachable registry keeps the last snapshot on screen, with the panel"s note', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }));
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }, {}, {}));
  h.view().update(host, null, {
    ...regGraph({ 'acme/app': [entry()] }),
    peerMessaging: { ...regGraph({ 'acme/app': [entry()] }).peerMessaging, registryUp: false },
  });
  assert.match(all(host, 'peer-note')[0].textContent, /Nothing is lost/);
  assert.equal(all(host, 'peer-dir-card').length, 1, 'stale and labelled beats blank');
});

test('an empty registry and one that has never been fetched say different things', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({}, { fetchedAt: null }));
  assert.match(host.querySelector('.peer-dir-empty').textContent, /Waiting for the first sweep/);
  h.view().update(host, null, regGraph({}));
  assert.match(host.querySelector('.peer-dir-empty').textContent, /empty registry, not a broken page/);
});

test('a truncated registry says so', () => {
  const h = harness(mod);
  const host = h.mountView();
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }, { truncated: true }));
  assert.ok(all(host, 'peer-note').some((n) => /more sessions than the board will carry/.test(n.textContent)));
});

// The graph tick is ~4s and the directory only moves on a sweep, so the common
// case is a tick that changes nothing at all.
test('update skips the rebuild when fetchedAt and the board"s sessions are unchanged', () => {
  const h = harness(mod);
  const host = h.mountView();
  const graph = regGraph({ 'acme/app': [entry()] }, {}, { sessions: [{ sessionId: 'card-1' }] });
  h.view().update(host, null, graph);
  const after = h.doc.created.length;
  h.view().update(host, null, graph);
  assert.equal(h.doc.created.length, after, 'an identical tick creates no nodes');
  // A card arriving on the board DOES redraw: the "this board" tag depends on it.
  h.view().update(host, null, regGraph({ 'acme/app': [entry()] }, {}, { sessions: [{ sessionId: 'card-1' }, { sessionId: 'card-2' }] }));
  assert.ok(h.doc.created.length > after);
});

test('the view never throws on a graph that has not caught up', () => {
  const h = harness(mod);
  const host = h.mountView();
  for (const graph of [null, undefined, {}, { peerMessaging: null }, { peerMessaging: {} },
    graphWith({ registry: null }), graphWith({ registry: { repos: [] } }),
    graphWith({ registry: { repos: { 'a/b': 'nope' } } })]) {
    assert.doesNotThrow(() => h.view().update(host, null, graph));
  }
});
