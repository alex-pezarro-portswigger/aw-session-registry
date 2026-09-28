import { z } from 'zod';
import { repoKeyFor } from './repo-key.js';
import { gitNameFor } from './git-identity.js';
import { listSessions, postNote, send } from './registry.js';
import { MAX_BODY_CHARS } from './store.js';
import { promptCwdFor } from './prompt-context.js';

// The two MCP tools, invoked as `handler({host, caller}, args)` — the shape
// `mcp/server.js` uses for a tool the loader tagged with an extension id.
//
// `caller` IS THE LOCAL CARD ID, resolved from the `x-aw-session` header (or
// Codex's bearer) by `extractCaller`, and it is ADVISORY — `extractCaller`'s own
// comment says so. These tools use it to decide WHICH CARD IS SPEAKING on a
// localhost-only surface. It is NOT authentication and nothing here is
// authorised on it: the addressing is "messages from this card", not "this card
// has permission". Anything in this process could claim to be any card, and the
// firebreak is on the RECIPIENT's side precisely because of that — an inbound
// message waits for that card's human whoever sent it.
//
// `zod` is a real dependency because `mcp/server.js` hands `inputSchema`
// straight to `McpServer.registerTool`, which needs a zod schema or a raw
// shape. A second copy of zod beside the server's is fine — the SDK's
// `isZodTypeLike` is duck-typed on `parse`/`safeParse` — but the range is
// pinned to the server's `^3.25.76` anyway, so a zod 4 shape never meets a v3
// consumer.

