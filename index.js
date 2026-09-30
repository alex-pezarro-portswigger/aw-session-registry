import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PeerMessageStore } from './lib/store.js';
import { sendPeerMessageTool, listPeerSessionsTool, listRepoSessionsTool, updateSessionNoteTool } from './lib/tools.js';
import { HANDLERS } from './lib/handlers.js';
import { onArchive, onBeforeDispatch, onDispatch, onPurge, onResume } from './lib/hooks.js';
import { POSTMASTER_SWEEP, SWEEP_MS } from './lib/sweep.js';
import { peerMessagingGraph } from './lib/graph.js';

// The manifest. `dir` is exported from import.meta.url because the wrangler
// resolves `client`/`styles` against it and refuses either if it is absent.
//
// THE DEPENDENCY DIRECTION IS ONE-WAY: this file imports from lib/, and NO file
// under lib/ or public/ may import `../index.js`. `FORBIDDEN_IMPORTS`
// (server/extensions/external.js) matches that shape and quarantines the whole
// extension at discovery with a reason about "a server core module", which is
// confusing and nothing to do with what happened. The rule exists because a
// static import of the wrangler's own index.js closes a real module cycle and
// breaks boot for the entire server; the regex cannot tell the two apart, and
// test/manifest.test.js asserts the shape locally so the trap is sprung here
// rather than on an install.
export const dir = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'peer-messaging',
  label: 'Session registry',

  // `help` says what the feature IS and what survives a toggle, and says
  // NOTHING about when a change takes effect. `extensionFlipNote`
  // (public/settings.js) owns timing and can be exact because it knows the
  // direction of the flip; a static sentence here cannot, and a blanket "takes
  // effect after a restart" would simply be false.
  help: 'Lets Agent Wrangler sessions working in the same repo send each other short messages, '
    + 'relayed by the session registry. Every inbound message waits on its card for you to approve '
    + 'it before the agent sees it — except from a session you have explicitly allowed. Your '
    + 'approvals, the messages still waiting and the log of what was delivered are kept in this '
    + 'extension\'s own file and survive being switched off.',

  description: 'Lets Agent Wrangler sessions working in the same repo inform each other of what they are doing, and send each other messages.',
  author: 'Alex Pezarro <alex.pezarro@portswigger.net>',
  homepage: 'https://github.com/alex-pezarro-portswigger/aw-session-registry',

  // OFF until someone opts in. An extension that reaches a network host the
  // moment it is installed must be chosen, not inherited — and it also means an
  // install lands registered-but-INACTIVE and the reply says `active: false`,
  // which is the honest end state rather than a surprise.
  defaultEnabled: false,

  // Native extension skill hooks arrived in 1.12.0.
  engines: { wranglerApi: '^1.12.0' },

  // Four capabilities, and the list is DISCLOSURE, not a sandbox: this
  // extension runs in-process with full access to the machine, and nothing
  // stops its code — or zod's, or any transitive dependency's — from doing
  // more than this says. Installing it is as much trust as `npm install`-ing a
  // package into the wrangler itself.
  //
  //   deliver         — the only way to put approved text in front of an agent.
  //   sessions:read   — each card's cwd, to derive its repo key.
  //   board:rebuild   — so a click or an arrival redraws the board.
  //   board:broadcast — the live ack behind a click (see lib/handlers.js).
  //
  // `sessions:wake` is deliberately NOT here: `host.deliver` already wakes a
  // dormant or suspended target, delivers after the relaunch, refuses an
  // archived one and reports which happened. A separate wake would be a second
  // route to the same thing with worse reporting, and a capability that adds
  // nothing is noise on a consent modal.
  requires: ['deliver', 'sessions:read', 'board:rebuild', 'board:broadcast'],

  // A store factory gets `{id, log}` and NOTHING else — that is the API's rule
  // rather than an oversight, because factories run before rebuild/broadcast/
  // deliver exist at all. So this store resolves its own data dir and cannot be
  // given a setting, which is why the state file's path is fixed:
  // <DATA_DIR>/peer-messaging/state.json, named in the README so a human can
  // delete it (an uninstall does not).
  stores: { peerMessages: ({ log }) => new PeerMessageStore({ log }) },

  settings: [
    {
      key: 'registryUrl',
      type: 'text',
      label: 'Session registry URL',
      placeholder: 'https://session-registry.example.internal',
      help: 'Override the session registry URL used by the marketplace plugin. The registry has no '
        + 'authentication of its own, so anything that can reach it can read what is published there.',
    },
    {
      key: 'pollSeconds',
      type: 'number',
      label: 'How often to check for messages',
      // Said here AND in the sweep's comment, because "I set it to 60 and it
      // still ran every 15 seconds" is otherwise a bug report — and so is "I
      // set it to 5 and nothing got faster".
      help: `Seconds. ${SWEEP_MS / 1000} is the floor and the granularity: the check is wired to a `
        + `fixed ${SWEEP_MS / 1000}-second timer, so a larger number makes it less frequent and `
        + 'anything at or below the floor means every time. Leave it empty for every time.',
    },
  ],

  tools: [sendPeerMessageTool, listPeerSessionsTool, listRepoSessionsTool, updateSessionNoteTool],
  skills: ['session-registry'],
  hooks: ['PostToolUse', 'UserPromptSubmit'],
  handlers: HANDLERS,
  session: { onBeforeDispatch, onDispatch, onResume, onArchive, onPurge },
  sweeps: [POSTMASTER_SWEEP],
  graph: peerMessagingGraph,
  client: 'public/client.js',
  styles: 'public/peer.css',
};
