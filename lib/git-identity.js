import { execFile } from 'node:child_process';

// The card's current branch and the git identity of whoever owns its checkout,
// for the registry row this extension registers (see `postRegister`).
//
// NOTHING HERE IS CACHED, unlike `repo-key.js`. A card's origin never changes
// under it, but its branch does — an agent checks out a new one mid-session —
// and a cached branch would be registered stale for the life of the board. The
// cost of not caching is small because registers are rare: dispatch, resume and
// the sweep's 404 repair only, never the 15s tick.
//
// execFile with an argv ARRAY and never `shell: true`, for the same reason as
// `repo-key.js`: a cwd with a space or a `;` in it must not become two commands.

const GIT_TIMEOUT_MS = 2000;

function git(cwd, args) {
  return new Promise((resolve) => {
    if (typeof cwd !== 'string' || !cwd) { resolve(null); return; }
    execFile('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

// `HEAD` is what a detached checkout answers: not a branch name worth sending.
// null rather than '' so a caller cannot mistake it for a real value.
async function defaultGitBranch(cwd) {
  const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return !out || out === 'HEAD' ? null : out;
}

async function defaultGitIdentity(cwd) {
  const [name, email] = await Promise.all([
    git(cwd, ['config', 'user.name']),
    git(cwd, ['config', 'user.email']),
  ]);
  return { name: name || '', email: email || '' };
}

let branchImpl = defaultGitBranch;
let identityImpl = defaultGitIdentity;

// Never throw: a card whose git misbehaves still gets a row, just a thinner one.
export async function gitBranch(cwd) {
  try { return (await branchImpl(cwd)) || null; } catch { return null; }
}

export async function gitIdentity(cwd) {
  try {
    const r = await identityImpl(cwd);
    return { name: String(r?.name ?? '').trim(), email: String(r?.email ?? '').trim() };
  } catch {
    return { name: '', email: '' };
  }
}

// Test seams, named `_…ForTests` so a production caller reads as the mistake it
// would be. A non-function restores the real implementation.
export function _setGitBranchForTests(fn) {
  branchImpl = typeof fn === 'function' ? fn : defaultGitBranch;
}
export function _setGitIdentityForTests(fn) {
  identityImpl = typeof fn === 'function' ? fn : defaultGitIdentity;
}
