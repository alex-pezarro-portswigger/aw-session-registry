import { repoKeyFor } from './repo-key.js';
import { postCloseOut, postNote, registryUrlFor } from './registry.js';
import { gitBranch } from './git-facts.js';
import { cardDetail, cardIntent, registerCard } from './card-facts.js';
import { clearPromptCwd, rememberPromptCwd } from './prompt-context.js';

// The session hooks. Two register this card's registry row and publish its
// messaging handle onto it;
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

// Register the card's row, then note the handle onto it. Two calls because
// `RegisterRequest` has no `messagingHandle`; register first so the note lands
// on a real row rather than 404ing.
//
// AT MOST ONE LOG LINE per run: this is per dispatch and per resume, and the
// sweep is what actually fixes a failure.
async function registerThenNote({ base, sessionId, entry, repo, host, intent, detail }) {
  // A fast first-turn update_session_note may land before onDispatch finishes.
  // Never let the board's launch description overwrite that agent-authored note.
  if (host.stores.peerMessages.isIntentNoted(sessionId)) { intent = ''; detail = ''; }
  const reg = await registerCard(base, sessionId, { repo, entry, intent, detail });
  // Even on a register failure, still attempt the note: a row may already exist
  // (from the plugin hook, or an earlier register), and the note is the thing
  // that makes the card addressable.
  //
  // `messagingHandle` is the CARD ID — a crypto.randomUUID(), 36 characters of
  // hex and hyphens, which passes the registry's `sanitize.MessagingHandle`
  // ([A-Za-z0-9._-], ≤128) unchanged. It is the only stable handle the wrangler
  // owns and the only thing `host.deliver` can address, which is why it is the
  // address a peer sends to.
  const res = await postNote(base, sessionId, { repo, messagingHandle: sessionId });
  if (!res.ok && !res.notFound) {
    host.log(`could not publish ${sessionId} to the registry (${res.error}) — the sweep will retry`);
    return;
  }
  // A 404 on the note (the register did not land either, or raced) is silent:
  // the sweep's re-assert sees the same 404 and repairs it by re-registering.
  if (!reg.ok && !reg.notFound) host.log(`could not register ${sessionId} with the registry (${reg.error}) — the sweep will retry`);
}

// Fire and forget. Returns nothing ON PURPOSE (see above): do not `return` this.
function publish({ sessionId, entry, host, intent, detail }) {
  const base = registryUrlFor(host);
  if (!base || !sessionId) return;
  (async () => {
    const repo = await repoKeyFor(entry?.cwd);
    // A card in a non-git cwd (a scratch dir, most commonly) has no repo key
    // and therefore no peers. Not an error: nothing to publish, nobody to
    // publish it to.
    if (!repo) return;
    await registerThenNote({ base, sessionId, entry, repo, host, intent, detail });
  })().catch(() => {});
}

// A dispatch is the one moment the wrangler knows the card's intent first-hand,
// so it is the one register that sends it.
export function onBeforeDispatch({ sessionId, cwd }) {
  // The native prompt hook and first MCP tool can run before the card is saved.
  rememberPromptCwd(sessionId, cwd);
}

export function onDispatch({ sessionId, entry, host }) {
  clearPromptCwd(sessionId);
  publish({ sessionId, entry, host, intent: cardIntent(entry), detail: cardDetail(entry) });
}

// Resume sends NO intent and NO detail, and that is the whole point of it being
// separate. `Store.Register` merges per field, so omitting them preserves
// whatever the agent (or its own hook) has written since dispatch, while the
// register still refreshes `branch`, resets `StartedAt` and clears
// `FinishedAt` — correctly un-finishing a row a previous archive closed out.
export function onResume({ sessionId, entry, host }) {
  publish({ sessionId, entry, host, intent: '', detail: '' });
}

// The other half of publication: take the handle back.
//
// FOUND IN VERIFICATION. Without this, archiving a card left its handle on the
// registry and peers kept being offered it by `list_peer_sessions` — a send to
// it is accepted by the relay, drained by the recipient board, and then refused
// by `host.deliver` (which will not resurrect a card that left the board on
// purpose), so the message sits pending on a card nobody is looking at. The
// sender is told nothing, because there are no receipts.
//
// A NON-NIL EMPTY STRING is what clears a stored handle — `MessagingHandle` is
// a `*string` on the Go side, where nil leaves it alone. So this is the one
// place that deliberately sends an empty value, and it is the whole mechanism.
//
// The row is also CLOSED OUT. This extension now registers the row (see
// `registerThenNote`), so it owns the row's end too — and a set `finishedAt` is
// what lets the registry's `pruneLocked` evict it under the per-repo cap. An
// unfinished row would otherwise sit for the full retain bound and could
// starve real rows out.
//
// Fire and forget, for the same reason `publish` is: `onArchive` is awaited by
// the core, and archiving should not wait on a network round trip. A dropped
// unpublish is self-healing in the other direction too — the sweep's re-assert
// only republishes LIVE cards, so it never puts a cleared handle back.
function unpublish({ sessionId, entry, host }) {
  const base = registryUrlFor(host);
  if (!base || !sessionId) return;
  (async () => {
    const repo = await repoKeyFor(entry?.cwd);
    if (!repo) return;
    const branch = await gitBranch(entry?.cwd);
    const closed = await postCloseOut(base, sessionId, { repo, branch: branch || '' });
    const res = await postNote(base, sessionId, { repo, messagingHandle: '' });
    // A 404 on either means no entry: nothing to close, no handle to clear and
    // nothing for a peer to be offered — the end state this wanted. Silent.
    if (!res.ok && !res.notFound) host.log(`could not clear ${sessionId}'s handle on the registry (${res.error}) — peers may still be offered it until its entry is reaped`);
    else if (!closed.ok && !closed.notFound) host.log(`could not close out ${sessionId} on the registry (${closed.error})`);
  })().catch(() => {});
}

// Archived: unapproved text must not outlive the session it was addressed to,
// and a standing "allow all from this session" approval must not survive into a
// resume nobody re-consented for. Synchronous store mutation, so there is
// nothing to await and nothing for the core to wait on.
//
// The registry row is closed out and its handle cleared (see `unpublish`): this
// extension registered the row, so it ends it too.
export function onArchive({ sessionId, entry, host }) {
  unpublish({ sessionId, entry, host });
  if (host?.stores?.peerMessages?.closeSession(sessionId)) host.rebuild();
}

// Purged: the card is gone for good, so everything for it goes. A card id never
// recurs, so no future session could inherit a leftover approval — which is
// also why a PEER session ending needs no hook at all.
// No unpublish here, and that is not an omission: `onPurge`'s payload is
// `{sessionId}` alone — no `entry`, so no cwd, so no repo key to address the
// note endpoint with. A purge always follows an archive, and onArchive has
// already cleared the handle.
export function onPurge({ sessionId, host }) {
  clearPromptCwd(sessionId);
  if (host?.stores?.peerMessages?.forgetSession(sessionId)) host.rebuild();
}
