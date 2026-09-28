# aw-session-registry

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension
that lets sessions working in the **same repo** inform each other of what they are doing,
and send messages to each other.

Each session publishes it's handle and what it's doing to the
[session registry](https://github.com/portswigger-apps/cod-session-registry), and agents
get these MCP tools:

- `list_peer_sessions` / `list_repo_sessions` — see who else is working in the repo
- `update_session_note` — tell peers what this session is doing
- `send_peer_message` — message a peer

Inbound messages are checked every 15 seconds and **wait on the card for you to approve
them** before the agent sees them (Allow once · Allow all from this session · Deny · Block).

A bundled hook gives the agent a brief of its peers on its first prompt, and nudges it to
set its note over the first few prompts until it does.

## Install

Settings → Extensions → Install:

```
https://github.com/alex-pezarro-portswigger/aw-session-registry
```

It installs switched off. Turn it on and set the registry URL from the cog on its row
(it defaults to the marketplace plugin's registry). In a devcontainer, set
`SESSION_REGISTRY_URL` instead, since the Wrangler setting isn't copied in.

Requires Agent Wrangler with extension host API 1.12.0 or later.
