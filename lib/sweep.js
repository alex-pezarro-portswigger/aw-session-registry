import { repoKeyFor } from './repo-key.js';
import { ack, drain, listAllSessions, postNote } from './registry.js';
import { _resetDirectory, noteDirectory } from './directory.js';
import { frame } from './framing.js';
import { noteRegistryUp } from './graph.js';

// The `postmaster` sweep: the only thing in this extension that pulls.
//
// One tick, in order: drain → persist → ack → auto-deliver → re-assert (on its
// own slow clock) → directory. The directory fetch is last and is the only
// step that runs on a board with no repo-resolvable cards, because the session
// registry view is cross-repo: an empty board still wants to see it.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ THE SWEEP LOG RULE: no per-tick lines, ever.                            │
// └─────────────────────────────────────────────────────────────────────────┘
// This runs every 15 seconds for the life of the board, so "one line when
// something is wrong" becomes 5,760 lines a day if the wrong thing is a state
// rather than an event. The two states this hits are "no registry URL" and
// "the registry is unreachable", and both get exactly one line on a
// TRANSITION, held in the module-level flags below.
//
// Those flags are module-level rather than per-call because a sweep's `run` is
// called fresh every tick and has nowhere else to remember anything. They are
// per PROCESS, which is the right scope: a restart re-saying "no registry URL
// set" once is useful, not noise.
let notedInert = false;
let lastUp = null; // null = nothing tried yet, so the first result is not a "transition"
// `null` means "never yet", deliberately not 0: `now - 0` happens to be huge
// for a real clock, so 0 would work in production and silently skip the FIRST
// tick under an injected clock — a difference between the tested and the shipped
// behaviour, which is the worst kind.
let lastDrainAt = null;
let lastPublishAt = null;

// The handle re-assert (step 8) runs on its OWN, much slower clock than the
// drain, because it is one POST PER LIVE CARD and the drain is one request per
// repo. Putting it on the 15s tick would reintroduce exactly the N-requests-
// per-sweep trickle that the batched drain exists to remove — and against the
// note endpoint, which is a write.
//
// It can afford to be slow because it is a SAFETY NET, not the mechanism: the
// dispatch/resume hooks publish immediately, and this only has to catch a POST
// they dropped or a registry that was restarted and lost its ledger. Five
// minutes is well inside the registry's 6-hour unacked TTL, so nothing expires
// waiting for it.
export const REPUBLISH_MS = 5 * 60 * 1000;

// `everyMs` is fixed at manifest-validation time — `activateExtension` builds
// the `setInterval` from it — so a setting CANNOT move the timer. `pollSeconds`
// is therefore enforced in here: the sweep fires every 15s regardless and
// returns immediately unless `pollSeconds` have elapsed since the last real
// drain. 15s is the FLOOR and the GRANULARITY, which is why the setting's help
// says so: "I set it to 60 and it still ran every 15 seconds" is otherwise a
// bug report, and "I set it to 5 and nothing got faster" is another.
export const SWEEP_MS = 15000;

export function _resetSweepState() {
  _resetDirectory();
  notedInert = false;
  lastUp = null;
  lastDrainAt = null;
  lastPublishAt = null;
}

// Report a registry up/down TRANSITION and nothing else. Down→down is silent.
function noteReachability(host, up, why) {
  // The graph carries it on every tick whether or not this is a transition —
  // a board that reloads mid-outage must still be told, and the contributor
  // cannot find out for itself without a network call on the ~4s tick.
  noteRegistryUp(up);
  if (lastUp === up) return;
  const first = lastUp === null;
  lastUp = up;
  if (up) {
    if (!first) host.log('the session registry is reachable again');
    // FOUND IN VERIFICATION. The registry's ledger is in memory by default, so
    // a restart empties it — and with the re-assert on its own 5-minute clock,
    // every card stayed unfindable for up to five minutes afterwards even
    // though the sweep knew the service was back. Coming back up is exactly the
    // moment republication is needed, so it is the trigger: clearing the stamp
    // makes the NEXT tick republish, one sweep later rather than five minutes.
    //
    // Only on the transition, never on a steady up: republishing per tick is
    // the one POST-per-live-card trickle REPUBLISH_MS exists to avoid.
    if (!first) lastPublishAt = null;
    return;
  }
  host.log(`the session registry is unreachable (${why}) — nothing is lost, the drain is non-destructive and will retry`);
}

