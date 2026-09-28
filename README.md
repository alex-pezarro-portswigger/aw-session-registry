# aw-session-registry

An Agent Wrangler extension to bring the [session registry](https://github.com/portswigger-apps/cod-session-registry).
into Agent Wrangler.

**Every inbound message waits on its card for you to approve it before the agent
sees it**, unless you have explicitly allowed that one peer for that one card.

---

## Read this before you install it

**An extension runs in-process with full access to this machine.** The
capability list on the consent modal says what this extension *asked the
wrangler for*; nothing stops its code — or `zod`'s, or any of its dependencies'
— from doing more. `npm ci --ignore-scripts` is a mitigation, not a boundary:
it stops install-time lifecycle hooks only, and dependency code runs in-process
on first import. Installing this is as much trust as `npm install`-ing a package
into the wrangler itself. The consent modal's own wording is the canonical
statement of this and nothing here softens it.

**Sender identity is echoed, not verified.** The relay carries whatever a
sending board asserted about itself and checks none of it. The "from" name is
the sender's local git `user.name`, read from its git config, asserted by the
sending board and not verified by anything. The two things the board *can*
vouch for are the handle it drained and the repo it asked about, which is why
the frame the agent sees names both.

**The registry has no authentication.** Its only gate is an ingress CIDR
allowlist. Anything that can reach it can read every handle published there and
send to any of them. The registry URL is not a credential and is not stored as
one.

---

## What it does

- Publishes each live card's **messaging handle** (its card id) to the registry,
  so peers in the same repo can address it.
- Gives an agent four MCP tools: `list_peer_sessions`, `send_peer_message`,
  `list_repo_sessions` and `update_session_note`.
- Adds the registry's peer brief to the first prompt. The first three prompts
  carry a same-prompt reminder until the agent updates its note.
- Drains inbound messages on a 15-second sweep, stores them, and **acks the
  relay only after they are on disk**.
- Puts every unapproved message behind a click on the card: **Allow once ·
  Allow all from this session · Deny · Block**.

### Session registry view

A top-level board view — its own button on the rail — showing **every repo's
sessions from the last 24 hours**, not just this board's. It is the registry's
own dashboard, drawn with the board's theme: the same grouping by repo, the
same live-then-recently-ended split, and the same wording, down to
`no end recorded` rather than "still running" (the registry records a start and
an end and infers nothing between them). Status and repo filters persist across
a reload.

A card whose messaging handle is a session **on this board** is tagged `this
board` and clicking it selects that session and returns to the grid. Everything
else is read-only: there is no button on this view that changes anything,
anywhere.

What it costs: **one `GET /v1/sessions` per drain tick**, under the same
`pollSeconds` gate as everything else the sweep does, and a board rebuild only
when the contents actually changed — an identical fetch redraws nothing. The
graph tick still does no I/O; the sweep writes `lib/directory.js` and the graph
reads it.

### The firebreak, stated precisely

The sweep writes pending inbound to this extension's own store and acks the
registry. It calls `host.deliver` — the only route into an agent's context —
**only** when an explicit prior human approval already exists for that exact
`(card, peer handle)` pair. That is what "Allow all from this session" means,
and nothing else.

Every other inbound message waits for a click. Unapproved text lives in the
store and on the approval card and **never** in agent context: there is no held
or blurred preview of it, no summary of it, and no count-based nudge into the
pane. A denied message leaves no archive anywhere — that is the point.

---

## Install

Through the Extensions tab, by git URL. A lockfile is committed, which the
install flow requires (it refuses a repo without one *before* showing you the
disclosure, because an unpinned dependency set cannot be disclosed honestly).

It arrives **switched off**: it reaches a network host, so it has to be chosen
rather than inherited. Turn it on in the Extensions tab. It uses the same
registry URL as the marketplace plugin by default.

Requires a wrangler serving host API **`^1.12.0`** for declared native hooks.
The extension discloses `UserPromptSubmit` and `PostToolUse` during install.
An older wrangler refuses to load it.
Codex may ask the user to trust Wrangler's generated prompt hook command;
the extension cannot bypass that native review.

### Settings

| Setting | What it does |
|---|---|
| **Session registry URL** | Overrides the marketplace plugin's default registry URL. |
| **How often to check for messages** | Seconds. **15 is the floor and the granularity** — the check is wired to a fixed 15-second timer, so a larger number makes it *less* frequent and anything at or below 15 means every time. |

The 15-second floor is not a soft target: `everyMs` is fixed when the manifest
is validated and `activateExtension` builds the timer from it, so this setting
can only coarsen the cadence, never refine it.

---

## Things it does that you should know about

### "Allow all" can paste into a half-typed draft

`host.deliver` pastes at the composer's cursor, and the mid-prompt hold that
the wrangler's own automated nudges use **is not wired to that seam** —
`server/ext-deliver.js` says so itself, because nothing at that seam can tell an
addressed message from an automated one.

For the human-approved path that is fine: someone has just clicked, so the
delivery genuinely is addressed. For **auto-allow** it is not. A pre-approved
message arriving off the sweep can splice itself into something you are part-way
through typing. That is precisely what opting in buys. It is per-pair, off by
default, and the button says so.

If this turns out to matter, the fix is a core one (a deferral-aware `deliver`
variant), not something this extension can do.

### What it writes to the registry ledger

Each card in a git repo gets one registry row, keyed on its card id, and the
extension owns that row from start to end:

- **Dispatch** registers it (origin, branch, git owner, the card's intent, and a
  one-line detail naming it as an Agent Wrangler card), then notes the card id
  on as its messaging handle. The first prompt also asks the registry for its
  one-shot peer brief before the model request.
- **Resume** re-registers with no intent or detail, so whatever the agent wrote
  survives, while the branch is refreshed and a closed-out row is reopened.
- **Archive** closes the row out and clears the handle.

The note never creates a row. It used to, and every unregistered card became a
permanent blank row that could crowd real ones out of the per-repo cap. Rows are
now only ever made by an explicit register. The owner's email is sent (hashed by
the registry, never stored raw); the registry is unauthenticated behind an
ingress CIDR allowlist, so treat what is written there as visible to anything
that can reach it.

