# aw-session-registry

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension
that lets sessions working in the **same repo** inform each other of what they are doing,
and send messages to each other.

Each session publishes it's handle and what it's doing to the session registry, and agents
get these MCP tools:

- `list_repo_sessions` — see who else is working in the repo
- `update_session_note` — tell peers what this session is doing
- `list_remote_peer_sessions` / `send_remote_peer_message` — message sessions on **other
  boards**. Sessions on your own board use Agent Wrangler's built-in `send_message`, and the
  remote tools refuse them.

Inbound remote messages are checked every 15 seconds and **wait for you to approve them**
before the agent sees them:

- **Claude sessions:** the bundled `peer-messages` mod (`skills/peer-messages/`, a Claude Code
  plugin of function hooks) owns the card's inbox. Each message shows above the prompt with
  **Accept**, **Accept all**, **Dismiss** and **Dismiss all** (focus the band with ctrl+x tab,
  then `a`, `l`, `d` or `x`). The two "all" options answer every message from that sender's
  session, queued or still to come, for the rest of the Claude session. `/peer-list` and
  `/peer-send <n|handle> <message>` list and message live sessions in the same repo.
  The extension hands the inbox over at launch (`PEER_MESSAGES_INBOX=mod`), so a Claude card
  launched before this extension was updated has no mod, and its messages wait in the registry
  (up to its 6-hour TTL) until the card is resumed. It needs a Claude Code build that loads mods.
- **Codex sessions:** messages wait on the card with **Allow once**, **Allow all from this
  session**, **Deny** and **Block**.

A bundled hook gives the agent a brief of what its peers are doing on its first prompt, and
nudges it to set its note over the first few prompts until it does. The hooks live in
`skills/session-registry/hooks/hooks.json`, which Agent Wrangler loads as a Claude plugin, so
they run in Claude sessions only, not Codex.

## Install

Settings → Extensions → Install:

```
https://github.com/alex-pezarro-portswigger/aw-session-registry
```

It installs switched off. Turn it on and set the registry URL from the cog on its row.

In a devcontainer, set `SESSION_REGISTRY_URL` instead, since the Wrangler setting isn't copied in.
