import { execFile } from 'node:child_process';

// The repo grouping key, "<owner>/<repo>" — which sessions can see each other.
//
// This is a DELIBERATE REIMPLEMENTATION IN JAVASCRIPT of a Go function in
// another repository: `FromOriginURL` + `Normalise` in
// `internal/repokey/repokey.go` of `cod-session-registry`. It is not a
// convenience copy and it is not approximate. The key is a map key on the
// registry AND a path segment in its URLs, and the registry normalises again
// on every request, so a key this file derives differently from the Go one does
// not error anywhere — the drain simply finds nothing, for ever, silently. That
// failure mode is exactly why repokey.go's own header says a keying mismatch
// between populations fails silently.
//
// test/repo-key.test.js therefore runs the SAME case table as
// `internal/repokey/repokey_test.go`. If the Go side changes, that table is
// where it has to be mirrored.
//
// Only the git-origin rule is reproduced. The registry's other two rules are
// not ours to have: `SESSION_REGISTRY_REPO` is a per-process env override for a
// hook, and the checkout-path rule keys off the Anthropic runner's `--base-dir`
// layout, which a local wrangler card never has.

const GIT_TIMEOUT_MS = 2000;

// cwd -> key-or-null. A NEGATIVE result is cached too: a card in a non-git
// scratch dir is the common case and the sweep would otherwise spawn one `git`
// for it on every tick, for the life of the board. A session's origin does not
// change under it, so there is nothing to invalidate.
const cache = new Map();

// `git remote get-url origin` in `cwd`. execFile with an argv ARRAY and never
// `shell: true`: the cwd is wrangler-supplied rather than hostile, but a path
// with a space or a `;` in it must not become two commands, and there is no
// reason for this to be the one place that could.
function defaultGitOrigin(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Mirrors Go `FromOriginURL`. Returns null — never throws — when the URL has no
// owner/repo shape: a session with no resolvable repo simply has no peers, which
// is an ordinary state and not an error to report.
export function fromOriginUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  let p;
  if (s.includes('://')) {
    p = urlPath(s);
    if (p == null) return null;
  } else if (s.startsWith('/') || s.startsWith('.')) {
    // A local-path remote. Treated as a path, exactly as Go does.
    p = s;
  } else {
    // scp-like: [user@]host:path
    const colon = s.indexOf(':');
    if (colon < 0) return null;
    p = s.slice(colon + 1);
  }

  p = trimSlashes(p);
  if (p.endsWith('.git')) p = p.slice(0, -4);
  p = trimSlashes(p);
  if (!p) return null;
  const parts = p.split('/');
  if (parts.length < 2) return null;
  // Refuse any traversal segment, so two URLs differing only by traversal
  // cannot collapse onto one key.
  if (parts.some((x) => x === '.' || x === '..')) return null;
  return normalise(`${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
}

// Mirrors Go `Normalise`: lowercase, trim slashes, strip one trailing `.git`,
// and require exactly two segments each drawn from [a-z0-9._-] and at most 100
// characters. The registry applies this again and never trusts a client to have
// done it, which is what makes a disagreement here silent rather than loud.
export function normalise(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = trimSlashes(s);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  if (!parts.every(validSegment)) return null;
  return `${parts[0]}/${parts[1]}`;
}

// The path component of a `scheme://…` URL, extracted BY HAND rather than with
// `new URL`, and this is not a stylistic choice.
//
// FINDING, caught by the shared case table: `new URL` applies RFC 3986 path
// normalisation, so `https://github.com/../../etc/passwd` has a `pathname` of
// `/etc/passwd`. Go's `url.Parse` does not — its `u.Path` keeps the `..`
// segments, which is what lets `FromOriginURL`'s traversal check REFUSE that
// URL. Using `new URL` here made this side derive `etc/passwd` from a URL the
// registry derives nothing from at all: a valid-looking key neither the sender
// nor the recipient would ever agree on, and silent, because the drain would
// just find nothing for ever.
//
// So: everything after the authority, query and fragment dropped (Go's `u.Path`
// excludes both), then percent-decoded (Go's `u.Path` is the decoded form, so
// `%2e%2e` must become `..` and be refused as traversal). A bad escape or an
// ASCII control character is what `url.Parse` itself errors on, and both are
// null here.
function urlPath(s) {
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  const rest = s.slice(s.indexOf('://') + 3);
  const slash = rest.indexOf('/');
  let p = slash < 0 ? '' : rest.slice(slash);
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

function validSegment(p) {
  if (!p || p === '.' || p === '..' || p.length > 100) return false;
  return /^[a-z0-9._-]+$/.test(p);
}

function trimSlashes(s) {
  return String(s).replace(/^\/+/, '').replace(/\/+$/, '');
}

// The `git remote get-url origin` implementation in force. A module-level seam
// rather than only a per-call option, because the two MCP tools reach
// repoKeyFor through a handler signature the MCP SDK owns
// (`handler({host, caller}, args)`) and have nowhere to thread an option
// through. Named `_…ForTests` so a production caller reads as the mistake it
// would be; the sweep, which CAN thread it, takes `repoKey` as a parameter
// instead.
let gitOriginImpl = defaultGitOrigin;
export function _setGitOriginForTests(fn) {
  gitOriginImpl = typeof fn === 'function' ? fn : defaultGitOrigin;
}

// The cached, async form the hooks, tools and sweep all use. `gitOrigin` is
// injected so the tests need no real git and can count the calls.
export async function repoKeyFor(cwd, { gitOrigin = gitOriginImpl } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  const raw = await gitOrigin(cwd);
  const key = raw == null ? null : fromOriginUrl(raw);
  cache.set(cwd, key);
  return key;
}

// Tests only. There is deliberately no production caller: a card's cwd does not
// change, and a sweep that cleared this would put the per-tick `git` spawn back.
export function _resetRepoKeyCache() {
  cache.clear();
}
