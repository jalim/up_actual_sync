'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initOptions, assertConfigured } = require('../src/actual');

const base = { serverUrl: 'https://a.example', budgetId: 'b' };

test('API key is sent as sessionToken and takes precedence over the password', () => {
  assert.deepEqual(initOptions({ ...base, apiKey: 'key', serverPassword: 'pw' }, '/d'), {
    dataDir: '/d',
    serverURL: 'https://a.example',
    sessionToken: 'key',
  });
});

test('password is used when there is no API key', () => {
  assert.deepEqual(initOptions({ ...base, serverPassword: 'pw' }, '/d'), {
    dataDir: '/d',
    serverURL: 'https://a.example',
    password: 'pw',
  });
});

test('either an API key or a password is required', () => {
  assert.doesNotThrow(() => assertConfigured({ ...base, apiKey: 'key' }));
  assert.doesNotThrow(() => assertConfigured({ ...base, serverPassword: 'pw' }));
  assert.throws(() => assertConfigured(base), /apiKey or serverPassword/);
  assert.throws(() => assertConfigured({ apiKey: 'key' }), /serverUrl, budgetId/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { newSessionDir, STALE_SESSION_MS } = require('../src/actual');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('each budget session gets its own new directory', async (t) => {
  const dataDir = tmp(t);
  const a = await newSessionDir(dataDir);
  const b = await newSessionDir(dataDir);
  assert.notEqual(a, b);
  assert.ok(fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory());
});

test('a new session never removes a recent session directory (late Actual writes land there)', async (t) => {
  const dataDir = tmp(t);
  const previous = await newSessionDir(dataDir);
  fs.mkdirSync(path.join(previous, 'Budget-123'));
  fs.writeFileSync(path.join(previous, 'Budget-123', 'metadata.json'), '{}');
  await newSessionDir(dataDir, Date.now() + 60 * 1000); // next session a minute later
  assert.ok(fs.existsSync(path.join(previous, 'Budget-123', 'metadata.json')));
});

test('stale session directories and leftovers from older versions are cleaned up', async (t) => {
  const dataDir = tmp(t);
  const old = await newSessionDir(dataDir, Date.now() - STALE_SESSION_MS - 1000);
  const legacy = path.join(dataDir, 'My-Finances-80aef17');
  fs.mkdirSync(legacy);
  const past = new Date(Date.now() - STALE_SESSION_MS - 1000);
  fs.utimesSync(legacy, past, past);
  const current = await newSessionDir(dataDir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(legacy), false);
  assert.ok(fs.existsSync(current));
});
