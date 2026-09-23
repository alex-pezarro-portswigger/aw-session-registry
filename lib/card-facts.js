import { gitBranch, gitIdentity } from './git-identity.js';
import { postRegister } from './registry.js';

// What this extension says about a card when it registers the card's registry
// row. One place, shared by the dispatch/resume hooks and the sweep's 404
// repair, so the two paths cannot drift into describing the same card
// differently.

// The registry accepts only `runner`, `hosted` or `local` (a 400 otherwise).
// `devcontainer` is `local` on purpose: it is a container on the same machine
// as the board, not a remote runtime, and the registry's origin is about where
// the work runs, not how it is isolated.
export function originFor(entry) {
  const rt = entry?.runtime;
  if (rt === 'runner') return 'runner';
  if (rt === 'hosted') return 'hosted';
  return 'local';
}

// A short, single line of wrangler-authoritative facts that also marks the row
// as an Agent Wrangler card. Only the parts the entry actually has; the
// registry caps and sanitises it, but it is kept one line regardless.
export function cardDetail(entry) {
  const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const parts = ['Agent Wrangler card'];
  const cwd = oneLine(entry?.cwd);
  const wt = oneLine(entry?.worktree?.branch);
  const name = oneLine(entry?.name);
  if (cwd) parts.push(`cwd ${cwd}`);
  if (wt) parts.push(`worktree ${wt}`);
  if (name) parts.push(`task ${name}`);
  return parts.join(' · ');
}

// Register the card's row with the facts above plus its live branch and git
// owner. Two git spawns per call, uncached on purpose (see git-identity.js);
// the readers are injectable so the sweep's tests need no real checkout.
export async function registerCard(base, cardId, { repo, entry, intent = '', detail = '', readBranch = gitBranch, readIdentity = gitIdentity } = {}) {
  const [branch, owner] = await Promise.all([readBranch(entry?.cwd), readIdentity(entry?.cwd)]);
  return postRegister(base, cardId, {
    repo, origin: originFor(entry), branch: branch || '', intent, detail,
    ownerName: owner?.name || '', ownerEmail: owner?.email || '',
  });
}

export function cardIntent(entry) {
  return typeof entry?.intent === 'string' ? entry.intent.trim() : '';
}
