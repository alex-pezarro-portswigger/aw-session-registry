import { STATE_FILE } from './data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';

// Per-card cap on messages waiting for a human. Checked BEFORE the append, so a
// refused add never partially lands.
//
// Over cap the sweep DROPS the incoming message and ACKS it anyway. That is not
// a shrug: the relay's own per-target queue caps at 100 and its drain is
// non-destructive, so leaving an over-cap message unacked means re-drawing it,
// re-refusing it and re-draining it on every sweep, for ever, until its 6-hour
// TTL. 50 unread peer messages on one card is already a human who is not
// reading them.
export const MAX_PENDING_PER_SESSION = 50;

// Matches the relay's `DefaultMaxBodyChars` (mailbox/store.go), so this never
// stores more than the relay would have carried. An inbound body has been
// through `sanitize.MessageBody` already; truncating again is not distrust of
// the relay so much as refusing to let the cap live in one place only.
export const MAX_BODY_CHARS = 4096;

// A capped ring of message ids per card, oldest evicted. THIS is what makes the
// relay's non-destructive drain idempotent: a message drained but not yet acked
// — a crash between our persist and our ack — comes back on the next sweep and
// is skipped by id rather than shown twice. 200 comfortably exceeds the relay's
// per-target cap of 100, which is the most that can be in flight at once.
export const SEEN_RING = 200;

// The thread is a convenience log for the human, not the record of anything;
// oldest entries fall off.
export const MAX_THREAD_PER_PEER = 50;
export const MAX_INTENT_REMINDERS = 3;

const VERSION = 1;

// The extension's own durable state, on the `checklist-store.js` mould — and
// that mould is load-bearing here rather than stylistic. The sweep and all six
// control handlers write in ONE process, and an `await` between a read and its
// write is exactly where one clobbers the other. So: state in memory, mutators
// are SYNCHRONOUS, persistence is a side effect of mutation, and there is no
// `await` anywhere in this class. `atomic-json` gives crash-safe writes, not
// transactional read-modify-write.
//
// Keyed on the CARD ID throughout, never a conversation id: the card id is the
// only stable per-session handle the wrangler owns, it is what `host.deliver`
// addresses, and `host-api/project.js` deliberately withholds `liveSessionId`
// from an extension at all.
//
// ON THE FIREBREAK. `pending` is where an inbound message waits for a human
// click, and nothing in this class delivers anything. Unapproved text lives
// here and on the approval card and nowhere else — there is no "denied" archive
// (see deny()), no held preview, and no counter that nudges a pane. The ONE
// route from here into agent context is a caller that has already checked
// isAutoAllowed(), or a human who clicked.
export class PeerMessageStore {
  constructor({ file = STATE_FILE, log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.pending = new Map();  // cardId -> [envelope]
    this.channels = new Map(); // cardId -> Map(peerHandle -> channel)
    this.threads = new Map();  // cardId -> Map(peerHandle -> [entry])
    this.seen = new Map();     // cardId -> { order: [id], ids: Set }
    this.intentReminders = new Map(); // cardId -> { count, noted, briefed }
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, { log: this.log });
    if (!raw || typeof raw !== 'object') return; // missing/empty = first run
    // No migration table: `version` is stamped so a future shape change has
    // something to branch on, and an unrecognised one starts empty rather than
    // guessing (peer chatter is not state worth a risky migration for).
    if (raw.version !== VERSION) {
      if (raw.version != null) this.log(`state.json is version ${raw.version}, this build understands ${VERSION} — starting from empty state.`);
      return;
    }
    for (const [cardId, list] of Object.entries(raw.pending || {})) {
      if (Array.isArray(list)) this.pending.set(cardId, list.map(readEnvelope).filter(Boolean));
    }
    for (const [cardId, byPeer] of Object.entries(raw.channels || {})) {
      if (!byPeer || typeof byPeer !== 'object') continue;
      const m = new Map();
      for (const [peer, ch] of Object.entries(byPeer)) m.set(peer, readChannel(ch));
      this.channels.set(cardId, m);
    }
    for (const [cardId, byPeer] of Object.entries(raw.threads || {})) {
      if (!byPeer || typeof byPeer !== 'object') continue;
      const m = new Map();
      for (const [peer, list] of Object.entries(byPeer)) {
        if (Array.isArray(list)) m.set(peer, list.map(readThreadEntry).filter(Boolean));
      }
      this.threads.set(cardId, m);
    }
    for (const [cardId, ids] of Object.entries(raw.seen || {})) {
      if (!Array.isArray(ids)) continue;
      const order = ids.filter((x) => typeof x === 'string').slice(-SEEN_RING);
      this.seen.set(cardId, { order, ids: new Set(order) });
    }
    for (const [cardId, state] of Object.entries(raw.intentReminders || {})) {
      if (!state || typeof state !== 'object') continue;
      const count = Number.isInteger(state.count) ? Math.max(0, Math.min(MAX_INTENT_REMINDERS, state.count)) : 0;
      this.intentReminders.set(cardId, { count, noted: Boolean(state.noted), briefed: Boolean(state.briefed) });
    }
  }