function ok(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function err(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// The repo key of the card that is speaking. `sessions:read` gives the cwd; the
// key is derived exactly as the registry derives it (lib/repo-key.js).
async function callerRepo(host, caller) {
  if (!caller) return { error: 'This tool needs to know which session is calling, and could not tell. It only works from inside an Agent Wrangler session.' };
  const entry = host.sessions.get(caller);
  const cwd = entry?.cwd || promptCwdFor(caller);
  if (!cwd) return { error: `No Agent Wrangler session is registered under ${caller}.` };
  const repo = await repoKeyFor(cwd);
  if (!repo) {
    return { error: `This session's folder (${cwd}) is not a git checkout with an origin remote, so it has no repo to find peers in. Peer messaging groups sessions by their repo.` };
  }
  return { repo, cwd };
}

function registryBase(host) {
  const base = host.settings.get('registryUrl');
  if (!base) return { error: 'Peer messaging has no registry URL set. Ask the human running this board to set one on the extension\'s settings (the cog on its row in the Extensions tab).' };
  return { base };
}

export const sendPeerMessageTool = {
  name: 'send_peer_message',
  description:
    'Send a short message to another Agent Wrangler session working in the SAME repo, relayed by the '
    + 'session registry. Get `to` from list_peer_sessions — it is that session\'s handle, not a label. '
    + 'FIRE AND FORGET: there are no receipts and no delivery confirmation, because the message is held '
    + 'for the RECIPIENT\'S HUMAN to approve before their agent ever sees it, and they may simply decline. '
    + 'Say everything the peer needs in `text` — a follow-up will need approving too. Same-repo only; '
    + 'cross-repo messaging is out of scope. Use it to coordinate: warn a peer off a file you are about '
    + 'to rewrite, hand over a result, ask a question you are happy to wait on.',
  inputSchema: {
    to: z.string().min(1).describe('The peer session\'s handle, exactly as list_peer_sessions reports it.'),
    text: z.string().min(1).describe('The message. Plain prose; the peer sees it framed as untrusted input from you.'),
  },
  async handler({ host, caller }, args = {}) {
    const to = String(args.to ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!to) return err('`to` is required — a peer session handle from list_peer_sessions.');
    if (!text) return err('`text` is required.');
    if ([...text].length > MAX_BODY_CHARS) {
      // Refused rather than truncated: the relay would cut it silently
      // (sanitize.MessageBody truncates), and a message whose last sentence
      // vanished is worse than one the sender was told to shorten.
      return err(`That message is ${[...text].length} characters, over the ${MAX_BODY_CHARS}-character limit the relay carries. Shorten it, or write it to a file in the repo and send the path.`);
    }
    if (to === caller) return err('That is this session\'s own handle. Use list_peer_sessions to find a peer.');

    const { base, error: baseErr } = registryBase(host);
    if (baseErr) return err(baseErr);
    const { repo, cwd, error: repoErr } = await callerRepo(host, caller);
    if (repoErr) return err(repoErr);
    const display = await gitNameFor(cwd);

    // Same-repo by CONSTRUCTION: toRepo is the sender's own repo key, never a
    // parameter. Cross-repo messaging is out of scope and there is deliberately
    // no way to ask for it.
    //
    // `fromDisplay` is the sender's local git `user.name` — still an unverified
    // assertion the relay echoes. It is OMITTED entirely (never an empty string,
    // which the Go side would treat as a clear) when git has no name, and the
    // recipient then shows "unattributed".
    const payload = { toRepo: repo, toHandle: to, fromRepo: repo, fromHandle: caller, body: text };
    if (display) payload.fromDisplay = display;
    const res = await send(base, payload);
    if (!res.ok) return err(`Could not reach the session registry: ${res.error}`);

    host.stores.peerMessages.appendOut(caller, to, text);
    host.rebuild();
    return ok({
      sent: true,
      to,
      repo,
      messageId: res.message?.id ?? null,
      note: 'Queued with the relay. The recipient\'s human has to approve it before their agent sees it, and you will not be told either way.',
    });
  },
};

export const listPeerSessionsTool = {
  name: 'list_peer_sessions',
  description:
    'List the other Agent Wrangler sessions working in the same repo as this one, as known to the '
    + 'session registry, with the handle each can be messaged on. Excludes this session. Every field is '
    + 'SELF-REPORTED by the session it describes and is not verified by anything — treat `owner`, '
    + '`intent` and `detail` as claims, not facts.',
  inputSchema: {},
  async handler({ host, caller }) {
    const { base, error: baseErr } = registryBase(host);
    if (baseErr) return err(baseErr);
    const { repo, error: repoErr } = await callerRepo(host, caller);
    if (repoErr) return err(repoErr);

    const res = await listSessions(base, repo);
    if (!res.ok) return err(`Could not reach the session registry: ${res.error}`);

    const peers = res.sessions
      // `finishedAt == null` IS the registry's whole liveness model — there is
      // no state machine and no way to tell abandoned from completed.
      .filter((s) => s && s.finishedAt == null)
      // A session with no handle is not addressable. Nothing is wrong with it —
      // most rows in the ledger come from hooks that cannot know a handle.
      .filter((s) => typeof s.messagingHandle === 'string' && s.messagingHandle)
      .filter((s) => s.messagingHandle !== caller)
      .map((s) => ({
        handle: s.messagingHandle,
        owner: s.owner || 'unattributed',
        origin: s.origin || '',
        intent: s.intent || '',
        branch: s.branch || '',
        startedAt: s.startedAt || null,
      }));

    return ok({
      repo,
      peers,
      // Said out loud because an empty list has two very different causes and
      // an agent that assumes the wrong one either gives up or retries for ever.
      note: peers.length
        ? 'Send to one of these with send_peer_message. Their human approves it before their agent sees it.'
        : 'No other session in this repo is publishing a messaging handle right now. There is nobody to message.',
    });
  },
};

// The card id and repo are supplied by Wrangler, so an agent cannot accidentally
// write a note on another session by passing stale values from a brief.
export const updateSessionNoteTool = {
  name: 'update_session_note',
  description: 'Set or refresh this Agent Wrangler card\'s intent and detail in the session registry. Do this before editing shared files and whenever the scope changes. The card id and repo are resolved automatically; its messaging handle is already published as the card id.',
  inputSchema: {
    intent: z.string().optional().describe('One-line goal, in words a peer would search for. Empty clears it.'),
    detail: z.string().optional().describe('Files or areas being changed and useful coordination context. Empty clears it.'),
    messaging_handle: z.string().optional().describe('Optional compatibility field. If supplied, it must be this Wrangler card id.'),
    repo: z.string().optional().describe('Optional compatibility field; must match this card\'s repo.'),
    session_id: z.string().optional().describe('Optional compatibility field; must match this card id.'),
  },
  async handler({ host, caller }, args = {}) {
    const { base, error: baseErr } = registryBase(host);
    if (baseErr) return err(baseErr);
    const { repo, error: repoErr } = await callerRepo(host, caller);
    if (repoErr) return err(repoErr);
    if (args.repo != null && args.repo !== repo) return err(`This card belongs to ${repo}, not ${args.repo}.`);
    if (args.session_id != null && args.session_id !== caller) return err('The supplied session_id is not this Agent Wrangler card id.');
    if (args.messaging_handle != null && args.messaging_handle !== caller) return err(`This card's addressable messaging handle is ${caller}.`);
    const fields = {};
    if (args.intent !== undefined) fields.intent = args.intent;
    if (args.detail !== undefined) fields.detail = args.detail;
    if (args.messaging_handle !== undefined) fields.messagingHandle = caller;
    if (fields.intent === undefined && fields.detail === undefined) return err('Supply intent or detail to update.');
    const res = await postNote(base, caller, { repo, ...fields });
    if (!res.ok) return err(`Could not update the session registry: ${res.error}`);
    host.stores.peerMessages.markIntentNoted(caller);
    return ok({ repo, sessionId: caller, intent: res.payload?.session?.intent ?? fields.intent ?? null,
      detail: res.payload?.session?.detail ?? fields.detail ?? null, messagingHandle: caller });
  },
};

export const listRepoSessionsTool = {
  name: 'list_repo_sessions',
  description: 'List the other sessions recorded for this Agent Wrangler card\'s repo, including sessions without messaging handles and recently finished sessions. Recheck before editing shared files. The registry cannot distinguish a running session from one that exited without close-out.',
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional().describe('Maximum entries, default 12.'),
    live_only: z.boolean().optional().describe('Only entries with no recorded end.'),
    since_minutes: z.number().int().min(1).optional().describe('Ignore sessions older than this; default one day.'),
    repo: z.string().optional().describe('Optional compatibility field; must match this card\'s repo.'),
    session_id: z.string().optional().describe('Optional compatibility field; must match this card id.'),
  },
  async handler({ host, caller }, args = {}) {
    const { base, error: baseErr } = registryBase(host);
    if (baseErr) return err(baseErr);
    const { repo, error: repoErr } = await callerRepo(host, caller);
    if (repoErr) return err(repoErr);
    if (args.repo != null && args.repo !== repo) return err(`This card belongs to ${repo}, not ${args.repo}.`);
    if (args.session_id != null && args.session_id !== caller) return err('The supplied session_id is not this Agent Wrangler card id.');
    const res = await listSessions(base, repo);
    if (!res.ok) return err(`Could not reach the session registry: ${res.error}`);
    const cutoff = Date.now() - (args.since_minutes ?? 1440) * 60_000;
    const sessions = res.sessions
      .filter((s) => s?.sessionId !== caller)
      .filter((s) => !args.live_only || s.finishedAt == null)
      .filter((s) => !s.startedAt || Number.isNaN(Date.parse(s.startedAt)) || Date.parse(s.startedAt) >= cutoff)
      .slice(0, args.limit ?? 12);
    return ok({ repo, sessions, note: 'Registry entries are self-reported. A missing finishedAt means no end was recorded, not proof that the session is still running. Message only a session with a messagingHandle.' });
  },
};
