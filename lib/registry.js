// The HTTP client for the session registry (`cod-session-registry`). One
// module, one timeout, one shape of answer.
//
// EVERY function returns `{ok: true, …}` or `{ok: false, error}` and NEVER
// throws. That is not defensive style, it is the sweep log rule: the sweep runs
// every 15s and a throw out of it would be logged on every tick for as long as
// the registry is unreachable, which is exactly the per-tick noise the wrangler
// forbids. Callers decide what is worth saying and when.
//
// `baseUrl` is passed in by the caller, which reads it from
// `host.settings.get('registryUrl')` at CALL time — read-through, so an edit in
// the Extensions tab lands with no restart. Unset means the whole extension is
// inert, which is why `undefined` has to stay distinguishable from a value (the
// settings API has no def-level default, deliberately).
//
// The registry has NO AUTHENTICATION — its only gate is an ingress CIDR
// allowlist — so there is no credential here to protect and `registryUrl` is
// not a secret. Anything this extension publishes is readable by anything that
// can reach the service.

const TIMEOUT_MS = 5000;

// Registry-side caps this client must respect rather than discover: the batched
// drain refuses more than 100 handles and the batched ack more than 500 ids
// (both 400). Chunked here so a board with more live sessions than that works
// rather than failing every sweep.
export const MAX_HANDLES_PER_DRAIN = 100;
export const MAX_IDS_PER_ACK = 500;

// TEMPORARY BRIDGE, to be deleted when the batched endpoints ship.
//
// The batched drain/ack (`handles=`, `{repo, ids}`) is deliverable C of the
// peer-messaging plan and is being built in `cod-session-registry` separately.
// The per-handle forms (`handle=`, `{repo, handle, ids}`) exist on that repo's
// main today and are kept by C for curl and its own tests, so they are a
// legitimate fallback — just an N-requests-per-sweep one, which is the whole
// reason C exists.
//
// `AW_PEER_MESSAGING_PER_HANDLE=1` selects it without editing installed code,
// which matters because an installed extension lives in `<DATA_DIR>` and
// editing it there would be a change no `git` knows about. Once C has shipped,
// this flag, `setPerHandleFallback` and every `perHandle` branch below go.
let perHandle = process.env.AW_PEER_MESSAGING_PER_HANDLE === '1';
export function setPerHandleFallback(on) { perHandle = Boolean(on); }
export function usingPerHandleFallback() { return perHandle; }

