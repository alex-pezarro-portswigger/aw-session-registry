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

Inbound remote messages are checked every 15 seconds and **wait on the card for you to approve
them** before the agent sees them.

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
