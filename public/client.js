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

// ── view: the Session registry ───────────────────────────────────────────────
// ONE host, a top-level board view behind a rail button. It draws the registry
// dashboard's data (every repo's sessions from the last 24 hours) from
// `graph.peerMessaging.registry`, which the sweep filled — this file never
// fetches anything, and neither does the graph tick that feeds it.
//
// READ-ONLY. Nothing in here sends a frame, and the one interaction it has is
// a click on the board's OWN card, which is navigation, not an action.

// The rail icon. `app.js` puts `c.icon` in with innerHTML BY DESIGN, so this
// is a string constant with no data anywhere in it — the module's own markup,
// at the module's own trust level. Nothing from the registry may ever reach
// this constant.
const DIRECTORY_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">'
  + '<path d="M2 3.5h3M2 8h3M2 12.5h3M7.5 3.5h6.5M7.5 8h6.5M7.5 12.5h6.5"/></svg>';

const DIR_WINDOW_HOURS = 24; // mirrors the registry's own `uiWindow`.
const DIR_STATUS_KEY = 'peer-messaging:dir:status';
const DIR_REPO_KEY = 'peer-messaging:dir:repo';

// Held on mount and cleared on unmount, mirroring `panelApi`. The view is
// READ-ONLY, so nothing reads it today — it is what a future contribution here
// would have to go through, and keeping the seam means the lifecycle is
// already right rather than being retrofitted.
let directoryApi = null;
// `undefined` rather than null is the "nothing drawn yet" sentinel: a registry
// that has never been fetched has a `fetchedAt` of null, and the first render
// must still happen.
let lastRenderedAt;
let lastBoardKey = null;

function store(key, value) {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // A private window, a blocked origin, a quota. A filter that does not
    // persist is a smaller problem than a view that throws.
  }
}

