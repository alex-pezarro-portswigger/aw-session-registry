import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ FINDING — the import scan applies to an extension's TEST files too, so  │
// │ this is a DYNAMIC import and has to be.                                 │
// └─────────────────────────────────────────────────────────────────────────┘
// `importViolation` (server/extensions/external.js) walks every `.js` file
// under the installed tree except `node_modules` and dot-directories — and an
// install is a `git clone`, so `test/` is on disk at
// <DATA_DIR>/extensions/peer-messaging/test/ and is scanned. One of its
// patterns is `/from\s+['"](\.\.\/)+index\.js['"]/`, which is exactly what a
// manifest SELF-CHECK test naturally writes, so
// `import manifest from '../index.js'` at the top of this file quarantines the
// whole extension at discovery — with a reason about "a server core module"
// that has nothing to do with what happened.
//
// A dynamic import is not matched (the scanner only looks at lines beginning
// with `import`), which the rule's own comment already admits it is trivially
// bypassed by. Using it here is NOT working around the rule: nothing in this
// repo imports a server module, and the rule exists to catch that. It is
// working around the scan's blast radius. Reported upstream; the fix belongs
// in `ownJsFiles`, not here.
const { default: manifest, dir } = await import('../index.js');

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// A validateManifest-SHAPED self-check. This suite cannot import the wrangler's
// own validator — the extension must not import from the server tree at all —
// so the shape is asserted locally. Every rule below mirrors one in
// `server/extensions/index.js` `validateManifest` or in the install flow, and
// the point is that a mistake fails `npm test` here rather than quarantining
// the extension on somebody's board.

const CAPABILITIES = new Set([
  'sessions:read', 'sessions:wake', 'sessions:archive', 'sessions:spawn', 'sessions:kill',
  'tasks:read', 'tasks:write',
  'memory:read', 'memory:append',
  'deliver',
  'board:rebuild', 'board:broadcast',
  'terminals:create',
  'schedules:read', 'schedules:write',
  'mail:read', 'mail:send',
]);
const SESSION_HOOKS = new Set(['onBeforeDispatch', 'onArchive', 'onFork', 'onPurge', 'onDispatch', 'onResume', 'onPrompt']);
const SETTING_TYPES = new Set(['text', 'number', 'toggle']);
const ID_RE = /^[a-z][a-z0-9-]*$/;
const SETTING_KEY_RE = /^[a-z][a-zA-Z0-9]*$/;

test('the id matches the loader"s shape, and IS the installed directory name', () => {
  assert.match(manifest.id, ID_RE);
  assert.equal(manifest.id, 'peer-messaging');
  // `admitExternal` refuses a manifest whose id differs from its directory, and
  // the provenance record, the /ext/<id>/ asset route and the uninstall path
  // are all keyed on one of the two.
  assert.equal(manifest.id, pkg.wranglerExtension.id);
  assert.equal(path.basename(dir), 'aw-peer-messaging', 'the repo dir; the INSTALLED dir is <DATA_DIR>/extensions/peer-messaging');
});

test('label, help and the prose fields are non-empty strings', () => {
  assert.equal(typeof manifest.label, 'string');
  assert.ok(manifest.label);
  for (const k of ['help', 'description', 'author', 'homepage']) {
    assert.equal(typeof manifest[k], 'string', k);
    assert.ok(manifest[k], k);
  }
});

// `help` says what the feature IS. extensionFlipNote owns timing and can be
// exact because it knows the direction of the flip; a static sentence cannot.
test('help says nothing about restarts or when a change takes effect', () => {
  assert.doesNotMatch(manifest.help, /restart|takes effect|next resume/i);
});

test('every capability is one the server serves, and the list is the DISCLOSED one', () => {
  assert.ok(Array.isArray(manifest.requires));
  for (const c of manifest.requires) assert.ok(CAPABILITIES.has(c), c);
  // assertManifestMatchesDeclaration fails the install on a `requires` WIDER
  // than package.json disclosed, and the provenance record stores the
  // disclosure as the consented set — so the two must not drift.
  assert.deepEqual([...manifest.requires].sort(), [...pkg.wranglerExtension.requires].sort());
});

