export type Message = {
  id: string
  fromRepo: string
  fromHandle: string
  fromOwnerKey: string
  fromDisplay: string
  toRepo: string
  toHandle: string
  body: string
  createdAt: string
}

export type Peer = { repo: string; handle: string; owner: string; intent: string; branch: string }

// A standing answer for one sender session, set by Accept all / Dismiss all.
export type Rule = 'accept' | 'dismiss'

export type Me = { url: string; repo: string; handle: string; owner: string; email: string; receives: boolean; registers: boolean }

declare module 'claude-code' {
  interface PluginState {
    'peer-messages': { me: Me | null; inbox: Message[]; peers: Peer[]; rules: Record<string, Rule> }
  }
}
