import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitNameFor, _resetGitNameCache, MAX_NAME_CHARS } from '../lib/git-identity.js';

beforeEach(() => { _resetGitNameCache(); });

test('gitNameFor calls git once per cwd and caches the answer', async () => {
  const calls = [];
  const gitName = async (cwd) => { calls.push(cwd); return 'Sam Rivera\n'; };
  assert.equal(await gitNameFor('/w/one', { gitName }), 'Sam Rivera');
  assert.equal(await gitNameFor('/w/one', { gitName }), 'Sam Rivera');
  assert.equal(await gitNameFor('/w/two', { gitName }), 'Sam Rivera');
  assert.deepEqual(calls, ['/w/one', '/w/two']);
});

test('a NEGATIVE result is cached too', async () => {
  let n = 0;
  const gitName = async () => { n += 1; return null; };
  assert.equal(await gitNameFor('/scratch', { gitName }), null);
  assert.equal(await gitNameFor('/scratch', { gitName }), null);
  assert.equal(n, 1);
});

test('git failure or timeout is null, never a throw', async () => {
  assert.equal(await gitNameFor('/a', { gitName: async () => { throw new Error('boom'); } }), null);
  // The default impl resolves null on any execFile error, a timeout included.
  assert.equal(await gitNameFor('/b', { gitName: async () => null }), null);
});

test('output is trimmed, and whitespace-only is null', async () => {
  assert.equal(await gitNameFor('/a', { gitName: async () => '  Sam Rivera\n' }), 'Sam Rivera');
  assert.equal(await gitNameFor('/b', { gitName: async () => ' \n\t ' }), null);
});

test('internal whitespace and newlines collapse to single spaces', async () => {
  assert.equal(await gitNameFor('/a', { gitName: async () => 'Sam\n\n  Rivera\tJr' }), 'Sam Rivera Jr');
});

test('a long name is truncated to the cap, not dropped', async () => {
  const name = await gitNameFor('/a', { gitName: async () => 'x'.repeat(MAX_NAME_CHARS + 50) });
  assert.equal(name, 'x'.repeat(MAX_NAME_CHARS));
});

test('a blank or null cwd is null without touching git', async () => {
  const gitName = async () => { throw new Error('should not run'); };
  assert.equal(await gitNameFor('', { gitName }), null);
  assert.equal(await gitNameFor(null, { gitName }), null);
});

// The real execFile path, against a dir whose name would split into two
// commands under a shell. It must return cleanly and run nothing.
test('the default impl is safe with a space and a ; in the cwd', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'git-id-'));
  const dir = path.join(parent, 'a b; touch pwned');
  fs.mkdirSync(dir);
  const name = await gitNameFor(dir);
  assert.ok(name === null || typeof name === 'string');
  assert.equal(fs.existsSync(path.join(parent, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
});