`update_session_note` can replace the dispatch intent and detail when the agent
has a concrete plan; `list_repo_sessions` reads all recent peers, including
those with no messaging handle. Both tools derive the repo and card id from the
calling Wrangler session. The optional `repo` and `session_id` arguments exist
for compatibility with the standalone plugin and are checked against the card.
The messaging handle is always the card id, because that is what this board can
deliver to.

Like the plugin, the extension uses a native `UserPromptSubmit` command hook
to attach the reminder to the prompt being submitted, up to three times.
Its `PostToolUse` hook switches the reminder off after an
`update_session_note` call. The marker records the call even if the tool
reported an error, matching the marketplace plugin. The count and marker live
in the agent's writable data across resumes. Prompts in a folder without a git
origin do not spend a reminder.

The same hook attaches the registry's peer brief to the first prompt, using
the card id and the registry's one-shot gate. `onBeforeDispatch` records the
card's cwd before launch so a first-turn `update_session_note` call can
resolve its repo. If the standalone plugin is installed, its `SessionStart`
hook also runs; duplicate brief context is possible because that hook does not
use the extension's one-shot gate.

On the host, the command hook reads a custom registry URL from Wrangler's
`config.json` under `extensionSettings.peer-messaging.registryUrl`. In a
devcontainer, the host config file is unavailable, so the command uses
`SESSION_REGISTRY_URL` if inherited and otherwise the marketplace default.
Set that environment variable when using a custom URL in a devcontainer.

### One registry row per Wrangler card

The extension publishes a row keyed on the **card** id. That is the
addressable handle `list_peer_sessions` returns.

The marketplace plugin now uses `AW_SESSION_ID` before the conversation id,
so its registration and this extension's handle land on the same card row.
The conversation id is deliberately not available to an extension:
`host-api/project.js` withholds it precisely because it is
`--resume`-able, which would reach a conversation outside the board's lifecycle.

### A wrangler that is off for a day loses messages

Unacked messages expire on the registry after its unacked TTL (6 hours by
default). At a 15-second sweep that is not close — but a wrangler that is simply
*not running* for a day will find those messages gone.

That is intended. Nobody wants day-old peer chatter pasted into a fresh session.

### An archived card stops being addressable

`onArchive` clears the card's **messaging handle** on the registry — a non-nil
empty string, which is what clears a stored value where nil leaves it alone — so
peers stop being offered a card that can no longer receive anything.

It also **closes the row out**, setting `finishedAt`. The extension registered
the row, so it owns the row's end — and a finished row is the only kind the
registry's `pruneLocked` can evict under its per-repo cap, so an unfinished one
would sit for the full retain bound and could crowd real rows out. A 404 on
either call means there was no row to end, and is silent.

Without this, `list_peer_sessions` kept offering archived cards, a send to one
was accepted by the relay and drained by the recipient board, and then refused
by `host.deliver` (which will not resurrect a card that left the board on
purpose) — so the message sat pending on a card nobody was looking at, with no
receipts to say so. Found in verification.

### Uninstalling does not delete your data

The state file is:

```
<DATA_DIR>/peer-messaging/state.json
```

