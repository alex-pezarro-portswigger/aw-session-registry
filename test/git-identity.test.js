import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch, gitIdentity, _setGitBranchForTests, _setGitIdentityForTests } from '../lib/git-identity.js';

// A real repo whose path contains a `;` and a space: were this ever run through
// a shell, the path would split into two commands and the reads would fail.
function repo() {
  const dir = join(mkdtempSync(join(tmpdir(), 'gi-')), 'a b;echo x');
  mkdirSync(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'feature/x');
  g('config', 'user.name', '  Sam Rivera ');
  g('config', 'user.email', 'sam@example.com');
  g('commit', '-q', '--allow-empty', '-m', 'x');
  return { dir, g };
}

test('gitBranch reads the branch, trimmed, through an argv array', async () => {
  const { dir } = repo();
  assert.equal(await gitBranch(dir), 'feature/x');
});

test('gitBranch is null when detached, outside a repo, or without a cwd', async () => {
  const { dir, g } = repo();
  g('commit', '-q', '--allow-empty', '-m', 'x');
  g('checkout', '-q', '--detach');
  assert.equal(await gitBranch(dir), null);
  assert.equal(await gitBranch(mkdtempSync(join(tmpdir(), 'nogit-'))), null);
  assert.equal(await gitBranch(undefined), null);
});

test('gitIdentity trims, and is empty per field on failure', async () => {
  const { dir } = repo();
  assert.deepEqual(await gitIdentity(dir), { name: 'Sam Rivera', email: 'sam@example.com' });
  assert.deepEqual(await gitIdentity(join(dir, 'missing')), { name: '', email: '' });
});

test('the module never asks for a shell', () => {
  const src = readFileSync(new URL('../lib/git-identity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /shell:/);
  assert.match(src, /execFile\('git', args/);
});

test('the test seams install and reset, and a throwing seam never escapes', async () => {
  _setGitBranchForTests(async () => ' main ');
  _setGitIdentityForTests(async () => { throw new Error('boom'); });
  try {
    assert.equal(await gitBranch('/x'), ' main ');
    assert.deepEqual(await gitIdentity('/x'), { name: '', email: '' });
  } finally {
    _setGitBranchForTests(null);
    _setGitIdentityForTests(null);
  }
  assert.equal(await gitBranch(undefined), null);
});
