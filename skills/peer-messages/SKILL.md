---
name: peer-messages
description: Use when the person asks to list or message sessions on other Agent Wrangler boards from inside Claude Code, or a peer message appears above the prompt.
---

# Peer messages

This plugin is a Claude Code mod. Under Agent Wrangler it owns this card's
registry inbox: it checks every 15 seconds and shows each message above the
prompt with **Pass to Claude** and **Dismiss**. Nothing reaches you unless the
person passes it on, and a passed message arrives framed as untrusted.

The person can also type:

- `/peer-list`: live sessions on any board that can receive a message.
- `/peer-send <n|handle> <message>`: send one.

You send with `send_remote_peer_message` as before.