  _save() {
    writeJsonAtomic(this.file, {
      version: VERSION,
      pending: Object.fromEntries([...this.pending].map(([c, l]) => [c, l])),
      channels: Object.fromEntries([...this.channels].map(([c, m]) => [c, Object.fromEntries(m)])),
      threads: Object.fromEntries([...this.threads].map(([c, m]) => [c, Object.fromEntries(m)])),
      seen: Object.fromEntries([...this.seen].map(([c, s]) => [c, s.order])),
      intentReminders: Object.fromEntries(this.intentReminders),
    });
  }

  // Keeps every map sparse: an emptied list drops its key rather than
  // persisting `{"<cardId>": []}` for every card that ever had one message.
  _prunePending(cardId, list) {
    if (list.length) this.pending.set(cardId, list);
    else this.pending.delete(cardId);
  }

  _channelsFor(cardId, create = false) {
    let m = this.channels.get(cardId);
    if (!m && create) { m = new Map(); this.channels.set(cardId, m); }
    return m;
  }

  _channel(cardId, peerHandle, create = false) {
    const m = this._channelsFor(cardId, create);
    if (!m) return null;
    let ch = m.get(peerHandle);
    if (!ch && create) { ch = readChannel(null); m.set(peerHandle, ch); }
    return ch || null;
  }

  _markSeen(cardId, msgId) {
    let s = this.seen.get(cardId);
    if (!s) { s = { order: [], ids: new Set() }; this.seen.set(cardId, s); }
    if (s.ids.has(msgId)) return;
    s.order.push(msgId);
    s.ids.add(msgId);
    while (s.order.length > SEEN_RING) s.ids.delete(s.order.shift());
  }

