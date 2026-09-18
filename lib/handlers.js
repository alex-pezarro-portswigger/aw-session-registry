import { frame } from './framing.js';

// The six control handlers behind the buttons on an approval card, each invoked
// as `handler(msg, host)` — the shape `control/router.js` uses for a handler the
// loader tagged with an extension id. There is deliberately NO `ctx.reply`: a
// tagged handler gets the façade instead of the router's ctx, so the two ways
// to tell the clicking human anything are the graph (durable, next tick) and
// `host.broadcast` (live, and only reaches the browser because of the
// `onMessage` seam — HOST_API_VERSION 1.2.0).
//
// This uses BOTH, on purpose and not as belt and braces:
//   - the store's thread entry carries the `mode` host.deliver returned, so the
//     outcome is DURABLE and survives a reload;
//   - the broadcast is the LIVE ack, so a click that woke a dormant card says
//     so at once instead of up to a graph tick later.
// Neither is sufficient alone: without the graph a reload loses the outcome,
// and without the broadcast the button feels dead for several seconds.
//
// A handler THROW becomes the router's `{type:'error'}` envelope, which the
// board already surfaces as a toast — so there is no per-handler try/catch and
// an unknown message id is a throw rather than a silent no-op.

function store(host) {
  return host.stores.peerMessages;
}

// `type` is FORCED to `ext:peer-messaging` server-side (host-api/v1.js), so
// `kind` is this extension's own discriminator inside its own channel. No
// message BODY ever goes on a broadcast — an outcome is not content.
function report(host, payload) {
  host.broadcast(payload);
}

function need(msg, field) {
  const v = msg?.[field];
  if (typeof v !== 'string' || !v) throw new Error(`peer-messaging: ${field} is required`);
  return v;
}

// Approve one message: frame it, put it in front of the agent, and only then
// record it. The order matters — the thread entry carries what actually
// happened, so it cannot be written before `deliver` has said.
async function approve(msg, host, { allowAll }) {
  const sessionId = need(msg, 'sessionId');
  const messageId = need(msg, 'messageId');
  const s = store(host);
  const pending = s.pendingMessage(sessionId, messageId);
  if (!pending) throw new Error(`peer-messaging: no message ${messageId} is waiting on that session (it may already have been approved or denied).`);

  const at = Date.now();
  // Framed HERE rather than at receive time: the frame records that a human
  // approved it and WHEN, which is not knowable until this moment.
  const text = frame({
    body: pending.body,
    fromDisplay: pending.fromDisplay,
    fromHandle: pending.fromHandle,
    fromRepo: pending.fromRepo,
    approvedAt: at,
  });
  // Wakes a dormant or suspended target and delivers after the relaunch,
  // refuses an archived one, and reports which happened. Someone has just
  // clicked, so this delivery is genuinely ADDRESSED — which is what makes
  // `deliver` (a paste at the composer cursor) right for this path and wrong
  // for the sweep's auto-allow one. See the README.
  const result = await host.deliver(sessionId, text);

  // Recorded whatever happened, including a failure: `mode: 'error'` on the
  // thread is how the panel can say "could not deliver" instead of looking as
  // though the click did nothing. The message leaves `pending` either way —
  // re-approving a message the target cannot receive would just fail again, and
  // the thread now holds the text.
  s.approve(sessionId, messageId, { allowAll, at, mode: result?.mode ?? null });
  report(host, {
    kind: 'approved',
    sessionId,
    messageId,
    allowAll,
    mode: result?.mode ?? null,
    error: result?.mode === 'error' ? String(result.error || 'delivery failed') : null,
  });
  host.rebuild();
}

export const peerApprove = {
  type: 'peer-approve',
  handler: (msg, host) => approve(msg, host, { allowAll: false }),
};

// "Allow all from this session" — the ONE thing that lets a later message reach
// the agent with no click. Per (card, peer) pair, off by default, and revocable.
// The consequence the button's copy has to state: a pre-approved message
// arriving off the sweep pastes at the composer's cursor and can splice itself
// into a half-typed draft, because the mid-prompt hold is not wired to this
// seam and nothing at it can tell an addressed message from an automated one.
export const peerAllowAll = {
  type: 'peer-allow-all',
  handler: (msg, host) => approve(msg, host, { allowAll: true }),
};

export const peerDeny = {
  type: 'peer-deny',
  handler: (msg, host) => {
    const sessionId = need(msg, 'sessionId');
    const messageId = need(msg, 'messageId');
    // Denied text is GONE — no archive, nothing on the thread. That is the
    // point of the firebreak: unapproved content does not accumulate anywhere.
    if (!store(host).deny(sessionId, messageId)) throw new Error(`peer-messaging: no message ${messageId} is waiting on that session.`);
    report(host, { kind: 'denied', sessionId, messageId });
    host.rebuild();
  },
};

export const peerBlock = {
  type: 'peer-block',
  handler: (msg, host) => {
    const sessionId = need(msg, 'sessionId');
    const peerHandle = need(msg, 'peerHandle');
    // Drops that peer's pending for THIS card only, and withdraws any standing
    // approval — blocked and auto-allowed must never coexist.
    store(host).block(sessionId, peerHandle);
    report(host, { kind: 'blocked', sessionId, peerHandle });
    host.rebuild();
  },
};

export const peerUnblock = {
  type: 'peer-unblock',
  handler: (msg, host) => {
    const sessionId = need(msg, 'sessionId');
    const peerHandle = need(msg, 'peerHandle');
    if (!store(host).unblock(sessionId, peerHandle)) throw new Error(`peer-messaging: ${peerHandle} is not blocked on that session.`);
    report(host, { kind: 'unblocked', sessionId, peerHandle });
    host.rebuild();
  },
};

export const peerRevoke = {
  type: 'peer-revoke',
  handler: (msg, host) => {
    const sessionId = need(msg, 'sessionId');
    const peerHandle = need(msg, 'peerHandle');
    // Clears the standing approval ONLY. Pending and thread survive: revoking
    // consent for what comes next is not the same as denying what is already
    // waiting, and binning it would be a surprise nobody asked for.
    if (!store(host).revoke(sessionId, peerHandle)) throw new Error(`peer-messaging: ${peerHandle} has no standing approval on that session to revoke.`);
    report(host, { kind: 'revoked', sessionId, peerHandle });
    host.rebuild();
  },
};

export const HANDLERS = [peerApprove, peerAllowAll, peerDeny, peerBlock, peerUnblock, peerRevoke];
