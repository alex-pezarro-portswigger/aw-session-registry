import { repoKeyFor } from './repo-key.js';
import { postNote } from './registry.js';

// The session hooks. Two publish this card's messaging handle to the registry;
// two take the card's local state back when it leaves the board.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ FOOTGUN: THE CORE AWAITS THESE HOOKS.                                   │
// └─────────────────────────────────────────────────────────────────────────┘
// `SessionManager._fireExtHooks` does `await fn(payload)` for each hook in
// turn; `onDispatch` is awaited inside `dispatch()` before `refreshAlive`, and
// `onResume` inside `_doResume`. A 5-second `AbortSignal.timeout` on a note
// POST would therefore add up to FIVE SECONDS to every dispatch and every
// resume on the board — for every session, whether or not it has a peer, and
// worst of all exactly when the registry is down.
//
// So these hooks MUST NOT RETURN THEIR PROMISE. They start the POST, attach a
// `.catch`, and return `undefined` synchronously. `publish` below is the only
// place that is allowed to look like a mistake, and it is commented as such so
// a future `return publish(...)` reads as the regression it would be.
//
// What makes that safe rather than lossy is step 8 of the postmaster sweep: it
// re-asserts every live card's publication on its own cadence, idempotently. A
// note POST dropped here — a timeout, a restart mid-flight, the registry being
// down at 09:00 — is picked up within one sweep. The hooks are the fast path,
// not the guarantee.

// Fire and forget. Returns nothing ON PURPOSE (see above): do not `return` this.
function publish({ sessionId, entry, host }) {
  const base = host?.settings?.get('registryUrl');
  // Unset registry URL means the whole extension is inert. No log line here —
  // dispatch and resume are frequent, and the sweep says it once per process.
  if (!base || !sessionId) return;
  const cwd = entry?.cwd;
  (async () => {
    const repo = await repoKeyFor(cwd);
    // A card in a non-git cwd (a scratch dir, most commonly) has no repo key
    // and therefore no peers. Not an error: nothing to publish, nobody to
    // publish it to.
    if (!repo) return;
    // `messagingHandle` is the CARD ID — a crypto.randomUUID(), 36 characters
    // of hex and hyphens, which passes the registry's `sanitize.MessagingHandle`
    // ([A-Za-z0-9._-], ≤128) unchanged. It is the only stable handle the
    // wrangler owns and the only thing `host.deliver` can address, which is why
    // it is the address a peer sends to.
    const res = await postNote(base, sessionId, { repo, messagingHandle: sessionId, origin: 'local' });
    // Reported at DEBUG volume only, and only on failure: this runs per
    // dispatch and per resume, and the sweep is what actually fixes it.
    if (!res.ok) host.log(`could not publish ${sessionId} to the registry (${res.error}) — the sweep will retry`);
  })().catch(() => {});
}

export function onDispatch({ sessionId, entry, host }) {
  publish({ sessionId, entry, host });
}

export function onResume({ sessionId, entry, host }) {
  publish({ sessionId, entry, host });
}

// Archived: unapproved text must not outlive the session it was addressed to,
// and a standing "allow all from this session" approval must not survive into a
// resume nobody re-consented for. Synchronous store mutation, so there is
// nothing to await and nothing for the core to wait on.
//
// The registry row is deliberately left alone. Closing it out is the ledger's
// own close-out endpoint and the hooks that own it; this extension publishes a
// handle and does not manage the entry's lifecycle.
export function onArchive({ sessionId, host }) {
  if (host?.stores?.peerMessages?.closeSession(sessionId)) host.rebuild();
}

// Purged: the card is gone for good, so everything for it goes. A card id never
// recurs, so no future session could inherit a leftover approval — which is
// also why a PEER session ending needs no hook at all.
export function onPurge({ sessionId, host }) {
  if (host?.stores?.peerMessages?.forgetSession(sessionId)) host.rebuild();
}
