// The browser half. Served from /ext/peer-messaging/ and handed a registrar
// already bound to this extension's id (`slots.forExtension`), so it can only
// ever contribute — and only ever subscribe — under its own id.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ EVERY PEER-SUPPLIED STRING GOES IN VIA textContent. No exceptions.      │
// └─────────────────────────────────────────────────────────────────────────┘
// Display name, handle, repo, body — all of it. Same rule as the board's own
// diff-dom.js / checklist-dom.js / extensions-panel.js, and for a sharper
// reason than any of them: this content came off a remote relay that echoes
// whatever a sender asserted about itself and verifies none of it. There is no
// `esc()` anywhere in this file and no `innerHTML` assignment carrying data.
//
// NO ENTER-TO-APPROVE, for the same reason the install consent modal has none:
// approving puts text a stranger wrote into an agent's context.
//
// Defensive about a missing `graph.peerMessaging` throughout — the first render
// after a reconnect can arrive before the contributor has run — because a
// throwing contribution is REMOVED from every host it occupies (slots.js), so
// one bad tick would take the whole UI off the board rather than skip a frame.

// ── Copy ─────────────────────────────────────────────────────────────────────

// The auto-allow warning, VISIBLE rather than a tooltip. `host.deliver` pastes
// at the composer's cursor and the mid-prompt hold is not wired to that seam
// (server/ext-deliver.js says so itself), so a pre-approved message arriving
// off the sweep can splice itself into a half-typed draft. That is precisely
// what this button buys, so the button says it.
const ALLOW_ALL_HINT = 'Allow all lets this peer’s later messages reach the agent with no click. They are pasted at the composer’s cursor, so one can land in the middle of something you are part-way through typing.';

// "from" is an ASSERTION. The relay echoes whatever a sender claimed about
// itself; the only fields the board can vouch for are the handle it drained
// and the repo it asked about.
const FROM_IS_A_CLAIM = 'self-reported';

const MODE_TEXT = {
  live: 'Delivered',
  dormant: 'Woke the card and delivered',
  error: 'Could not deliver',
  sent: 'Sent',
};

// ── Module state ─────────────────────────────────────────────────────────────

// The live outcome of the last click, from `api.onMessage` — the inbound seam
// (HOST_API_VERSION 1.2.0). The thread's `mode` on the graph is the DURABLE
// record; this is only what makes a click feel answered before the next tick,
// so it EXPIRES. It describes a moment, not a state — the same reason the
// Extensions panel clears its settled progress lines — and a "Denied" line
// still sitting there twenty minutes later reads as current.
let liveNotice = null;
const NOTICE_MS = 12000;
// Captured when panel.section mounts, so the onMessage subscription — taken at
// register() time, where there is no api yet — has something to ask for a
// re-render with.
let panelApi = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, always. See the file header.
  if (text != null) node.textContent = String(text);
  return node;
}

function button(className, label, onClick, { title = null, disabled = false } = {}) {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  if (disabled) b.disabled = true;
  // Click only. No keydown handler anywhere in this file: Enter must never
  // approve anything.
  b.addEventListener('click', onClick);
  return b;
}

function peerData(graph) {
  const p = graph && graph.peerMessaging;
  return p && typeof p === 'object' ? p : null;
}

function counts(graph, sessionId) {
  const p = peerData(graph);
  const row = p && p.bySession && sessionId ? p.bySession[sessionId] : null;
  return row && typeof row === 'object' ? row : null;
}

function inboxFor(graph, sessionId) {
  const p = peerData(graph);
  const box = p && p.inbox && sessionId ? p.inbox[sessionId] : null;
  if (!box || typeof box !== 'object') return { messages: [], channels: [] };
  return {
    messages: Array.isArray(box.messages) ? box.messages : [],
    channels: Array.isArray(box.channels) ? box.channels : [],
  };
}