// A bad base URL is the human's typo, reported once by the caller rather than
// thrown from here. Nothing but http(s) — a `file:` or a bare path is not a
// registry, and `fetch` would do something surprising with it.
function url(base, pathAndQuery) {
  let u;
  try {
    u = new URL(String(base ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // A base with a path (`https://host/registry`) keeps it; a trailing slash is
  // dropped so the join never doubles one.
  const root = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return `${root}${pathAndQuery}`;
}

// One request, one place the timeout lives, one place a non-2xx becomes an
// `{ok:false}`. `AbortSignal.timeout` rather than a manual controller: the
// wrangler is a long-lived process and a leaked timer per sweep per session
// would be a slow leak nobody would attribute to this.
async function request(target, { method = 'GET', body = null } = {}) {
  if (!target) return { ok: false, error: 'registryUrl is not a valid http(s) URL' };
  let res;
  try {
    res = await fetch(target, {
      method,
      // `requireJSON` on the server is a CSRF-shape check, so every POST must
      // carry this or it is a 415 before the body is read.
      headers: body == null ? {} : { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout, a DNS failure, a refused connection — indistinguishable to a
    // caller that can only retry, and all of them "the registry is down".
    return { ok: false, error: `${method} ${target}: ${err?.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : String(err?.message || err)}` };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    // The registry's error shape is `{"error": "..."}`; fall back to the status
    // for anything that is not one (a proxy's HTML 502, say).
    const why = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`;
    // `notFound` is surfaced as its own flag rather than left to callers to
    // spell `status === 404`, because for `postNote` it is not a failure at all
    // but the ordinary answer for a card the registry has never heard of — see
    // there. Keeping the HTTP detail in this module is the same rule as every
    // other shape decision here: callers get an answer, not a status code.
    return { ok: false, error: `${method} ${target}: ${why}`, status: res.status, notFound: res.status === 404 };
  }
  return { ok: true, payload: payload ?? {} };
}

// Publish (or re-assert) this card's messaging handle, ON AN ENTRY THAT ALREADY
// EXISTS. Two keys and no more.
//
// `intent` and `detail` are OMITTED ENTIRELY, never sent empty: they are
// `*string` on the Go side, so a nil pointer leaves the stored value alone
// while an empty string would CLEAR it. Those two fields are agent-authored —
// an agent's own hook may have written them — and the wrangler has no business
// clobbering them on every sweep. `decode` also rejects unknown fields, so this
// body is exactly the two keys this extension has any business sending.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ `origin` IS OMITTED ON PURPOSE. Sending it CREATES LEDGER ENTRIES.      │
// └─────────────────────────────────────────────────────────────────────────┘
// The note endpoint upserts: `ledger.Store.Note` creates the entry when it does
// not exist and `createOrigin` is non-empty, and `serve.handleNote` consults
// `origin` for nothing else. Since this extension notes EVERY LIVE CARD in a git
// repo — on dispatch, on resume, and again every REPUBLISH_MS from the sweep —
// an `origin` here minted a ledger row for every card that had never registered
// with the registry at all. `NoteRequest` carries no branch and, deliberately,
// no owner fields, and we omit intent and detail, so each one was a PERMANENT
// SHELL: empty intent, empty detail, empty branch, no attribution. That is what
// filled the registry's own views with blank rows.
//
// It was worse than cosmetic. A shell never gets a close-out (that is the
// registry's own hook-driven endpoint, not ours), so it sits `finishedAt: null`
// for up to the local reap bound — and `pruneLocked` only ever evicts FINISHED
// entries against the per-repo cap, so shells could starve real, attributed
// entries out of the ledger.
//
// With `origin` omitted the create path is closed and a card the registry has
// never heard of gets a 404 — reported as `notFound`, which callers treat as the
// ordinary answer rather than an outage. The cost is accepted knowingly: the
// create path exists for a reason (a hook that is not installed, a ledger
// emptied by a deploy, a hosted session racing its own brief script), so a
// session whose entry was lost stops being addressable until it re-registers.
// This extension publishes HOW TO REACH a session; asserting that one EXISTS is
// the register/brief hooks' job, and doing it here was overreach.
//
// Registering is now this extension's job too — done explicitly, with a real
// origin, branch, owner and intent, through `postRegister` below. That is why
// `postNote` staying create-free is still correct: the row is made on purpose,
// never as a side effect of re-asserting a handle.
export async function postNote(base, cardId, { repo, messagingHandle } = {}) {
  if (!cardId) return { ok: false, error: 'postNote: cardId is required' };
  if (!repo) return { ok: false, error: 'postNote: repo is required' };
  const target = url(base, `/v1/sessions/${encodeURIComponent(cardId)}/note`);
  return request(target, { method: 'POST', body: { repo, messagingHandle } });
}

// Register (or re-register) this card's ledger row: `POST /v1/sessions`.
//
// Only the NON-EMPTY optionals are sent. That is not cosmetic: `Store.Register`
// merges per field and treats empty as "keep the previous value", so omitting
// states exactly what this call asserts — which matters on resume, where intent
// and detail are left out so the agent's own text survives.
//
// `RegisterRequest` has no `messagingHandle`, which is why register + note is
// always two calls. `Register` preserves an existing handle, so the order of the
// two is safe either way.
//
// `ownerEmail` leaves the machine. The registry hashes it at the request
// boundary and never stores it raw, but the service itself is UNAUTHENTICATED
// behind an ingress CIDR allowlist — the same posture as the plugin hook that
// already sends it, and not a protection this client should imply.
export async function postRegister(base, cardId, { repo, origin, branch, intent, detail, ownerName, ownerEmail } = {}) {
  if (!cardId) return { ok: false, error: 'postRegister: cardId is required' };
  if (!repo) return { ok: false, error: 'postRegister: repo is required' };
  if (!origin) return { ok: false, error: 'postRegister: origin is required' };
  const body = { repo, sessionId: cardId, origin };
  for (const [k, v] of Object.entries({ branch, intent, detail, ownerName, ownerEmail })) {
    if (typeof v === 'string' && v) body[k] = v;
  }
  return request(url(base, '/v1/sessions'), { method: 'POST', body });
}

// Close out this card's row, setting `finishedAt` — the only kind of row
// `pruneLocked` can evict under the per-repo cap. A 404 (nothing to close)
// arrives as `notFound` like everywhere else and is an ordinary outcome.
export async function postCloseOut(base, cardId, { repo, branch } = {}) {
  if (!cardId) return { ok: false, error: 'postCloseOut: cardId is required' };
  if (!repo) return { ok: false, error: 'postCloseOut: repo is required' };
  const body = { repo };
  if (typeof branch === 'string' && branch) body.branch = branch;
  return request(url(base, `/v1/sessions/${encodeURIComponent(cardId)}/close-out`), { method: 'POST', body });
}

// Every ledger entry for a repo — live and finished, attributed and not. The
// caller filters; this does not decide what "useful" means.
export async function listSessions(base, repo) {
  if (!repo) return { ok: false, error: 'listSessions: repo is required' };
  // `repo` is `<owner>/<repo>`, and the slash is a real path separator here —
  // the route is `/v1/repos/{owner}/{repo}/sessions`. Both halves are encoded
  // individually so a segment can never smuggle one in; repoKeyFor has already
  // restricted them to [a-z0-9._-], which is what makes that a belt-and-braces
  // check rather than the only one.
  const [owner, name, ...rest] = String(repo).split('/');
  if (!owner || !name || rest.length) return { ok: false, error: `listSessions: repo must be <owner>/<repo> (got ${JSON.stringify(repo)})` };
  const target = url(base, `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/sessions`);
  const res = await request(target);
  if (!res.ok) return res;
  return { ok: true, repo: res.payload.repo ?? repo, sessions: Array.isArray(res.payload.sessions) ? res.payload.sessions : [] };
}

// Every repo's entries inside the registry's own 24-hour window, grouped by
// repo key — the same data its dashboard draws, as JSON. ONE request for the
// whole board, not one per repo: this feeds a cross-repo view, and a per-repo
// loop here would be exactly the N-requests-per-sweep trickle the batched
// drain exists to remove.
//
// The window is the SERVER's (it has no `since` parameter by design), so
// nothing here decides how far back "recent" is.
export async function listAllSessions(base) {
  const res = await request(url(base, '/v1/sessions'));
  if (!res.ok) return res;
  const raw = res.payload.repos;
  const ok = raw && typeof raw === 'object' && !Array.isArray(raw);
  if (!ok) return { ok: true, repos: {} };
  // Each value normalised to an array here rather than trusted downstream: a
  // malformed payload must not reach the graph, which may not throw.
  const repos = {};
  for (const [key, value] of Object.entries(raw)) repos[key] = Array.isArray(value) ? value : [];
  return { ok: true, repos };
}

// Enqueue one message. FIRE AND FORGET: the reply carries the id and timestamp
// the relay assigned and deliberately nothing about delivery, because whether
// the message is ever shown is the recipient board's business and the relay
// cannot promise it. A full recipient queue is still a 200 (the oldest was
// shed), which is also not ours to report on.
export async function send(base, payload) {
  const target = url(base, '/v1/messages');
  const res = await request(target, { method: 'POST', body: payload });
  if (!res.ok) return res;
  return { ok: true, message: res.payload.message ?? null };
}

// Drain every queued message for a set of handles in one repo. NON-DESTRUCTIVE:
// the relay drops a message only on ack, which is what makes delivery
// at-least-once across a crash mid-sweep — see the store's `seen` ring for the
// dedupe that relies on it.
//
// Every envelope carries `toHandle`, so the caller demultiplexes with nothing
// extra on the wire. Partial failure is REPORTED rather than hidden: a chunk
// that failed means messages this sweep did not see, and a caller that acked as
// if it had would be acking ids it never stored.
export async function drain(base, repo, handles) {
  if (!repo) return { ok: false, error: 'drain: repo is required' };
  const list = [...new Set((handles || []).filter((h) => typeof h === 'string' && h))];
  if (!list.length) return { ok: true, messages: [] };

  const messages = [];
  const errors = [];
  if (perHandle) {
    for (const h of list) {
      const target = url(base, `/v1/messages?repo=${encodeURIComponent(repo)}&handle=${encodeURIComponent(h)}`);
      const res = await request(target);
      if (!res.ok) { errors.push(res.error); continue; }
      for (const m of res.payload.messages || []) messages.push(m);
    }
  } else {
    for (const chunk of chunks(list, MAX_HANDLES_PER_DRAIN)) {
      const target = url(base, `/v1/messages?repo=${encodeURIComponent(repo)}&handles=${chunk.map(encodeURIComponent).join(',')}`);
      const res = await request(target);
      if (!res.ok) { errors.push(res.error); continue; }
      for (const m of res.payload.messages || []) messages.push(m);
    }
  }
  if (errors.length && !messages.length) return { ok: false, error: errors[0] };
  return { ok: true, messages, partial: errors.length ? errors : null };
}

// Ack the ids a recipient has PERSISTED. The order — persist, then ack — is the
// whole of the at-least-once contract; acking first turns a crash into lost
// messages with nothing anywhere to recover them from.
//
// `items` is `[{id, toHandle}]` rather than the bare id list the batched
// endpoint takes, because the PER-HANDLE fallback needs the handle to address
// the right queue. When the fallback goes, so does the need for `toHandle` —
// ids are server-generated and globally unique, which is what lets the batched
// form remove them across every target under a repo.
export async function ack(base, repo, items) {
  if (!repo) return { ok: false, error: 'ack: repo is required' };
  const rows = (items || []).filter((x) => x && typeof x.id === 'string' && x.id);
  if (!rows.length) return { ok: true, acked: 0 };

  let acked = 0;
  const errors = [];
  if (perHandle) {
    const byHandle = new Map();
    for (const r of rows) {
      const h = typeof r.toHandle === 'string' ? r.toHandle : '';
      if (!h) { errors.push(`ack: message ${r.id} has no toHandle and the per-handle fallback cannot address it`); continue; }
      if (!byHandle.has(h)) byHandle.set(h, []);
      byHandle.get(h).push(r.id);
    }
    for (const [handle, ids] of byHandle) {
      for (const chunk of chunks([...new Set(ids)], MAX_IDS_PER_ACK)) {
        const res = await request(url(base, '/v1/messages/ack'), { method: 'POST', body: { repo, handle, ids: chunk } });
        if (!res.ok) { errors.push(res.error); continue; }
        acked += Number(res.payload.acked) || 0;
      }
    }
  } else {
    const ids = [...new Set(rows.map((r) => r.id))];
    for (const chunk of chunks(ids, MAX_IDS_PER_ACK)) {
      const res = await request(url(base, '/v1/messages/ack'), { method: 'POST', body: { repo, ids: chunk } });
      if (!res.ok) { errors.push(res.error); continue; }
      acked += Number(res.payload.acked) || 0;
    }
  }
  // A failed ack is not lost data: the drain is non-destructive, so the same
  // messages come back next sweep and the `seen` ring skips them. It is still
  // reported, because an ack failing for ever means a queue that only the
  // relay's 6-hour TTL will clear.
  if (errors.length && !acked) return { ok: false, error: errors[0] };
  return { ok: true, acked, partial: errors.length ? errors : null };
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
