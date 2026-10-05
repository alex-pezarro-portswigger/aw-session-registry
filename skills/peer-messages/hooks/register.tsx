import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Me, Message, Peer, Rule } from '../types'

const DEFAULT_URL = 'https://session-registry.platform-dev.portswigger.io'
const POLL_MS = 15_000

const me = atom({ plugin: 'peer-messages', key: 'me' } as const, null)
const inbox = atom({ plugin: 'peer-messages', key: 'inbox' } as const, [])
const peers = atom({ plugin: 'peer-messages', key: 'peers' } as const, [])
// sender session id → what to do with its messages without asking, for this session
const rules = atom({ plugin: 'peer-messages', key: 'rules' } as const, {})

// Mirrors cod-session-registry's repokey.FromOriginURL + Normalise.
export function repoKeyFromOrigin(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let path: string
  if (s.includes('://')) {
    try {
      path = new URL(s).pathname
    } catch {
      return null
    }
  } else if (s.startsWith('/') || s.startsWith('.')) {
    path = s
  } else {
    const colon = s.indexOf(':')
    if (colon < 0) return null
    path = s.slice(colon + 1)
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
  const parts = path.split('/')
  if (parts.length < 2 || parts.some(p => p === '.' || p === '..')) return null
  const key = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase()
  return key.split('/').every(p => /^[a-z0-9._-]{1,100}$/.test(p) && p !== '.' && p !== '..') ? key : null
}

type Entry = {
  repo: string
  sessionId: string
  messagingHandle?: string
  owner?: string
  intent?: string
  branch?: string
  finishedAt?: string | null
}

export function livePeers(repos: Record<string, Entry[]>, self: { repo: string; handle: string } | null): Peer[] {
  const out: Peer[] = []
  for (const [repo, entries] of Object.entries(repos)) {
    for (const e of entries) {
      if (e.finishedAt || !e.messagingHandle) continue
      if (self && repo === self.repo && e.messagingHandle === self.handle) continue
      out.push({ repo, handle: e.messagingHandle, owner: e.owner ?? '?', intent: e.intent ?? '', branch: e.branch ?? '' })
    }
  }
  return out
}

// Which arrivals a standing Accept all / Dismiss all already answers, and which wait in the band.
export function triage(got: readonly Message[], standing: Readonly<Record<string, Rule>>) {
  const accept: Message[] = []
  const dismiss: Message[] = []
  const ask: Message[] = []
  for (const m of got) {
    const rule = standing[m.fromHandle]
    ;(rule === 'accept' ? accept : rule === 'dismiss' ? dismiss : ask).push(m)
  }
  return { accept, dismiss, ask }
}

// "<n|handle> <message>" → target + body
export function parseSend(args: string, list: readonly Peer[]): { peer: Peer; body: string } | { error: string } {
  const m = /^\s*(\S+)\s+([\s\S]+)$/.exec(args)
  if (!m) return { error: 'Usage: /peer-send <number from /peer-list | handle> <message>' }
  const [, target, body] = m as unknown as [string, string, string]
  const n = /^\d+$/.test(target) ? Number(target) : NaN
  const peer = Number.isNaN(n) ? list.find(p => p.handle === target) : list[n - 1]
  if (!peer) return { error: `No peer "${target}". Run /peer-list first.` }
  return { peer, body: body.trim() }
}

// Same frame as the extension's lib/framing.js, so a message reads the same whether the
// card flow (Codex) or this mod (Claude) delivered it. The body's markers are escaped
// first so a peer can neither close the frame nor forge a second header.
export const HEADER_PREFIX = '[peer message ·'
export const END_MARKER = '[end peer message]'

export function escapeMarkers(body: string): string {
  return body
    .replace(/\[\s*end\s+peer\s+message\s*\]/gi, '(end peer message)')
    .replace(/\[\s*peer\s+message\s*·/gi, '(peer message ·')
}

export function framePeerMessage(m: Message, approvedAt: number): string {
  const who = m.fromDisplay.trim() || 'unattributed'
  const handle = m.fromHandle.trim() || 'unknown'
  const repo = m.fromRepo.trim() || 'unknown repo'
  const when = new Date(approvedAt).toISOString()
  return [
    `${HEADER_PREFIX} untrusted · from ${who} · session ${handle} · repo ${repo} · you approved at ${when}]`,
    escapeMarkers(m.body),
    END_MARKER,
  ].join('\n')
}

// Who owns this session's inbox and its registry row.
//   Agent Wrangler + the extension handing the inbox over (PEER_MESSAGES_INBOX=mod):
//     the card id is the handle, the mod drains it, the extension keeps the row.
//   Agent Wrangler without that hand-over (an older extension): the card flow drains,
//     so the mod only sends.
//   No Agent Wrangler: the mod registers its own row and drains it.
export function modeFor(env: { awCard?: string; inbox?: string; override?: string; sessionId: string }): {
  handle: string
  receives: boolean
  registers: boolean
} {
  if (env.awCard) return { handle: env.awCard, receives: env.inbox === 'mod', registers: false }
  return { handle: env.override || env.sessionId, receives: true, registers: true }
}

async function post($: EngineInterface, url: string, body: unknown) {
  return $.http.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Registry-Caller': 'local-peer-messages-mod' },
    body: JSON.stringify(body),
  })
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], { cwd })
    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