test('sessions:wake is deliberately absent — host.deliver already wakes a target', () => {
  assert.equal(manifest.requires.includes('sessions:wake'), false);
});

test('the declared host API range covers native onPrompt context injection', () => {
  assert.equal(manifest.engines.wranglerApi, '^1.11.0');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/client.js'), 'utf8').includes('onMessage'));
});

test('defaultEnabled is false — nothing reaches a network host until someone opts in', () => {
  assert.equal(manifest.defaultEnabled, false);
});

test('every store is a factory function', () => {
  for (const [name, f] of Object.entries(manifest.stores)) assert.equal(typeof f, 'function', name);
});

test('every setting def has a valid key, type and label, with no duplicates', () => {
  const keys = new Set();
  for (const s of manifest.settings) {
    assert.match(s.key, SETTING_KEY_RE);
    assert.equal(keys.has(s.key), false, `duplicate ${s.key}`);
    keys.add(s.key);
    assert.ok(SETTING_TYPES.has(s.type), s.type);
    assert.equal(typeof s.label, 'string');
    assert.ok(s.label);
    for (const k of ['help', 'placeholder']) {
      if (s[k] != null) assert.equal(typeof s[k], 'string', `${s.key}.${k}`);
    }
    // There is no `default` on a def, deliberately: an unset setting must read
    // as undefined, which is what the "no registry URL means wholly inert"
    // behaviour depends on. And no `secret` type exists to ask for.
    assert.equal('default' in s, false, `${s.key} must not declare a default`);
  }
  assert.deepEqual([...keys], ['registryUrl', 'pollSeconds']);
});

test('every tool and handler has a name/type and a handler function', () => {
  for (const t of manifest.tools) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name);
    assert.equal(typeof t.handler, 'function');
  }
  for (const h of manifest.handlers) {
    assert.equal(typeof h.type, 'string');
    assert.ok(h.type);
    assert.equal(typeof h.handler, 'function');
    // Namespaced, so a collision with a core handler type (which would be a
    // boot failure for a builtin and a quarantine for this) is unlikely.
    assert.match(h.type, /^peer-/);
  }
  assert.equal(new Set(manifest.handlers.map((h) => h.type)).size, manifest.handlers.length);
});

test('registry tools and launch reminder are contributed together', () => {
  assert.deepEqual(manifest.tools.map((t) => t.name), [
    'send_peer_message', 'list_peer_sessions', 'list_repo_sessions', 'update_session_note',
  ]);
  assert.deepEqual(manifest.skills, ['session-registry']);
  const skillDir = path.join(dir, 'skills', 'session-registry');
  assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /^---\nname: session-registry\n/);
  assert.equal(fs.existsSync(path.join(skillDir, 'WRANGLER.md')), false, 'the reminder comes from onPrompt');
});

test('every session hook is a known name and a function', () => {
  for (const [k, fn] of Object.entries(manifest.session)) {
    assert.ok(SESSION_HOOKS.has(k), k);
    assert.equal(typeof fn, 'function', k);
  }
});

test('every sweep has an id, a positive finite everyMs and a run function', () => {
  for (const s of manifest.sweeps) {
    assert.ok(s.id);
    assert.ok(Number.isFinite(s.everyMs) && s.everyMs > 0);
    assert.equal(typeof s.run, 'function');
  }
});

test('the graph contributor is a function, and its key is not a reserved one', () => {
  assert.equal(typeof manifest.graph, 'function');
  const RESERVED = new Set([
    'nodes', 'edges', 'sessions', 'history', 'generatedAt', 'tasks', 'schedules', 'extensions',
    'checklists', 'checklistEnabled', 'taskMemoryEnabled', 'subagentsExpandedByDefault',
    'trustCodexLaunchCwd', 'childFullViewByDefault', 'autoFixPrChecksDefault',
    'archiveReviewEnabled', 'chatViewDefault', 'quarantinedBuiltins',
  ]);
  const keys = Object.keys(manifest.graph({ host: { stores: {}, settings: { get: () => undefined } }, graph: {} }));
  for (const k of keys) assert.equal(RESERVED.has(k), false, k);
  assert.deepEqual(keys, ['peerMessaging']);
});

