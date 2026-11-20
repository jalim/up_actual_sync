'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { createApp } = require('../src/server');
const { SyncInProgressError } = require('../src/sync');

async function start(t, { settings = {}, runSync = async () => [], fileContents = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(fileContents));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const store = config.load(file);
  const app = createApp({
    store,
    settings: { ...config.settings(store), ...settings },
    runSync,
    getLastSync: () => null,
    upClient: { validate: async () => true, getAccounts: async () => [] },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, file };
}

test('index and setup render', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const setup = await fetch(`${base}/setup`);
  assert.equal(setup.status, 200);
});

test('setup page never echoes saved secrets', async (t) => {
  const { base } = await start(t, {
    fileContents: {
      UP: { token: 'up:yeah:SECRET_TOKEN' },
      actual: { serverUrl: 'https://a.example', serverPassword: 'SECRET_PW', apiKey: 'SECRET_KEY', budgetEncryption: 'SECRET_ENC', budgetId: 'b' },
    },
  });
  const html = await (await fetch(`${base}/setup`)).text();
  assert.doesNotMatch(html, /SECRET_/);
  assert.match(html, /https:\/\/a\.example/);
  assert.match(html, /Saved \(leave blank to keep\)/);
});

test('POST /sync returns results, 409 when busy, 500 on failure', async (t) => {
  let mode = 'ok';
  const { base } = await start(t, {
    runSync: async () => {
      if (mode === 'busy') throw new SyncInProgressError();
      if (mode === 'fail') throw new Error('kaboom');
      return [{ name: 'A', added: 1, updated: 0, errors: [] }];
    },
  });
  let res = await fetch(`${base}/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results.length, 1);
  mode = 'busy';
  assert.equal((await fetch(`${base}/sync`, { method: 'POST' })).status, 409);
  mode = 'fail';
  res = await fetch(`${base}/sync`, { method: 'POST' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'kaboom');
});

test('cross-origin POSTs are rejected', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/sync`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('POST /link saves and removes links', async (t) => {
  const { base, file } = await start(t);
  const post = (body) =>
    fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  assert.equal((await post({ account: 'up-1', accID: 'act-1' })).status, 302);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, { 'up-1': 'act-1' });
  await post({ account: 'up-1', accID: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, {});
});

test('basic auth is enforced when configured', async (t) => {
  const { base } = await start(t, { settings: { webUIUsername: 'me', webUIPassword: 'pw' } });
  assert.equal((await fetch(`${base}/`)).status, 401);
  const bad = Buffer.from('me:nope').toString('base64');
  assert.equal((await fetch(`${base}/`, { headers: { Authorization: `Basic ${bad}` } })).status, 401);
  const good = Buffer.from('me:pw').toString('base64');
  assert.equal((await fetch(`${base}/`, { headers: { Authorization: `Basic ${good}` } })).status, 200);
});

test('setup requires an Actual API key or password', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/setup`, {
    method: 'POST',
    body: new URLSearchParams({ token: 't', serverUrl: 'https://a.example', budgetId: 'b' }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /API key or server password/);
});