function stored(key) {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The dashboard's own age wording (`humanize.Age`): `<1m`, `Nm`, `Nh`, `Nd`.
// A SEPARATE function from `ago()` rather than a change to it — the panel's
// "12s ago" wording and the tests that pin it stay exactly as they were.
function ageWord(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  if (ms < 60000) return '<1m';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
  return `${Math.floor(ms / 86400000)}d`;
}

// `humanize.ShortID`: keep 20, and only abbreviate past 24, cutting on code
// points rather than bytes.
function shortId(id) {
  const text = String(id || '');
  const runes = [...text];
  return runes.length <= 24 ? text : `${runes.slice(0, 20).join('')}…`;
}

// `uiOriginWord`: refuses to guess. A plausible-looking wrong origin is worse
// than an admitted unknown, because a reader uses it to decide whether a
// peer's tree is on their own disk.
function originWord(origin) {
  return origin === 'runner' || origin === 'local' || origin === 'hosted' ? origin : 'unknown-origin';
}

function stamp(at) {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function registryData(graph) {
  const p = peerData(graph);
  const reg = p && p.registry;
  if (!reg || typeof reg !== 'object') return { repos: {}, fetchedAt: null, error: null, truncated: false };
  const raw = reg.repos;
  const repos = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    repos,
    fetchedAt: Number.isFinite(reg.fetchedAt) ? reg.fetchedAt : null,
    error: typeof reg.error === 'string' ? reg.error : null,
    truncated: Boolean(reg.truncated),
  };
}

// The board's own live session ids. `graph.sessions` and nothing else: the
// handle this extension publishes IS the card id, so an entry whose
// messagingHandle is in here is a card on this very board.
function boardSessionIds(graph) {
  const list = graph && Array.isArray(graph.sessions) ? graph.sessions : [];
  const ids = new Set();
  for (const s of list) if (s && typeof s.sessionId === 'string') ids.add(s.sessionId);
  return ids;
}

function option(value, label) {
  const o = el('option', null, label);
  o.value = value;
  return o;
}

const directoryView = {
  id: 'directory',
  label: 'Session registry',
  icon: DIRECTORY_ICON,

  mount(host, api) {
    directoryApi = api;
    lastRenderedAt = undefined;
    lastBoardKey = null;

    const root = el('div', 'peer-dir');

    const head = el('div', 'peer-dir-head');
    head.appendChild(el('h1', 'peer-dir-title', 'session registry'));
    head.appendChild(el('p', 'peer-dir-meta', ''));
    root.appendChild(head);

    root.appendChild(el('div', 'peer-dir-notes'));

    const controls = el('div', 'peer-dir-controls');
    const statusBox = el('div', 'peer-dir-control');
    statusBox.appendChild(el('span', 'peer-dir-label', 'status'));
    const statusSel = el('select', 'peer-dir-status');
    statusSel.appendChild(option('all', 'all sessions'));
    statusSel.appendChild(option('live', 'no end recorded'));
    statusSel.appendChild(option('ended', 'recently ended'));
    statusBox.appendChild(statusSel);
    controls.appendChild(statusBox);

    const repoBox = el('div', 'peer-dir-control');
    repoBox.appendChild(el('span', 'peer-dir-label', 'repo'));
    const repoSel = el('select', 'peer-dir-repo-filter');
    repoSel.appendChild(option('', 'all repos'));
    repoBox.appendChild(repoSel);
    controls.appendChild(repoBox);

    controls.appendChild(el('span', 'peer-dir-summary', ''));
    root.appendChild(controls);

    root.appendChild(el('div', 'peer-dir-body'));
    const nomatch = el('p', 'peer-dir-nomatch', 'Nothing matches this filter. Widen it to see sessions again.');
    nomatch.hidden = true;
    root.appendChild(nomatch);
    root.appendChild(el('p', 'peer-dir-empty', ''));

    // Restored AFTER the options exist, and a stored repo is accepted only if
    // the current options carry it — the same rule as the dashboard's own
    // `restore`. Repos come and go, and a dangling selection would hide
    // everything with no way to tell why.
    const savedStatus = stored(DIR_STATUS_KEY);
    if (savedStatus === 'all' || savedStatus === 'live' || savedStatus === 'ended') statusSel.value = savedStatus;
    statusSel.addEventListener('change', () => {
      store(DIR_STATUS_KEY, String(statusSel.value || 'all'));
      applyDirectoryFilters(root);
    });
    repoSel.addEventListener('change', () => {
      store(DIR_REPO_KEY, String(repoSel.value || ''));
      applyDirectoryFilters(root);
    });

    host.appendChild(root);
  },

  update(host, session, graph) {
    const root = host.querySelector('.peer-dir');
    if (!root) return;
    const p = peerData(graph);
    const notes = root.querySelector('.peer-dir-notes');
    const body = root.querySelector('.peer-dir-body');
    const meta = root.querySelector('.peer-dir-meta');
    const empty = root.querySelector('.peer-dir-empty');
    if (!notes || !body || !meta || !empty) return;

    // Nowhere to look. The same words as the panel's, because it is the same
    // state and a second phrasing for it would read as a second problem.
    if (p && !p.configured) {
      notes.replaceChildren(el('p', 'peer-note', 'No session registry URL is set, so peer messaging is doing nothing. Set one from the cog on its row in the Extensions tab.'));
      body.replaceChildren();
      meta.textContent = '';
      empty.textContent = '';
      lastRenderedAt = undefined;
      lastBoardKey = null;
      return;
    }

    const reg = registryData(graph);
    const noteParts = [];
    if (p && p.registryUp === false) {
      // The last snapshot is still drawn below: stale and labelled beats blank.
      noteParts.push(el('p', 'peer-note peer-warn', 'The session registry is unreachable. Nothing is lost — messages are re-read when it is back.'));
    }
    if (reg.truncated) {
      noteParts.push(el('p', 'peer-note peer-warn', 'There are more sessions than the board will carry at once.'));
    }
    notes.replaceChildren(...noteParts);

    const boardIds = boardSessionIds(graph);
    const boardKey = [...boardIds].sort().join(',');
    // A fetch that changed nothing, on a board whose cards have not moved,
    // redraws nothing: the "this board" tag is the only part of a card that
    // depends on anything outside the snapshot.
    if (reg.fetchedAt === lastRenderedAt && boardKey === lastBoardKey) return;
    lastRenderedAt = reg.fetchedAt;
    lastBoardKey = boardKey;

    renderDirectory(root, reg, boardIds);
  },

  unmount() {
    directoryApi = null;
    lastRenderedAt = undefined;
    lastBoardKey = null;
  },
};

function renderDirectory(root, reg, boardIds) {
  const body = root.querySelector('.peer-dir-body');
  const meta = root.querySelector('.peer-dir-meta');
  const empty = root.querySelector('.peer-dir-empty');
  const now = Date.now();

  // Most recently active repo first, tie-broken on key — `buildUIPage`'s sort,
  // and for the same reason: something has to make the order deterministic.
  const repos = Object.keys(reg.repos)
    .map((key) => {
      const entries = Array.isArray(reg.repos[key]) ? reg.repos[key].filter((e) => e && typeof e === 'object') : [];
      let latest = 0;
      for (const e of entries) {
        const t = Date.parse(e.startedAt);
        if (Number.isFinite(t) && t > latest) latest = t;
      }
      return { key, entries, latest };
    })
    .filter((r) => r.entries.length)
    .sort((a, b) => (b.latest - a.latest) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const count = repos.reduce((n, r) => n + r.entries.length, 0);
  meta.textContent = `${count} session(s) started in the last ${DIR_WINDOW_HOURS} hours, across ${repos.length} repo(s).`
    + (reg.fetchedAt == null ? '' : ` As of ${stamp(reg.fetchedAt)}.`);

  const sections = [];
  for (const repo of repos) {
    const section = el('section', 'peer-dir-repo');
    section.dataset.repoKey = repo.key;
    section.appendChild(el('h2', 'peer-dir-repo-name', repo.key));

    const live = repo.entries.filter((e) => e.finishedAt == null);
    const ended = repo.entries.filter((e) => e.finishedAt != null);

    if (live.length) {
      const block = el('div', 'peer-dir-live');
      block.dataset.block = 'live';
      for (const e of live) block.appendChild(directoryCard(e, now, boardIds));
      section.appendChild(block);
    }
    if (ended.length) {
      const heading = el('h3', 'peer-dir-ended-heading', 'recently ended');
      heading.dataset.block = 'ended';
      section.appendChild(heading);
      const block = el('div', 'peer-dir-ended');
      block.dataset.block = 'ended';
      for (const e of ended) block.appendChild(directoryCard(e, now, boardIds));
      section.appendChild(block);
    }
    sections.push(section);
  }
  body.replaceChildren(...sections);

  if (!repos.length) {
    empty.textContent = reg.fetchedAt == null
      ? 'Waiting for the first sweep…'
      : `No sessions started in the last ${DIR_WINDOW_HOURS} hours. That is an empty registry, not a broken page.`;
  } else {
    empty.textContent = '';
  }

  syncRepoOptions(root, repos.map((r) => r.key));
  applyDirectoryFilters(root);
}

// One card. EVERY string on it came off a remote relay by way of the registry
// and lands via textContent — see the file header. No `dataset.id` anywhere,
// because settings.js's delegated toggle handler looks a row up by it.
function directoryCard(entry, now, boardIds) {
  const card = el('div', 'peer-dir-card');

  const top = el('div', 'peer-dir-top');
  const intent = String(entry.intent || '');
  // An empty intent is a placeholder rather than a skip: a session that never
  // said what it was for is worth seeing as such.
  top.appendChild(intent
    ? el('p', 'peer-dir-intent', intent)
    : el('p', 'peer-dir-intent absent', 'no intent set'));
  const finished = entry.finishedAt == null ? null : Date.parse(entry.finishedAt);
  top.appendChild(el('span', 'peer-dir-chip', entry.finishedAt == null
    ? 'no end recorded'
    : `ended ${ageWord(now - finished)} ago`));
  card.appendChild(top);

  const handle = typeof entry.messagingHandle === 'string' ? entry.messagingHandle : '';
  if (handle) {
    // Rendered as the call to make, matching the brief's own `SendMessage to
    // %q` line rather than as a labelled field.
    card.appendChild(el('p', 'peer-dir-handle', `SendMessage to "${handle}"`));
  }

  const meta = el('div', 'peer-dir-cardmeta');
  if (entry.owner) meta.appendChild(el('span', 'peer-dir-owner', entry.owner));
  if (entry.branch) meta.appendChild(el('span', 'peer-dir-branch', `branch ${entry.branch}`));
  const started = Date.parse(entry.startedAt);
  if (Number.isFinite(started)) meta.appendChild(el('span', 'peer-dir-started', `started ${ageWord(now - started)} ago`));
  meta.appendChild(el('span', 'peer-dir-origin', originWord(entry.origin)));
  meta.appendChild(el('span', 'peer-dir-shortid', shortId(entry.sessionId)));
  card.appendChild(meta);

  const detail = String(entry.detail || '');
  if (detail) {
    // Native <details>: the newlines are kept by CSS (white-space: pre-wrap),
    // never by emitting markup around the text.
    const box = el('details', 'peer-dir-details');
    box.appendChild(el('summary', 'peer-dir-details-summary', 'detail'));
    box.appendChild(el('p', 'peer-dir-detail', detail));
    card.appendChild(box);
  }

  if (handle && boardIds.has(handle)) {
    card.className = 'peer-dir-card peer-dir-mine';
    meta.appendChild(el('span', 'peer-tag', 'this board'));
    if (typeof card.setAttribute === 'function') card.setAttribute('role', 'link');
    // CLICK ONLY, and deliberately no tabindex and no keydown: this file's
    // rule is that Enter never activates anything it draws.
    card.addEventListener('click', (event) => {
      // A click on the disclosure triangle is about the detail, not the card.
      const target = event && event.target;
      if (target && typeof target.closest === 'function' && target.closest('details')) return;
      globalThis.location.hash = `#session=${encodeURIComponent(handle)}`;
    });
  }

  return card;
}

// The repo <option>s are rebuilt from the sections that were just drawn, so
// the dropdown and the page can never drift apart.
function syncRepoOptions(root, keys) {
  const sel = root.querySelector('.peer-dir-repo-filter');
  if (!sel) return;
  const wanted = stored(DIR_REPO_KEY);
  const current = String(sel.value || '');
  const opts = [option('', 'all repos')];
  for (const key of keys) opts.push(option(key, key));
  sel.replaceChildren(...opts);
  // Keep the live choice if it survived, else the stored one if it did, else
  // fall back to all repos rather than to a selection that hides everything.
  sel.value = keys.includes(current) ? current : (wanted && keys.includes(wanted) ? wanted : '');
}

// The dashboard's `apply`, on already-rendered nodes: this hides and unhides,
// it never rebuilds.
function applyDirectoryFilters(root) {
  const body = root.querySelector('.peer-dir-body');
  const statusSel = root.querySelector('.peer-dir-status');
  const repoSel = root.querySelector('.peer-dir-repo-filter');
  const summary = root.querySelector('.peer-dir-summary');
  const nomatch = root.querySelector('.peer-dir-nomatch');
  if (!body) return;
  const status = statusSel ? String(statusSel.value || 'all') : 'all';
  const repo = repoSel ? String(repoSel.value || '') : '';

  const sections = [...(body.children || [])].filter((n) => n && n.dataset && n.dataset.repoKey != null);
  let visible = 0;
  for (const section of sections) {
    const blocks = [...(section.children || [])].filter((n) => n && n.dataset && n.dataset.block);
    let anyBlock = false;
    for (const block of blocks) {
      const show = status === 'all' || block.dataset.block === status;
      block.hidden = !show;
      if (show) anyBlock = true;
    }
    const show = anyBlock && (!repo || section.dataset.repoKey === repo);
    section.hidden = !show;
    if (show) visible += 1;
  }
  if (nomatch) nomatch.hidden = !sections.length || visible > 0;
  if (summary) {
    summary.textContent = !sections.length
      ? ''
      : (visible === sections.length
        ? `showing all ${sections.length} repo(s)`
        : `showing ${visible} of ${sections.length} repo(s)`);
  }
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
    slots.register('view', directoryView);
  },
};
