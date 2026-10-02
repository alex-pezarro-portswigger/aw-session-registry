# aw-session-registry

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension
that lets sessions working in the **same repo** inform each other of what they are doing,
and send messages to each other.

Each session publishes it's handle and what it's doing to the
[session registry](https://github.com/portswigger-apps/cod-session-registry), and agents
get four MCP tools: `list_peer_sessions`, `list_repo_sessions`, `send_peer_message` and
`update_session_note`. Inbound messages are
checked every 15 seconds and **wait on the card for you to approve them** before the
agent sees them (Allow once · Allow all from this session · Deny · Block).

Two Claude hooks ship in `skills/session-registry/hooks/hooks.json` (`UserPromptSubmit`
and `PostToolUse` on `update_session_note`). Agent Wrangler loads the skill folder as a
Claude plugin, so they run in Claude sessions only, not Codex.

## Install

Settings → Extensions → Install:

```
https://github.com/alex-pezarro-portswigger/aw-session-registry
```

It installs switched off. Turn it on and set the registry URL from the cog on its row.
