// The last cross-repo directory fetch, held for the graph.
//
// MODULE STATE, for the same reason `sweep.js`'s transition flags are: a
// sweep's `run` is called fresh every tick and has nowhere else to remember
// anything. The graph reads it — rather than fetching for itself — because the
// graph tick may not fetch, log or throw (see lib/graph.js).
//
// The sweep is the ONLY writer and the graph is the only reader. Nothing in
// here does I/O, touches the host or logs.

// The nine fields the board carries per entry. Exported so `graph.js`'s
// projection and this module's change detection can never drift apart: a
// change to a field the graph does not carry must not cost a rebuild, and a
// change to one it does must always cost one.
export const DIRECTORY_FIELDS = [
  'sessionId', 'origin', 'intent', 'detail', 'branch',
  'startedAt', 'finishedAt', 'messagingHandle', 'owner',
];

let repos = {};       // repoKey -> the registry's ledger entries
let fetchedAt = null; // ms epoch of the last SUCCESSFUL fetch; null = never
let error = null;     // the last failure text, or null when the last fetch worked

export function _resetDirectory() {
  repos = {};
  fetchedAt = null;
  error = null;
}

// Record the outcome of one `listAllSessions`. Returns whether anything a
// human would see has CHANGED — which is what the sweep turns into a
// `host.rebuild()`, so a fetch that returns identical rows must answer false
// or the 15s sweep becomes a second board cadence doing no work.
export function noteDirectory(result, now = Date.now()) {
  if (!result || !result.ok) {
    const why = (result && result.error) || 'the session registry could not be read';
    const changed = error !== why;
    error = why;
    // The last good snapshot is KEPT: a blip should leave the view showing
    // what it last knew, with its honest "as of", not blank it.
    return changed;
  }
  const next = normalise(result.repos);
  // `fetchedAt` advances on every success even when nothing moved, so the
  // view's "as of" is honest. It is deliberately not part of `changed`.
  const changed = !sameDirectory(repos, next) || error !== null;
  repos = next;
  fetchedAt = now;
  error = null;
  return changed;
}

export function directorySnapshot() {
  return { repos, fetchedAt, error };
}

function normalise(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Array.isArray(value) ? value.filter((e) => e && typeof e === 'object') : [];
  }
  return out;
}

// Same repo keys, same count per repo, same projected fields per entry.
//
// Compared through a stable per-entry key STRING rather than a
// `JSON.stringify` of the whole map: stringify preserves whatever key order
// the server happened to marshal, so a Go map re-ordering its fields would
// read as a change and rebuild the board for nothing.
export function sameDirectory(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  for (const key of ka) {
    const ea = a[key];
    const eb = b[key];
    if (ea.length !== eb.length) return false;
    for (let i = 0; i < ea.length; i++) {
      if (entryKey(ea[i]) !== entryKey(eb[i])) return false;
    }
  }
  return true;
}

function entryKey(entry) {
  // A length prefix per field, so two fields cannot conspire to produce the
  // same joined string as two different ones.
  return DIRECTORY_FIELDS
    .map((f) => {
      const v = entry == null ? null : entry[f];
      const s = v == null ? '' : String(v);
      return `${s.length}:${s}`;
    })
    .join('\u0000');
}