…which is `~/.agent-wrangler/peer-messaging/state.json` unless `AW_DATA_DIR` is
set. It holds your approvals, the log of what was delivered, and **any messages
still waiting for approval, bodies included**.

An uninstall removes the extension's directory and its provenance record but
**not** this file, because the wrangler does not know where an extension keeps
its data — a store's file is chosen by the extension's own factory and there is
no wrangler-owned per-extension data dir to sweep. Delete it by hand if you want
it gone. (An explicit purge is a core feature and is deferred there.)

Uninstall also deregisters the row, its tools, its handlers and its asset route
at once, but still asks for a restart: Node cannot unload a module, so the old
code is resident until the process exits.

---

### What happens when the registry restarts

Its ledger is in memory by default, so a restart empties it. The sweep notices
the up transition and republishes every live card's handle on the next tick
rather than waiting for its own five-minute re-assert clock — so peers can find
each other again within about 15 seconds, not five minutes.

The re-assert **repairs**, not just re-notes: a note that comes back 404 proves
the row is gone, so the sweep re-registers it (origin, branch, owner, intent,
detail) and then notes the handle again. A restarted registry gets real rows
back, not just handles. A 404 is never counted as the registry being down.

The re-assert is on that slow clock at all because it is one POST **per live
card**, where a drain is one request per repo: putting it on the 15-second tick
would reintroduce exactly the trickle that the batched drain exists to remove.
It is a safety net for a note the dispatch/resume hooks dropped, not the
mechanism.

## How it hangs together

| File | Job |
|---|---|
| `index.js` | The manifest. Imports from `lib/`; **nothing in `lib/` or `public/` may import it back** (see below). |
| `lib/store.js` | `PeerMessageStore`. Synchronous mutators, persistence as a side effect. |
| `lib/sweep.js` | The `postmaster` sweep: drain → persist → ack → auto-deliver the pre-approved. |
| `lib/registry.js` | The HTTP client. Every function returns `{ok, …}` and never throws. |
| `lib/repo-key.js` | `<owner>/<repo>`, reimplementing the registry's own Go normalisation. |
| `lib/framing.js` | The `[peer message · untrusted · …]` frame and its marker escaping. |
| `lib/hooks.js` | Card registration, early cwd capture, handle publication and archive/purge cleanup. |
| `skills/session-registry/hooks/` | Native prompt brief and reminder plus the note-call marker. |
| `lib/prompt-context.js` | Short-lived cwd for tool calls before dispatch saves the card. |
| `lib/tools.js` | Peer messaging and registry MCP tools. |
| `skills/session-registry/` | Bundled skill and native hook plugin for note and peer checks. |
| `lib/handlers.js` | The six control handlers behind the buttons. |
| `lib/graph.js` | The `graph.peerMessaging` contributor. |
| `lib/directory.js` | The last directory fetch, held for the graph. Pure module state; the sweep writes it, the graph reads it. |
| `public/client.js` | The panel, the card pill and the Session registry view. Every peer string via `textContent`. |

### Caps

| Cap | Value | Why |
|---|---|---|
| Pending per card | 50 | Over it, a message is dropped **and acked** — the relay's drain is non-destructive, so leaving it unacked re-delivers it every sweep for ever. |
| Body | 4096 chars | Matches the relay's own cap, so nothing larger is ever stored. |
| Seen ring per card | 200 | What makes the non-destructive drain idempotent across a crash between persist and ack. Comfortably over the relay's per-target cap of 100. |
| Thread per peer | 50 | A convenience log, not the record; oldest falls off. |
| Registry on the graph | 256KB | Past it, later repos are dropped and `truncated` says so. Separate from the pending-body budget: the two bound different payloads. |

### Three rules a contributor will trip over

1. **`onDispatch` and `onResume` must not return their network promise.** The
   core `await`s session hooks — inside `dispatch()` and `_doResume()` — so a
   returned promise adds the full 5-second fetch timeout to *every dispatch and
   every resume on the board*, worst of all when the registry is down. They fire
   the POST, attach a `.catch`, and return synchronously. The sweep's
   re-assert is what makes a dropped publication self-healing.
2. **No file under `lib/` or `public/` may import `../index.js`.** The
   wrangler's `FORBIDDEN_IMPORTS` scan matches that *shape*, not the intent, and
   quarantines the whole extension at discovery with a reason about server core
   modules. The dependency direction is one-way. `test/manifest.test.js` asserts
   it, and imports the manifest dynamically for the same reason (see the finding
   below).
3. **Nothing may log or throw on the graph tick.** `lib/graph.js` reads the
   in-memory store and two module-level values and does nothing else — no
   `fetch`, no `fs`, no `git`, and deliberately not `host.sessions.list()`.

---