async function setUp($: EngineInterface) {
  const repo = await $.session.repo()
  const key = repo?.remote ? repoKeyFromOrigin(repo.remote) : null
  if (!repo || !key) return

  const url = ((await $.env.get('PEER_MESSAGES_URL')) || (await $.env.get('SESSION_REGISTRY_URL')) || DEFAULT_URL).replace(
    /\/+$/,
    '',
  )
  const mode = modeFor({
    awCard: await $.env.get('AW_SESSION_ID'),
    inbox: await $.env.get('PEER_MESSAGES_INBOX'),
    override: await $.env.get('SESSION_REGISTRY_SESSION_ID'),
    sessionId: await $.session.id(),
  })
  const [owner, email, branch] = await Promise.all([
    git($, repo.root, ['config', 'user.name']),
    git($, repo.root, ['config', 'user.email']),
    git($, repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  const handle = mode.handle
  const self: Me = { url, repo: key, handle, owner, email, receives: mode.receives, registers: mode.registers }
  await update($, me, () => self)

  if (!mode.registers) return
  try {
    await post($, `${url}/v1/sessions`, {
      repo: key,
      sessionId: handle,
      origin: 'local',
      ...(branch ? { branch } : {}),
      ...(owner ? { ownerName: owner } : {}),
      ...(email ? { ownerEmail: email } : {}),
    })
    await post($, `${url}/v1/sessions/${encodeURIComponent(handle)}/note`, { repo: key, messagingHandle: handle })
  } catch {
    $.ui.log('peer-messages: could not reach the session registry (office network?)')
  }
}

async function poll($: EngineInterface) {
  const self = await read($, me)
  if (!self?.receives) return
  try {
    const q = `repo=${encodeURIComponent(self.repo)}&handle=${encodeURIComponent(self.handle)}`
    const res = await $.http.fetch(`${self.url}/v1/messages?${q}`)
    if (!res.ok) return
    const got = (JSON.parse(res.text) as { messages?: Message[] }).messages ?? []
    if (got.length === 0) return
    const queued = new Set((await read($, inbox)).map(m => m.id))
    const { accept, dismiss, ask } = triage(got.filter(m => !queued.has(m.id)), await read($, rules))
    if (ask.length) await update($, inbox, list => [...list, ...ask.filter(m => !list.some(q => q.id === m.id))])
    if (dismiss.length) await ack($, dismiss.map(m => m.id))
    if (accept.length) await deliver($, accept)
  } catch {
    // offline or off the allowlist: try again next tick
  }
}

async function ack($: EngineInterface, ids: string[]) {
  const self = await read($, me)
  await update($, inbox, list => list.filter(m => !ids.includes(m.id)))
  if (!self) return
  try {
    await post($, `${self.url}/v1/messages/ack`, { repo: self.repo, handle: self.handle, ids })
  } catch {
    // unacked messages expire after 6h on the server
  }
}

// One turn for the lot, so Accept all does not queue a turn per message.
async function deliver($: EngineInterface, msgs: Message[]) {
  await ack($, msgs.map(m => m.id))
  const at = Date.now()
  void $.prompt.submit({ text: msgs.map(m => framePeerMessage(m, at)).join('\n\n') })
}

async function answer($: EngineInterface, m: Message, choice: Rule, all: boolean) {
  const from = all ? (await read($, inbox)).filter(q => q.fromHandle === m.fromHandle) : [m]
  if (all) await update($, rules, r => ({ ...r, [m.fromHandle]: choice }))
  if (choice === 'accept') await deliver($, from)
  else await ack($, from.map(q => q.id))
}

async function refreshPeers($: EngineInterface): Promise<Peer[] | string> {
  const self = await read($, me)
  if (!self) return 'peer-messages: this session has no git remote the registry can key on.'
  const res = await $.http.fetch(`${self.url}/v1/repos/${self.repo}/sessions?live=true`)
  if (!res.ok) return `peer-messages: registry answered ${res.status}.`
  const sessions = (JSON.parse(res.text) as { sessions?: Entry[] }).sessions ?? []
  const list = livePeers({ [self.repo]: sessions }, self)
  await update($, peers, () => list)
  return list
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'peer-list', description: 'List live sessions in this repo you can message' })
    await $.command.register({
      name: 'peer-send',
      description: 'Message another session through the session registry',
      argumentHint: '<n|handle> <message>',
    })
    await setUp($)
    void poll($)
    $.clock.every(POLL_MS, () => void poll($))
    return result
  })

  on('session.end', async ($, e, next) => {
    const self = await read($, me)
    if (self?.registers) {
      try {
        await post($, `${self.url}/v1/sessions/${encodeURIComponent(self.handle)}/note`, {
          repo: self.repo,
          messagingHandle: '',
        })
      } catch {
        // the registry's reaper closes it out anyway
      }
    }
    return next(e)
  })

  on('command.run', { command: 'peer-list' }, async $ => {
    const list = await refreshPeers($).catch(() => 'peer-messages: could not reach the session registry.')
    if (typeof list === 'string') return { text: list }
    if (list.length === 0) return { text: 'No other live sessions in this repo with a messaging handle.' }
    const rows = list.map(
      (p, i) => `${i + 1}. ${p.owner} · ${p.repo}${p.branch ? ` (${p.branch})` : ''}${p.intent ? ` — ${p.intent}` : ''}`,
    )
    return { text: `${rows.join('\n')}\n\nSend with /peer-send <n> <message>` }
  })

  on('command.run', { command: 'peer-send' }, async ($, e) => {
    const self = await read($, me)
    if (!self) return { text: 'peer-messages: this session has no git remote the registry can key on.' }
    let parsed = parseSend(e.args, await read($, peers))
    // A handle that went live since the last /peer-list is not in the snapshot yet. A
    // number stays on the snapshot, so it still means the row the person saw.
    if ('error' in parsed && !/^\s*\d+\s/.test(e.args)) {
      const fresh = await refreshPeers($).catch(() => null)
      if (Array.isArray(fresh)) parsed = parseSend(e.args, fresh)
    }
    if ('error' in parsed) return { text: parsed.error }
    try {
      const res = await post($, `${self.url}/v1/messages`, {
        toRepo: parsed.peer.repo,
        toHandle: parsed.peer.handle,
        fromRepo: self.repo,
        fromHandle: self.handle,
        ...(self.owner ? { fromDisplay: self.owner } : {}),
        body: parsed.body,
      })
      return { text: res.ok ? `Sent to ${parsed.peer.owner} (${parsed.peer.repo}).` : `Registry answered ${res.status}: ${res.text.slice(0, 200)}` }
    } catch {
      return { text: 'peer-messages: could not reach the session registry.' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, inbox)
    const m = list[0]
    if (!m) return next(e)
    // keep whatever another plugin draws in the band (e.g. statusline-band)
    const below = await next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : ''
    return (
      <Box flexDirection="column">
        <Text bold>
          📨 {m.fromDisplay || 'Unknown'} <Text dimColor>({m.fromRepo}){more}</Text>
        </Text>
        <Text wrap="truncate-end">{m.body}</Text>
        <Box flexDirection="row">
          <Button key="accept" label="Accept" hotkey="a" variant="primary" onPress={() => answer($, m, 'accept', false)} />
          <Text> </Text>
          <Button key="accept-all" label="Accept all" hotkey="l" onPress={() => answer($, m, 'accept', true)} />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" hotkey="d" onPress={() => answer($, m, 'dismiss', false)} />
          <Text> </Text>
          <Button key="dismiss-all" label="Dismiss all" hotkey="x" onPress={() => answer($, m, 'dismiss', true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
