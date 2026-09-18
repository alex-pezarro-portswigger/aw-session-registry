// The frame a peer message is wrapped in before it is put in front of an agent.
// This is the ONE place the wrangler gets to tell the agent where this text came
// from, so it says three things a body cannot talk its way out of: that the
// content is UNTRUSTED, which peer and repo asserted it, and that a human
// approved it and when.
//
// "from" is an ASSERTION, not a fact. The relay echoes whatever a sender said
// about itself and verifies none of it (`SendMessageRequest`'s own comment in
// cod-session-registry), so the header names the peer HANDLE and REPO — which
// the recipient's own drain addressed and can therefore vouch for — beside a
// display name it cannot. When the registry's deferred hardening lands
// (server-computed `fromOwnerKey`), nothing here changes except how much the
// approval card can claim.

export const HEADER_PREFIX = '[peer message ·';
export const END_MARKER = '[end peer message]';

// Rewrite BOTH markers in a body, case-insensitively and whitespace-tolerantly,
// so a peer can neither CLOSE the frame and continue as trusted text nor FORGE a
// second header inside its own body.
//
// The replacement is VISIBLE ASCII — round brackets — and not a zero-width
// character or a homoglyph. The relay's `normaliseRunes` already strips
// zero-width and bidi runes on the way through, so an invisible escape would be
// a silent no-op the moment the same trick were applied upstream, and a
// neutralised marker a human can see in the pane is the point.
export function escapeMarkers(body) {
  return String(body ?? '')
    .replace(/\[\s*end\s+peer\s+message\s*\]/gi, '(end peer message)')
    .replace(/\[\s*peer\s+message\s*·/gi, '(peer message ·');
}

// `escapeMarkers` runs BEFORE framing, never after: escaping the assembled
// frame would neutralise our own header.
export function frame({ body, fromDisplay, fromHandle, fromRepo, approvedAt = Date.now() }) {
  // "unattributed" is a first-class value, not a failure: the extension does not
  // assert an owner identity it cannot compute, and the relay accepts a send
  // with no display name at all.
  const who = String(fromDisplay || '').trim() || 'unattributed';
  const handle = String(fromHandle || '').trim() || 'unknown';
  const repo = String(fromRepo || '').trim() || 'unknown repo';
  const when = new Date(approvedAt).toISOString();
  return [
    `${HEADER_PREFIX} untrusted · from ${who} · session ${handle} · repo ${repo} · you approved at ${when}]`,
    escapeMarkers(body),
    END_MARKER,
  ].join('\n');
}