export async function postmaster({ host, now = Date.now(), repoKey = repoKeyFor } = {}) {
  const base = host.settings.get('registryUrl');
  if (!base) {
    // ONE line, once per process. An extension that is installed and switched
    // on but has nothing to talk to is doing nothing, and a human who turned it
    // on deserves to be told that once — not every 15 seconds.
    if (!notedInert) {
      notedInert = true;
      host.log('peer-messaging is installed but has no registry URL set; it is doing nothing. Set one on its settings row in the Extensions tab.');
    }
    return;
  }
  notedInert = false;

  // `pollSeconds` unset (or ≤ the floor) means every sweep.
  const pollSeconds = Number(host.settings.get('pollSeconds'));
  const gapMs = Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds * 1000 : 0;
  if (gapMs > SWEEP_MS && lastDrainAt != null && now - lastDrainAt < gapMs) return;
  lastDrainAt = now;

  const s = host.stores.peerMessages;

  // `sessions.list()` is already active/non-archived (`activeEntries` filters
  // `archivedAt`), but the projection carries `archived` and filtering again
  // costs nothing — a message delivered into an archived card would resurrect
  // something that left the board on purpose.
  const sessions = host.sessions.list().filter((x) => x && !x.archived);

  // Group card ids by repo key, so one repo is one drain. The key comes from
  // each card's cwd and is cached per cwd, so this is not a `git` spawn per
  // card per tick.
  const byRepo = new Map();
  for (const sess of sessions) {
    const repo = await repoKey(sess.cwd);
    if (!repo) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(sess.sessionId);
  }
  let changed = false;
  let reachable = true;
  let lastWhy = '';
  // Decided ONCE for the whole sweep rather than per repo, so the stamp cannot
  // drift between repos and starve the last one of its re-assert. Only when
  // there is something to publish: a board with no repo-resolvable cards must
  // not burn the stamp and leave the first real card unpublished for five
  // minutes.
  const republish = byRepo.size > 0 && (lastPublishAt == null || now - lastPublishAt >= REPUBLISH_MS);
  if (republish) lastPublishAt = now;

  // The drain loop is SKIPPED on a board with no repo-resolvable cards rather
  // than returned from: the directory fetch below is cross-repo and does not
  // depend on this board having a repo of its own.
  for (const [repo, cardIds] of byRepo) {
    const res = await drain(base, repo, cardIds);
    if (!res.ok) { reachable = false; lastWhy = res.error; continue; }

    // Every envelope carries `toHandle`, which IS the recipient card id, so the
    // batched drain demultiplexes with nothing extra on the wire. An envelope
    // addressed to a handle we did not ask for is ignored rather than trusted —
    // it would mean the relay answered a question we did not put.
    const mine = new Set(cardIds);
    const acks = [];
    const delivered = [];
    for (const env of res.messages) {
      const cardId = typeof env?.toHandle === 'string' ? env.toHandle : '';
      if (!mine.has(cardId)) continue;
      const outcome = s.receive(cardId, env);
      // PERSIST, THEN ACK. `receive` has already persisted (persistence is a
      // side effect of mutation), so collecting the ack here and sending it
      // below is the whole of the at-least-once contract: a crash between the
      // two re-delivers, and the `seen` ring makes that a no-op.
      //
      // Every outcome is acked, including 'full', 'blocked' and 'invalid' —
      // each is settled, and an unacked message is re-drained on every sweep
      // until the relay's 6-hour TTL clears it.
      acks.push({ id: env.id, toHandle: cardId });
      if (outcome === 'stored') {
        changed = true;
        // THE FIREBREAK, and the only gate on it. A message reaches an agent
        // without a human click if and only if that human has already approved
        // this exact (card, peer) pair. Everything else waits on the card.
        if (s.isAutoAllowed(cardId, env.fromHandle)) delivered.push({ cardId, env });
      } else if (outcome === 'blocked' || outcome === 'full') {
        changed = true;
      }
    }

    if (acks.length) {
      const acked = await ack(base, repo, acks);
      if (!acked.ok) { reachable = false; lastWhy = acked.error; }
    }

    // Auto-deliver the pre-approved pairs, after the ack rather than before:
    // the ack is about what we have STORED, and a delivery that throws must not
    // leave a stored message unacked and therefore re-drained for ever.
    for (const { cardId, env } of delivered) {
      const at = Date.now();
      const text = frame({
        body: env.body,
        fromDisplay: env.fromDisplay,
        fromHandle: env.fromHandle,
        fromRepo: env.fromRepo,
        approvedAt: at,
      });
      const result = await host.deliver(cardId, text);
      s.approve(cardId, env.id, { at, mode: result?.mode ?? null });
      // Told to the browser half live as well as left on the graph, so a human
      // watching the board sees that something arrived without being asked.
      host.broadcast({ kind: 'auto-delivered', sessionId: cardId, messageId: env.id, mode: result?.mode ?? null });
    }

    // Step 8: re-assert every live card's publication, idempotently. THIS is
    // what makes the fire-and-forget hooks in lib/hooks.js safe — a note POST
    // they dropped (a timeout, a restart mid-flight, the registry down at the
    // moment of dispatch) is picked up here. It is also what republishes
    // everything after the registry has been restarted and lost its in-memory
    // ledger. On REPUBLISH_MS, not the drain tick — see there.
    if (!republish) continue;
    for (const cardId of cardIds) {
      const res2 = await postNote(base, cardId, { repo, messagingHandle: cardId, origin: 'local' });
      if (!res2.ok) { reachable = false; lastWhy = res2.error; }
    }
  }

  // The cross-repo directory, for the Session registry view. ONE GET per real
  // drain tick, and it sits after the `lastDrainAt` check above, so
  // `pollSeconds` coarsens it exactly as it coarsens everything else.
  //
  // No log line of its own: a directory failure IS "the registry is
  // unreachable", which noteReachability already says once per transition.
  const dir = await listAllSessions(base);
  if (!dir.ok) { reachable = false; lastWhy = dir.error; }
  if (noteDirectory(dir, now)) changed = true;

  noteReachability(host, reachable, lastWhy);

  // A rebuild ONLY if something moved. The board's own graph runs at ~4s; a
  // rebuild every 15s for nothing would be a second cadence doing no work.
  if (changed) host.rebuild();
}

// Exported for the manifest, so the floor and the sweep id live beside the code
// that enforces them rather than being repeated in index.js.
export const POSTMASTER_SWEEP = { id: 'postmaster', everyMs: SWEEP_MS, run: postmaster };