  _appendThread(cardId, peerHandle, entry) {
    let byPeer = this.threads.get(cardId);
    if (!byPeer) { byPeer = new Map(); this.threads.set(cardId, byPeer); }
    const list = byPeer.get(peerHandle) || [];
    list.push(entry);
    while (list.length > MAX_THREAD_PER_PEER) list.shift();
    byPeer.set(peerHandle, list);
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  // Take one drained envelope. Returns one of:
  //   'invalid' — unusable (no id, no sender, empty body). Nothing is stored.
  //   'seen'    — this id has been handled before. The ONLY outcome that does
  //               not mark the id seen, because it already is.
  //   'blocked' — this card has blocked this peer. Dropped.
  //   'full'    — over MAX_PENDING_PER_SESSION. Dropped.
  //   'stored'  — waiting for a human.
  // The caller ACKS on every one of them: each is a settled outcome, and an
  // unacked message is re-drained for ever (see MAX_PENDING_PER_SESSION).
  receive(cardId, envelope) {
    const e = readEnvelope(envelope);
    if (!cardId || !e) return 'invalid';
    const s = this.seen.get(cardId);
    if (s && s.ids.has(e.id)) return 'seen';

    const ch = this._channel(cardId, e.fromHandle);
    if (ch?.blocked) {
      this._markSeen(cardId, e.id);
      this._save();
      return 'blocked';
    }

    const list = this.pending.get(cardId) || [];
    if (list.length >= MAX_PENDING_PER_SESSION) {
      this._markSeen(cardId, e.id);
      this._save();
      return 'full';
    }

    list.push(e);
    this._prunePending(cardId, list);
    this._markSeen(cardId, e.id);
    // The peer's asserted display, remembered so a channel row can name it with
    // nothing pending. ECHOED, never verified — see the frame's first line.
    const live = this._channel(cardId, e.fromHandle, true);
    if (e.fromDisplay) live.lastDisplay = e.fromDisplay;
    this._save();
    return 'stored';
  }

  // One pending message, for a caller about to frame and deliver it. A copy:
  // the caller must not be able to edit what is still waiting for approval.
  pendingMessage(cardId, msgId) {
    const found = (this.pending.get(cardId) || []).find((e) => e.id === msgId);
    return found ? { ...found } : null;
  }

  pendingFor(cardId) {
    return (this.pending.get(cardId) || []).map((e) => ({ ...e }));
  }

  // The sweep's SINGLE gate, and the whole of what "Allow all from this session"
  // means. Nothing else in this extension may put text in front of an agent
  // without a human click.
  isAutoAllowed(cardId, peerHandle) {
    return Boolean(this._channel(cardId, peerHandle)?.allowAll) && !this._channel(cardId, peerHandle)?.blocked;
  }

  // A human said yes (or a pre-approved pair delivered). Drops it from pending,
  // logs it on the thread with the `mode` host.deliver reported, and — only when
  // asked — records the standing approval for that (card, peer) pair.
  // Returns false for an unknown id, so a double-click is a no-op not a throw.
  approve(cardId, msgId, { allowAll = false, at = Date.now(), mode = null } = {}) {
    const list = this.pending.get(cardId) || [];
    const at_ = list.findIndex((e) => e.id === msgId);
    if (at_ < 0) return false;
    const [e] = list.splice(at_, 1);
    this._prunePending(cardId, list);
    this._appendThread(cardId, e.fromHandle, { id: e.id, dir: 'in', body: e.body, at, mode });
    const ch = this._channel(cardId, e.fromHandle, true);
    if (e.fromDisplay) ch.lastDisplay = e.fromDisplay;
    if (allowAll) { ch.allowAll = true; ch.allowedAt = at; }
    this._save();
    return true;
  }

  // Drop it. Nothing is appended anywhere — there is deliberately NO "denied"
  // archive, because the whole point of the firebreak is that unapproved text
  // does not accumulate. The id stays in `seen`, so the relay re-delivering it
  // before our ack lands does not resurrect it.
  deny(cardId, msgId) {
    const list = this.pending.get(cardId) || [];
    const at = list.findIndex((e) => e.id === msgId);
    if (at < 0) return false;
    list.splice(at, 1);
    this._prunePending(cardId, list);
    this._save();
    return true;
  }

  // ── Channels ───────────────────────────────────────────────────────────────

  // Block a peer for this card: drops THAT PEER's pending for this card only,
  // and refuses its future messages at receive().
  block(cardId, peerHandle, { at = Date.now() } = {}) {
    const ch = this._channel(cardId, peerHandle, true);
    ch.blocked = true;
    ch.blockedAt = at;
    ch.allowAll = false;
    ch.allowedAt = null;
    const list = (this.pending.get(cardId) || []).filter((e) => e.fromHandle !== peerHandle);
    this._prunePending(cardId, list);
    this._save();
    return true;
  }

  unblock(cardId, peerHandle) {
    const ch = this._channel(cardId, peerHandle);
    if (!ch || !ch.blocked) return false;
    ch.blocked = false;
    ch.blockedAt = null;
    this._save();
    return true;
  }

  // Withdraw a standing approval and NOTHING else. Pending and thread survive:
  // revoking consent for what comes next is not the same as denying what is
  // already waiting, and silently binning it would be a nasty surprise.
  revoke(cardId, peerHandle) {
    const ch = this._channel(cardId, peerHandle);
    if (!ch || !ch.allowAll) return false;
    ch.allowAll = false;
    ch.allowedAt = null;
    this._save();
    return true;
  }

  channelsFor(cardId) {
    const m = this._channelsFor(cardId);
    return m ? [...m].map(([peerHandle, ch]) => ({ peerHandle, ...ch })) : [];
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  // The send tool's own record. Fire-and-forget by design: there are no
  // receipts and no delivery confirmation to fill in later, because the peer's
  // human has to approve it and the relay cannot report on that.
  appendOut(cardId, peerHandle, body, at = Date.now()) {
    const text = truncate(String(body ?? '').trim(), MAX_BODY_CHARS);
    if (!text) return false;
    this._appendThread(cardId, peerHandle, { id: null, dir: 'out', body: text, at, mode: 'sent' });
    this._channel(cardId, peerHandle, true);
    this._save();
    return true;
  }

  threadFor(cardId, peerHandle) {
    return (this.threads.get(cardId)?.get(peerHandle) || []).map((x) => ({ ...x }));
  }

  // The native UserPromptSubmit hook fires before the model request. Count one
  // reminder per prompt until this card calls update_session_note successfully.
  // Both operations are synchronous so concurrent prompt/tool callbacks cannot
  // read the same count and emit a fourth reminder.
  nextIntentReminder(cardId) {
    if (!cardId) return false;
    const state = this.intentReminders.get(cardId) || { count: 0, noted: false, briefed: false };
    if (state.noted || state.count >= MAX_INTENT_REMINDERS) return false;
    this.intentReminders.set(cardId, { ...state, count: state.count + 1 });
    this._save();
    return true;
  }

  markIntentNoted(cardId) {
    if (!cardId) return false;
    const state = this.intentReminders.get(cardId) || { count: 0, noted: false, briefed: false };
    if (state.noted) return false;
    this.intentReminders.set(cardId, { ...state, noted: true });
    this._save();
    return true;
  }

  isIntentNoted(cardId) {
    return Boolean(this.intentReminders.get(cardId)?.noted);
  }

  hasBriefed(cardId) {
    return Boolean(this.intentReminders.get(cardId)?.briefed);
  }

  markBriefed(cardId) {
    if (!cardId || this.hasBriefed(cardId)) return false;
    const state = this.intentReminders.get(cardId) || { count: 0, noted: false, briefed: false };
    this.intentReminders.set(cardId, { ...state, briefed: true });
    this._save();
    return true;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  // Archive: unapproved text must not outlive the session it was addressed to,
  // and a standing approval must not survive into a resume nobody re-consented
  // for. Threads and `seen` stay — the thread is the human's log of what did
  // happen, and dropping `seen` would let an unacked message be shown again.
  closeSession(cardId) {
    let changed = this.pending.delete(cardId);
    for (const ch of this._channelsFor(cardId)?.values() || []) {
      if (ch.allowAll) { ch.allowAll = false; ch.allowedAt = null; changed = true; }
    }
    if (changed) this._save();
    return changed;
  }

  // Purge: the card is gone for good, so everything for it goes. A card id never
  // recurs, so there is no future session a leftover channel row could grant
  // anything to — which is also why a PEER session ending needs nothing here.
  forgetSession(cardId) {
    // Four separate deletes, deliberately NOT `a() || b() || …`: `||`
    // short-circuits, so the first map that had something would be the only one
    // emptied and a purged card would keep its thread, its channels and its
    // seen ring. Every one of those holds peer prose or a human's decision.
    let changed = false;
    for (const m of [this.pending, this.channels, this.threads, this.seen, this.intentReminders]) {
      if (m.delete(cardId)) changed = true;
    }
    if (changed) this._save();
    return changed;
  }

  // ── The graph ──────────────────────────────────────────────────────────────

  // The plain object lib/graph.js reads. Bodies ARE here, for the pending list
  // only — see the (a)-vs-(b) decision recorded in lib/graph.js. Nothing
  // approved, denied or blocked carries a body.
  snapshot() {
    return {
      pending: Object.fromEntries([...this.pending].map(([c, l]) => [c, l.map((e) => ({ ...e }))])),
      channels: Object.fromEntries([...this.channels].map(([c, m]) => [c, Object.fromEntries([...m].map(([p, ch]) => [p, { ...ch }]))])),
      threads: Object.fromEntries([...this.threads].map(([c, m]) => [c, Object.fromEntries([...m].map(([p, l]) => [p, l.map((x) => ({ ...x }))]))])),
    };
  }
}

// Normalise one inbound envelope into what is stored, refusing anything
// unusable. `toHandle`/`toRepo` are deliberately NOT stored: the card id is the
// key, and the repo is derivable from the card. `fromDisplay` is
// the SENDER's assertion, relayed and never verified.
function readEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  const fromHandle = str(raw.fromHandle);
  // Trimmed, then cap-checked, mirroring the relay's `sanitize.MessageBody`
  // (which trims and 400s an empty result) — a whitespace-only body cannot
  // reach us through the relay, and storing one would draw a blank approval
  // card with nothing on it to decide about.
  const body = truncate(str(raw.body).trim(), MAX_BODY_CHARS);
  if (!id || !fromHandle || !body) return null;
  return {
    id,
    fromHandle,
    fromRepo: str(raw.fromRepo),
    fromDisplay: str(raw.fromDisplay),
    body,
    createdAt: str(raw.createdAt) || null,
    receivedAt: Number.isFinite(raw.receivedAt) ? raw.receivedAt : Date.now(),
  };
}

function readChannel(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    allowAll: Boolean(c.allowAll),
    allowedAt: Number.isFinite(c.allowedAt) ? c.allowedAt : null,
    blocked: Boolean(c.blocked),
    blockedAt: Number.isFinite(c.blockedAt) ? c.blockedAt : null,
    lastDisplay: str(c.lastDisplay),
  };
}

function readThreadEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = truncate(str(raw.body).trim(), MAX_BODY_CHARS);
  if (!body) return null;
  return {
    id: str(raw.id) || null,
    dir: raw.dir === 'out' ? 'out' : 'in',
    body,
    at: Number.isFinite(raw.at) ? raw.at : null,
    mode: str(raw.mode) || null,
  };
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Runes, not UTF-16 code units — the relay caps in runes (Go ranges over the
// string), so a body of 4096 emoji must survive this unchanged rather than come
// back half the length.
function truncate(s, max) {
  const runes = [...s];
  return runes.length <= max ? s : runes.slice(0, max).join('');
}
