import os from 'node:os';
import path from 'node:path';

// This extension's OWN copy of the wrangler's AW_DATA_DIR resolution
// (server/data-dir.js), tilde expansion included, and a deliberate duplication
// rather than an import: every file in this package must stay importable with
// nothing but node builtins and this package's own dependencies. An extension
// runs inside the wrangler's process but is not part of its module graph — a
// relative import back into the server tree is what `FORBIDDEN_IMPORTS`
// (server/extensions/external.js) quarantines an extension for, and the
// wrangler exposes no data-dir value on the `host` façade.
//
// It must therefore be kept in step with the wrangler by hand. That is a small
// risk with a loud symptom: if the two ever disagree, this extension's state
// lands in a directory the human is not looking at, which the README names so
// it can be found either way.
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export const DATA_DIR = process.env.AW_DATA_DIR
  ? path.resolve(expandTilde(process.env.AW_DATA_DIR))
  : path.join(os.homedir(), '.agent-wrangler');

// Everything this extension persists lives under here, and the README names the
// path: an uninstall removes the extension's directory and its provenance record
// but NOT this, because the wrangler does not know where an extension keeps its
// data (see `uninstallBodyText`). A human who wants the state gone deletes it.
export const PEER_DIR = path.join(DATA_DIR, 'peer-messaging');
export const STATE_FILE = path.join(PEER_DIR, 'state.json');
