import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromOriginUrl, normalise, repoKeyFor, _resetRepoKeyCache } from '../lib/repo-key.js';

// THE SAME CASE TABLE as internal/repokey/repokey_test.go in
// cod-session-registry. This is the only thing keeping a JS reimplementation of
// a Go function honest, and a mismatch is silent in production (the drain finds
// nothing rather than erroring) — so if the Go table changes, change this one.
test('fromOriginUrl matches the registry"s FromOriginURL table', () => {
  const cases = [
    ['git@github.com:acme/app.git', 'acme/app'],
    ['git@github.com:acme/app', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'acme/app'],
    ['ssh://git@github.com:22/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'],
    ['https://x-access-token:ghs_secret@github.com/acme/app.git', 'acme/app'],
    ['https://github.com/ACME/App.git', 'acme/app'],
    ['  https://github.com/acme/app.git\n', 'acme/app'],
    // Nested paths keep the last two segments — right for GitHub, approximate
    // for nested GitLab subgroups, and the registry is approximate the same way.
    ['https://gitlab.example.com/group/sub/acme/app.git', 'acme/app'],
    ['https://github.com/acme', null],
    ['https://github.com/', null],
    ['git@github.com:app.git', null],
    ['', null],
    ['nonsense', null],
    // Traversal must not survive normalisation.
    ['https://github.com/../../etc/passwd', null],
  ];
  for (const [input, want] of cases) {
    assert.equal(fromOriginUrl(input), want, JSON.stringify(input));
  }
});

test('normalise matches the registry"s Normalise table', () => {
  const cases = [
    ['Acme/App', 'acme/app'],
    ['acme/app.git', 'acme/app'],
    ['/acme/app/', 'acme/app'],
    ['acme/app-2_x.y', 'acme/app-2_x.y'],
    ['acme', null],
    ['acme/app/extra', null],
    ['acme/', null],
    ['/', null],
    ["..'/..", null],
    ['acme/..', null],
    ['../etc', null],
    ['acme/app space', null],
    ['acme/app?x=1', null],
    ['acme/app\x00', null],
  ];
  for (const [input, want] of cases) {
    assert.equal(normalise(input), want, JSON.stringify(input));
  }
});

test('a segment over 100 characters is refused', () => {
  assert.equal(normalise(`acme/${'a'.repeat(100)}`), `acme/${'a'.repeat(100)}`);
  assert.equal(normalise(`acme/${'a'.repeat(101)}`), null);
});

// The cache is what keeps the sweep from spawning one `git` per live session
// per tick, which at a 15s cadence and a dozen cards is a permanent trickle of
// subprocesses for a value that cannot change.
test('repoKeyFor calls git once per cwd and caches the answer', async () => {
  _resetRepoKeyCache();
  const calls = [];
  const gitOrigin = async (cwd) => { calls.push(cwd); return 'git@github.com:acme/app.git'; };
  assert.equal(await repoKeyFor('/w/one', { gitOrigin }), 'acme/app');
  assert.equal(await repoKeyFor('/w/one', { gitOrigin }), 'acme/app');
  assert.equal(await repoKeyFor('/w/two', { gitOrigin }), 'acme/app');
  assert.deepEqual(calls, ['/w/one', '/w/two']);
});

test('a NEGATIVE result is cached too — a non-git cwd is not re-probed every tick', async () => {
  _resetRepoKeyCache();
  let n = 0;
  const gitOrigin = async () => { n += 1; return null; };
  assert.equal(await repoKeyFor('/scratch', { gitOrigin }), null);
  assert.equal(await repoKeyFor('/scratch', { gitOrigin }), null);
  assert.equal(n, 1);
});

test('a blank cwd is null without touching git at all', async () => {
  _resetRepoKeyCache();
  const gitOrigin = async () => { throw new Error('should not run'); };
  assert.equal(await repoKeyFor('', { gitOrigin }), null);
  assert.equal(await repoKeyFor(null, { gitOrigin }), null);
});

test('a remote with no owner/repo shape is null, never a throw', async () => {
  _resetRepoKeyCache();
  const gitOrigin = async () => 'nonsense';
  assert.equal(await repoKeyFor('/w/odd', { gitOrigin }), null);
});

// The `new URL` divergence this file's urlPath() exists for: JS normalises `..`
// out of a path, Go's url.Parse does not, and only the Go behaviour lets the
// traversal check fire. Kept as its own test so a future "simplify it with
// new URL" reintroduces a visible failure rather than a silent key mismatch.
test('percent-encoded and plain traversal are both refused, as they are in Go', () => {
  assert.equal(fromOriginUrl('https://github.com/../../etc/passwd'), null);
  assert.equal(fromOriginUrl('https://github.com/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(fromOriginUrl('https://github.com/acme/../evil/app.git'), null);
});

test('a query string and a fragment are dropped, as Go"s u.Path drops them', () => {
  assert.equal(fromOriginUrl('https://github.com/acme/app?x=1'), 'acme/app');
  assert.equal(fromOriginUrl('https://github.com/acme/app.git#frag'), 'acme/app');
});

test('a malformed percent escape is null rather than a throw', () => {
  assert.equal(fromOriginUrl('https://github.com/acme/%zz'), null);
});