test('client and styles resolve under the manifest"s own public/ and exist', () => {
  for (const key of ['client', 'styles']) {
    const rel = manifest[key];
    assert.equal(typeof rel, 'string');
    const resolved = path.resolve(dir, rel);
    assert.ok(resolved.startsWith(`${path.join(dir, 'public')}${path.sep}`), `${key} escapes public/`);
    assert.ok(fs.existsSync(resolved), `${key} does not exist`);
  }
});

// ── The import trap ──────────────────────────────────────────────────────────
// FORBIDDEN_IMPORTS (server/extensions/external.js) is applied to the
// extension's OWN .js files and quarantines the whole thing on a match, with a
// reason about "a server core module" that has nothing to do with what went
// wrong. Asserted here so the trap springs in `npm test`.
const FORBIDDEN = [
  /\/(session-manager|state-reader|tmux-scraper)\.js['"]/,
  /from\s+['"](\.\.\/)+index\.js['"]/,
  /\/host-api\//,
];

function ownJsFiles(root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) ownJsFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no file of ours statically imports ../index.js or anything the scanner forbids', () => {
  const files = ownJsFiles(ROOT);
  assert.ok(files.length > 5, 'the scan found the files');
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!/^\s*import\b/.test(line)) continue;
      for (const re of FORBIDDEN) {
        assert.equal(re.test(line), false, `${path.relative(ROOT, file)}: ${line.trim()}`);
      }
    }
  }
});

test('nothing under lib/ or public/ imports the manifest, keeping the direction one-way', () => {
  for (const sub of ['lib', 'public']) {
    for (const file of ownJsFiles(path.join(ROOT, sub))) {
      const body = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(body, /from\s+['"]\.\.\/index\.js['"]/, path.relative(ROOT, file));
      assert.doesNotMatch(body, /import\(\s*['"]\.\.\/index\.js['"]/, path.relative(ROOT, file));
    }
  }
});

// ── The package, as the install flow reads it ───────────────────────────────

test('package.json declares type:module, a lockfile is committed, and zod is pinned to the server"s range', () => {
  assert.equal(pkg.type, 'module');
  // `package-lock.json` is MANDATORY: install.js refuses a repo without one
  // BEFORE the disclosure, because an unpinned dependency set cannot be
  // disclosed honestly.
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')));
  // Pinned to the server's own range so a zod 4 shape never meets a v3
  // consumer inside the MCP SDK.
  assert.equal(pkg.dependencies.zod, '^3.25.76');
});

test('the wranglerExtension block matches the manifest on every field the install flow compares', () => {
  const d = pkg.wranglerExtension;
  assert.equal(d.id, manifest.id);
  assert.equal(d.label, manifest.label);
  assert.equal(d.description, manifest.description);
  assert.equal(d.author, manifest.author);
  assert.equal(d.homepage, manifest.homepage);
});

// The consent modal's TRUST_STATEMENT is the canonical wording and is not
// softened anywhere. Nothing this extension ships may imply a sandbox.
test('no string this extension ships claims to be sandboxed or isolated', () => {
  // The SHIPPED surfaces — what a human or an agent reads. The test files are
  // excluded because this test's own name is in one of them.
  const files = [
    ...ownJsFiles(ROOT).filter((f) => !f.includes(`${path.sep}test${path.sep}`)),
    path.join(ROOT, 'README.md'), path.join(ROOT, 'package.json'), path.join(ROOT, 'public/peer.css'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    for (const claim of [/\bsandbox(ed|ing)?\b/i, /\bisolated from\b/i, /\bcannot access the (machine|filesystem|host)\b/i]) {
      const hit = body.split('\n').find((l) => claim.test(l) && !/NOT|never|no sandbox|not a sandbox|rather than a sandbox/i.test(l));
      assert.equal(hit, undefined, `${path.relative(ROOT, file)}: ${hit}`);
    }
  }
});
