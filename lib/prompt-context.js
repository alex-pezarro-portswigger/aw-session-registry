// A native UserPromptSubmit callback may run before dispatch saves the card.
// Keep its cwd briefly so a fast first-turn update_session_note can resolve
// the repo even before host.sessions.get(cardId) starts returning an entry.
const pending = new Map();
const MAX_AGE_MS = 60_000;

export function rememberPromptCwd(cardId, cwd, now = Date.now()) {
  if (cardId && cwd) pending.set(cardId, { cwd, until: now + MAX_AGE_MS });
}

export function promptCwdFor(cardId, now = Date.now()) {
  const state = pending.get(cardId);
  if (!state) return null;
  if (state.until <= now) { pending.delete(cardId); return null; }
  return state.cwd;
}

export function clearPromptCwd(cardId) {
  pending.delete(cardId);
}
