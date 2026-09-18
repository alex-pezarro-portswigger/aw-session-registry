import { MAX_BODY_CHARS, MAX_PENDING_PER_SESSION } from './store.js';

// The graph contributor: `graph.peerMessaging`, rebuilt on every ~4s board tick.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ `rebuildOnce` IS THE TICK WHERE NOTHING MAY LOG OR THROW.               │
// └─────────────────────────────────────────────────────────────────────────┘
// So this reads the in-memory store and two module-level booleans, and does
// NOTHING else: no `fetch`, no `fs`, no `git`, and deliberately not
// `host.sessions.list()` — that is an O(n) deep-freeze projection per tick for
// data the graph already carries, and the client intersects `bySession` with
// the graph's own sessions anyway.
//
// `assertGraphKeys` checks the returned keys ONCE PER ACTIVATION against
// `{graph: {}}`, so this must not throw on an empty graph and must not read
// anything off the one it is handed. It does not read `graph` at all.
//
// ── THE §B.10 DECISION: (a), pending bodies ON the graph ────────────────────
//
// The two options were (a) carry every pending body on the graph, or (b) add a
// seventh `peer-inbox {sessionId}` handler the panel sends on selection.
//
// TAKEN: (a). Three reasons, in order of weight.
//
//  1. There is no `ctx.reply` for an extension handler. A tagged handler is
//     called `handler(msg, host)` and gets the façade instead of the router's
//     ctx, so (b) is not a request/response at all — it is "send a frame, then
//     wait for the answer to turn up on a later graph, and hope the selection
//     has not changed by then". That is strictly more machinery for strictly
//     less certainty.
//  2. The worst case is bounded and small. 50 pending × 4096 chars is 200KB per
//     card, and BOTH caps are enforced by the store rather than hoped for. A
//     card at that cap is a human who has not read 50 peer messages — the graph
//     size is not their problem.
//  3. (b) would put the panel's content behind a round trip that the approval
//     card needs on FIRST paint. A blank approval card that fills in a tick
//     later is worse UX than a slightly larger graph.
//
// REVISIT IF: the typical (not worst) case gets fat — several cards each
// holding tens of pending messages — or if a future core change gives an
// extension handler a reply channel, at which point (b) becomes cheap. The
// `graphBudget` below is the tripwire: it caps what one tick can carry so a
// pathological board degrades to counts rather than to a 10MB graph.

// A hard ceiling on the bodies one tick may carry, independent of the per-card
// caps: those bound ONE card, and a board can have many. Past it, a card's
// bodies are dropped and `truncated` says so, so the panel can tell the human
// to deal with the backlog rather than silently showing nothing.
export const MAX_GRAPH_BODY_CHARS = 8 * MAX_PENDING_PER_SESSION * 1024; // ~400KB

// Set by the sweep, read here. A module-level boolean rather than anything this
// contributor computes, because computing it would mean a network call on the
// ~4s tick.
let registryUp = null;
export function noteRegistryUp(up) {
  registryUp = up == null ? null : Boolean(up);
}

export function peerMessagingGraph({ host }) {
  const s = host.stores?.peerMessages;
  // `assertGraphKeys` runs this against `{graph: {}}`, and a contributor that
  // throws there quarantines the whole extension at activation. Answer honestly
  // with nothing rather than assuming the store is there.
  if (!s) return { peerMessaging: emptyContribution() };

  const snap = s.snapshot();
  const bySession = {};
  const inbox = {};
  let budget = MAX_GRAPH_BODY_CHARS;
  let truncated = false;

  const cardIds = new Set([...Object.keys(snap.pending), ...Object.keys(snap.channels), ...Object.keys(snap.threads)]);
  for (const cardId of cardIds) {
    const pending = snap.pending[cardId] || [];
    const threads = snap.threads[cardId] || {};
    const chans = snap.channels[cardId] || {};
    const channelRows = [...new Set([...Object.keys(chans), ...Object.keys(threads)])]
      .map((peerHandle) => {
        const c = chans[peerHandle] || {};
        const thread = threads[peerHandle] || [];
        const lastIn = [...thread].reverse().find((x) => x.dir === 'in') || null;
        return {
          peerHandle,
          allowAll: Boolean(c.allowAll),
          allowedAt: c.allowedAt ?? null,
          blocked: Boolean(c.blocked),
          lastDisplay: c.lastDisplay || '',
          // Counts and the LAST OUTCOME, deliberately WITHOUT bodies. The
          // thread is the human's log of what happened; putting its prose on
          // the graph would multiply the per-card cost by the number of peers
          // for text that is already in the pane and in the agent's context,
          // and no approval decision depends on it. `mode` is what the panel
          // needs — it is how "Delivered" / "Woke the card and delivered" /
          // "Could not deliver" survives a reload, which the live broadcast
          // (onMessage) alone does not.
          inCount: thread.filter((x) => x.dir === 'in').length,
          outCount: thread.filter((x) => x.dir === 'out').length,
          lastIn: lastIn ? { at: lastIn.at, mode: lastIn.mode } : null,
        };
      })
      // A row exists as soon as a peer is heard from; one that says nothing a
      // human can act on or read back is not worth a graph entry.
      .filter((c) => c.allowAll || c.blocked || c.inCount || c.outCount);
    if (!pending.length && !channelRows.length) continue;

    // Three integers per card, which is what keeps this off the per-card cost
    // budget: the pill reads only this.
    bySession[cardId] = {
      pending: pending.length,
      allowAll: channelRows.filter((c) => c.allowAll).length,
      blocked: channelRows.filter((c) => c.blocked).length,
    };

    const messages = [];
    for (const e of pending) {
      if (e.body.length > budget) { truncated = true; break; }
      budget -= e.body.length;
      messages.push({
        id: e.id,
        // Every one of these is the SENDER's assertion, relayed and unverified.
        // The panel renders them via textContent and labels them as claims.
        fromHandle: e.fromHandle,
        fromRepo: e.fromRepo,
        fromDisplay: e.fromDisplay,
        body: e.body,
        createdAt: e.createdAt,
        receivedAt: e.receivedAt,
      });
    }
    // An OBJECT, not an array with a property hung off it: the graph is
    // JSON.stringify'd onto the wire, and stringify drops a non-index property
    // from an array silently — the channel list would simply never arrive.
    inbox[cardId] = { messages, channels: channelRows };
  }

  return {
    peerMessaging: {
      bySession,
      inbox,
      // Off the store and the settings only — cheap, and what tells the panel
      // the difference between "nothing has arrived" and "this extension has
      // nowhere to look".
      configured: Boolean(host.settings?.get('registryUrl')),
      registryUp,
      truncated,
      maxBodyChars: MAX_BODY_CHARS,
    },
  };
}

function emptyContribution() {
  return { bySession: {}, inbox: {}, configured: false, registryUp: null, truncated: false, maxBodyChars: MAX_BODY_CHARS };
}
