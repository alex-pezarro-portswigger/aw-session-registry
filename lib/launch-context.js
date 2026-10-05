import { registryUrlFor } from './registry.js';

// `hooks['session.launchContext']`: hand a Claude card's inbox to the
// `peer-messages` mod (skills/peer-messages), which drains it, shows each
// message above the prompt and delivers it in-session once the person approves.
//
// Claude only, because only Claude Code loads mods. A Codex card gets nothing
// here and keeps the card flow, and the postmaster sweep skips exactly the
// cards this hands over (`inboxOwnedByMod`) so the two never race one queue.
//
// The URL is passed rather than left to the mod because the extension's own
// `registryUrl` setting must win there as it does here; a mod cannot read
// extension settings.
//
// `agent` is always set on a `sessions:read` projection (core defaults it to
// 'claude'), so a card with none is not a real card: it keeps the card flow.
export function inboxOwnedByMod(card) {
  return card?.agent === 'claude';
}

export function launchContext({ agent, host }) {
  if (!inboxOwnedByMod({ agent })) return {};
  return { env: { PEER_MESSAGES_INBOX: 'mod', PEER_MESSAGES_URL: registryUrlFor(host) } };
}
