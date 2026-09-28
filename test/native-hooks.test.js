import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { run } from '../skills/session-registry/hooks/native.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function checkout(root) {
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  for (const args of [
    ['init', '-q'], ['remote', 'add', 'origin', 'git@github.com:acme/app.git'],
    ['config', 'user.name', 'Sam'], ['config', 'user.email', 'sam@example.test'],
  ]) execFileSync('git', args, { cwd });
  return cwd;
}

test('native prompt hook gives the brief once and reminds at most three times', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = checkout(root);
  const env = { AW_SESSION_ID: 'card-1', AW_TASK_MEMORY: path.join(root, 'memory.md'),
    AW_DATA_DIR: root, SESSION_REGISTRY_URL: 'https://registry.example.test' };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ hookSpecificOutput: {
      additionalContext: '2 other sessions on acme/app\n    SendMessage to "peer-card"\n\nYou should set your intent with update_session_note now, before you edit, and\nPass messaging_handle from ListAgents.',
    } }) };
  };
  const first = JSON.parse(await run({ env, cwd })).hookSpecificOutput;
  assert.equal(first.hookEventName, 'UserPromptSubmit');
  assert.match(first.additionalContext, /2 other sessions on acme\/app/);
  assert.match(first.additionalContext, /send_peer_message to "peer-card"/);
  assert.doesNotMatch(first.additionalContext, /ListAgents|SendMessage to/);
  assert.match(first.additionalContext, /update_session_note/);
  assert.match(JSON.parse(await run({ env, cwd })).hookSpecificOutput.additionalContext, /update_session_note/);
  assert.match(JSON.parse(await run({ env, cwd })).hookSpecificOutput.additionalContext, /update_session_note/);
  assert.equal(await run({ env, cwd }), '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.example.test/v1/brief');
  assert.equal(calls[0].body.sessionId, 'card-1');
  assert.equal(calls[0].body.gitOriginUrl, 'git@github.com:acme/app.git');
  assert.equal(calls[0].body.onlyIfUnbriefed, true);
});

test('PostToolUse marker stops later native prompt reminders', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = checkout(root);
  const env = { AW_SESSION_ID: 'card-2', AW_TASK_MEMORY: path.join(root, 'memory.md'), AW_DATA_DIR: root };
  globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });
  assert.match(await run({ env, cwd }), /update_session_note/);
  assert.equal(await run({ mode: 'noted', env }), '');
  assert.equal(await run({ env, cwd }), '');
});

test('host config selects the same custom URL as extension tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = checkout(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ extensionSettings: {
    'peer-messaging': { registryUrl: 'https://custom.example.test' },
  } }));
  const env = { AW_SESSION_ID: 'card-3', AW_TASK_MEMORY: path.join(root, 'memory.md'), AW_DATA_DIR: root };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 204, json: async () => ({}) };
  };
  await run({ env, cwd });
  assert.deepEqual(calls, ['https://custom.example.test/v1/brief']);
});

test('a copied skill plugin runs without the extension host files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-native-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = checkout(root);
  const source = path.resolve('skills/session-registry');
  const copied = path.join(root, 'session-registry');
  fs.cpSync(source, copied, { recursive: true });
  const { run: copiedRun } = await import(pathToFileURL(path.join(copied, 'hooks', 'native.mjs')));
  globalThis.fetch = async () => ({ ok: true, status: 204 });
  const env = { AW_SESSION_ID: 'card-copy', AW_TASK_MEMORY: path.join(root, 'memory.md'), AW_DATA_DIR: root };
  assert.match(await copiedRun({ env, cwd }), /update_session_note/);
});
