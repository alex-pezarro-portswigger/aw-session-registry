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
      _text: '',
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
      addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
      querySelector(sel) { return find(node, sel); },
      click() { for (const fn of node.listeners.click || []) fn(); },
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
  };
}

function graphWith(over = {}) {
  return {
    peerMessaging: {
      bySession: {}, inbox: {}, configured: true, registryUp: true, truncated: false, maxBodyChars: 4096, ...over,
    },
  };
}

function message(over = {}) {
  return {
    id: 'm1', fromHandle: 'peer-card', fromRepo: 'acme/app', fromDisplay: 'Sam Rivera',
    body: 'hold off on hooks/spawn-runner?', receivedAt: Date.now(), ...over,
  };
}

let mod;
beforeEach(async () => {
  globalThis.document = stubDocument();
  // Re-imported per test so the module's own `liveNotice` never leaks between
  // them (an ESM module is cached per URL, hence the cache-buster).
  mod = (await import(`../public/client.js?t=${Math.random()}`)).default;
});
afterEach(() => { delete globalThis.document; });

test('it registers exactly the two slots it has hosts for, and nothing else', () => {
  const h = harness(mod);
  assert.deepEqual([...h.contributions.keys()].sort(), ['card.pill', 'panel.section']);
  assert.equal(h.contributions.get('card.pill').id, 'pill');
  assert.equal(h.contributions.get('panel.section').id, 'panel');
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

test('a missing display name renders "unattributed" and is marked self-reported', () => {
  const h = harness(mod);
  const host = h.mountPanel();
  h.contributions.get('panel.section').update(host, { sessionId: 'card-1' }, graphWith({
    inbox: { 'card-1': { messages: [message({ fromDisplay: '' })], channels: [] } },
  }));
  assert.equal(all(host, 'peer-from-name')[0].textContent, 'unattributed');
  assert.match(all(host, 'peer-claim')[0].textContent, /self-reported/);
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
