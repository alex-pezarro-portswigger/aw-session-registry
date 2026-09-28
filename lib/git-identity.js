import { execFile } from 'node:child_process';

// The sender's display name for a peer message: the local git `user.name` in
// the card's cwd. It is an UNVERIFIED assertion — the relay echoes it and
// checks nothing — but it is a better "from" than none.
//
// This borrows the execFile/timeout/cache shape of lib/repo-key.js on purpose,
// but lives apart from it: repo-key.js is a line-for-line mirror of
// `internal/repokey/repokey.go` in cod-session-registry, tested against the same
// case table as the Go side, and must not accumulate local-only concerns.

const GIT_TIMEOUT_MS = 2000;

// Same 100-character bound repo-key.js applies to a key segment. A longer name
// is TRUNCATED rather than dropped: a long-but-real name is still better
// attribution than "unattributed".
export const MAX_NAME_CHARS = 100;

// cwd -> name-or-null. A NEGATIVE result is cached too: a cwd with no
// `user.name` would otherwise re-spawn `git` on every send. A name changed under
// a running board sticks until restart — the same tradeoff repo-key.js takes.
const cache = new Map();

// `git config user.name` in `cwd`. execFile with an argv ARRAY and never
// `shell: true`: a cwd with a space or a `;` in it must not become two commands.
function defaultGitName(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['config', 'user.name'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Module-level seam for the same reason as repo-key.js's: the MCP handler
// signature (`handler({host, caller}, args)`) has nowhere to thread an option.
let gitNameImpl = defaultGitName;
export function _setGitNameForTests(fn) {
  gitNameImpl = typeof fn === 'function' ? fn : defaultGitName;
}

// Whitespace (newlines included) collapses to single spaces: the name goes on
// the frame's one-line header, and a multi-line name would break it outright.
function clean(raw) {
  if (raw == null) return null;
  const name = [...String(raw).replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME_CHARS).join('').trim();
  return name || null;
}

export async function gitNameFor(cwd, { gitName = gitNameImpl } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  let name = null;
  try { name = clean(await gitName(cwd)); } catch { name = null; }
  cache.set(cwd, name);
  return name;
}

// Tests only: there is deliberately no production caller.
export function _resetGitNameCache() {
  cache.clear();
}