function ago(at) {
  if (!Number.isFinite(at)) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// ── card.pill ────────────────────────────────────────────────────────────────
// ONE host PER CARD (`.card-meta-ext`, cards.js), reconciled by syncHosts with
// each element updated with ITS OWN card's session — never the selected one.
const cardPill = {
  id: 'pill',
  mount(host) {
    host.appendChild(el('span', 'peer-pill'));
  },
  update(host, session, graph) {
    const pill = host.querySelector('.peer-pill');
    if (!pill) return;
    const row = counts(graph, session && session.sessionId);
    const pending = row ? Number(row.pending) || 0 : 0;
    const allowAll = row ? Number(row.allowAll) || 0 : 0;
    // Nothing at all is the common case: no dot, no space taken.
    if (!pending && !allowAll) {
      pill.className = 'peer-pill';
      pill.textContent = '';
      pill.removeAttribute('title');
      return;
    }
    if (pending) {
      pill.className = 'peer-pill peer-pill-waiting';
      pill.textContent = `✉ ${pending}`;
      pill.title = `${pending} peer message${pending === 1 ? '' : 's'} waiting for you to approve`;
      return;
    }
    pill.className = 'peer-pill peer-pill-open';
    pill.textContent = '✉';
    pill.title = `${allowAll} peer${allowAll === 1 ? '' : 's'} allowed to reach this session without a click`;
  },
};

// ── panel.section ────────────────────────────────────────────────────────────
// ONE host (#panel-sections), mounted once for the life of the page, updated on
// every graph tick and every selection change.
const panelSection = {
  id: 'panel',
  mount(host, api) {
    panelApi = api;
    host.appendChild(el('div', 'peer-panel'));
  },
  update(host, session, graph) {
    const root = host.querySelector('.peer-panel');
    if (!root) return;
    const sessionId = session && session.sessionId;
    const p = peerData(graph);
    const { messages, channels } = inboxFor(graph, sessionId);

    const notice = noticeFor(sessionId);
    // Nothing to say and nothing to configure: draw nothing rather than an
    // empty section taking up panel space on every card. The notice counts as
    // something to say — a Deny removes the only message, so without this the
    // whole section (and its confirmation) would vanish on the same click.
    if (!sessionId || (!messages.length && !channels.length && !notice && p && p.configured)) {
      root.replaceChildren();
      return;
    }

    const parts = [];
    parts.push(el('div', 'peer-head', 'Peer messages'));

    if (p && !p.configured) {
      parts.push(el('p', 'peer-note', 'No session registry URL is set, so peer messaging is doing nothing. Set one from the cog on its row in the Extensions tab.'));
      root.replaceChildren(...parts);
      return;
    }
    if (p && p.registryUp === false) {
      parts.push(el('p', 'peer-note peer-warn', 'The session registry is unreachable. Nothing is lost — messages are re-read when it is back.'));
    }
    if (p && p.truncated) {
      parts.push(el('p', 'peer-note peer-warn', 'There is more waiting than the board will carry at once. Clear some of the backlog to see the rest.'));
    }

    if (notice) parts.push(notice);

    for (const m of messages) parts.push(approvalCard(sessionId, m));
    if (channels.length) parts.push(channelList(sessionId, channels));

    root.replaceChildren(...parts);
  },
  unmount() {
    panelApi = null;
  },
};

// The live ack from api.onMessage. Scoped to the selected card, so a click on
// one card's message never reports onto another's panel.
function noticeFor(sessionId) {
  if (!liveNotice || liveNotice.sessionId !== sessionId) return null;
  if (Date.now() - liveNotice.at > NOTICE_MS) { liveNotice = null; return null; }
  const { kind, mode, error, peerHandle } = liveNotice;
  let text;
  if (kind === 'approved' || kind === 'auto-delivered') {
    text = mode === 'error'
      ? `Could not deliver: ${error || 'the session would not take it'}`
      : (MODE_TEXT[mode] || 'Delivered');
    if (kind === 'auto-delivered') text += ' (a peer you had already allowed)';
  } else if (kind === 'denied') text = 'Denied — that message is gone.';
  else if (kind === 'blocked') text = 'Blocked. Nothing further from that session will be held here.';
  else if (kind === 'unblocked') text = 'Unblocked.';
  else if (kind === 'revoked') text = 'Withdrawn. That session needs approving again next time.';
  else return null;
  const node = el('p', mode === 'error' ? 'peer-note peer-warn' : 'peer-note peer-ok', text);
  // The peer handle is peer-supplied, so it goes in as its own text node.
  if (peerHandle) node.appendChild(el('span', 'peer-handle', ` ${peerHandle}`));
  return node;
}

function approvalCard(sessionId, m) {
  const card = el('div', 'peer-msg');
  // No data-id on any element in here: settings.js's delegated toggle handler
  // looks a row up by `dataset.id`, and anything shaped like `ext:<id>` would
  // make a click in here flip an extension's enable flag.
  const from = el('div', 'peer-msg-from');
  from.appendChild(el('span', 'peer-from-name', m.fromDisplay || 'unattributed'));
  from.appendChild(el('span', 'peer-claim', ` (${FROM_IS_A_CLAIM})`));
  card.appendChild(from);

  const meta = el('div', 'peer-msg-meta');
  meta.appendChild(el('span', 'peer-handle', m.fromHandle || 'unknown session'));
  meta.appendChild(el('span', 'peer-sep', ' · '));
  meta.appendChild(el('span', 'peer-repo', m.fromRepo || 'unknown repo'));
  const when = ago(Number(m.receivedAt));
  if (when) {
    meta.appendChild(el('span', 'peer-sep', ' · '));
    meta.appendChild(el('span', 'peer-age', when));
  }
  card.appendChild(meta);

  // Capped scroll box: a 4096-character body must not push the rest of the
  // panel off the screen.
  const bodyBox = el('div', 'peer-msg-body');
  bodyBox.appendChild(el('pre', 'peer-msg-text', m.body || ''));
  card.appendChild(bodyBox);

  const actions = el('div', 'peer-actions');
  actions.appendChild(button('peer-btn peer-btn-ok', 'Allow once',
    () => send({ type: 'peer-approve', sessionId, messageId: m.id })));
  actions.appendChild(button('peer-btn', 'Allow all from this session',
    () => send({ type: 'peer-allow-all', sessionId, messageId: m.id }), { title: ALLOW_ALL_HINT }));
  actions.appendChild(button('peer-btn', 'Deny',
    () => send({ type: 'peer-deny', sessionId, messageId: m.id })));
  actions.appendChild(button('peer-btn peer-btn-danger', 'Block',
    () => send({ type: 'peer-block', sessionId, peerHandle: m.fromHandle })));
  card.appendChild(actions);

  card.appendChild(el('p', 'peer-hint', ALLOW_ALL_HINT));
  return card;
}

function channelList(sessionId, channels) {
  const box = el('div', 'peer-channels');
  box.appendChild(el('div', 'peer-subhead', 'Sessions you have decided about'));
  for (const c of channels) {
    const row = el('div', 'peer-channel');
    const who = el('div', 'peer-channel-who');
    if (c.lastDisplay) {
      who.appendChild(el('span', 'peer-from-name', c.lastDisplay));
      who.appendChild(el('span', 'peer-claim', ` (${FROM_IS_A_CLAIM}) `));
    }
    who.appendChild(el('span', 'peer-handle', c.peerHandle || 'unknown session'));
    row.appendChild(who);

    const state = el('div', 'peer-channel-state');
    if (c.blocked) state.appendChild(el('span', 'peer-tag peer-tag-blocked', 'Blocked'));
    else if (c.allowAll) state.appendChild(el('span', 'peer-tag peer-tag-open', 'Allowed without a click'));
    if (c.lastIn && c.lastIn.mode) {
      const label = MODE_TEXT[c.lastIn.mode] || String(c.lastIn.mode);
      const when = ago(Number(c.lastIn.at));
      state.appendChild(el('span', 'peer-last', when ? `${label} · ${when}` : label));
    }
    const seen = [];
    if (c.inCount) seen.push(`${c.inCount} in`);
    if (c.outCount) seen.push(`${c.outCount} out`);
    if (seen.length) state.appendChild(el('span', 'peer-seen', seen.join(' · ')));
    row.appendChild(state);

    const actions = el('div', 'peer-actions');
    if (c.blocked) {
      actions.appendChild(button('peer-btn', 'Unblock',
        () => send({ type: 'peer-unblock', sessionId, peerHandle: c.peerHandle })));
    } else if (c.allowAll) {
      actions.appendChild(button('peer-btn', 'Stop allowing without a click',
        () => send({ type: 'peer-revoke', sessionId, peerHandle: c.peerHandle })));
      actions.appendChild(button('peer-btn peer-btn-danger', 'Block',
        () => send({ type: 'peer-block', sessionId, peerHandle: c.peerHandle })));
    } else {
      actions.appendChild(button('peer-btn peer-btn-danger', 'Block',
        () => send({ type: 'peer-block', sessionId, peerHandle: c.peerHandle })));
    }
    row.appendChild(actions);
    box.appendChild(row);
  }
  return box;
}

// `api.send` is bound by slots.apiFor to this extension's OWN registered
// handler types and FAILS CLOSED — a board that has heard nothing about this
// extension may send nothing. This contribution does not need to know that; it
// just must not invent a frame type.
function send(frame) {
  if (panelApi && typeof panelApi.send === 'function') panelApi.send(frame);
}

export default {
  register(slots) {
    // Subscribed HERE, from register(), rather than from a mount: the api
    // reaches a module through mount(el, api), and a contribution that
    // subscribed there would subscribe once per host element it occupies —
    // which for a per-card slot is once per card on screen.
    slots.onMessage((m) => {
      if (!m || typeof m !== 'object' || typeof m.sessionId !== 'string') return;
      liveNotice = { ...m, at: Date.now() };
      // The graph carries the durable version of this within a tick; the
      // re-render is only what makes the click feel answered now.
      if (panelApi && typeof panelApi.requestPanelRender === 'function') panelApi.requestPanelRender();
    });
    slots.register('card.pill', cardPill);
    slots.register('panel.section', panelSection);
  },
};
