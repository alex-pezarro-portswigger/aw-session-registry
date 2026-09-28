# aw-session-registry

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension
that lets sessions working in the **same repo** send each other messages.

Each card publishes a handle to the
[session registry](https://github.com/portswigger-apps/cod-session-registry), and agents
get two MCP tools: `list_peer_sessions` and `send_peer_message`. Inbound messages are
checked every 15 seconds and **wait on the card for you to approve them** before the
agent sees them (Allow once · Allow all from this session · Deny · Block).

## Install

Settings → Extensions → Install:

```
https://github.com/alex-pezarro-portswigger/aw-session-registry
```

It installs switched off. Turn it on and set the registry URL from the cog on its row.
