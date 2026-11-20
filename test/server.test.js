'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { createApp } = require('../src/server');
const { SyncInProgressError } = require('../src/sync');

async function start(t, { settings = {}, runSync = async () => [], fileContents = {}, createAccounts } = {}) {
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
    upClient: {
      validate: async () => true,
      getAccounts: async () => [],
      getAccount: async (token, id) => ({ id, attributes: { createdAt: '2099-01-01T00:00:00+11:00' } }),
    },
    ...(createAccounts && { createAccounts }),
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

test('POST /accounts/create links new accounts and records the start date', async (t) => {
  let received;
  const { base, file } = await start(t, {
    createAccounts: async (opts) => {
      received = opts;
      return opts.upAccountIds.map((id, i) => ({
        upAccountId: id, actualAccountId: `act-${i}`, name: `N${i}`, offbudget: false,
        openingBalance: 100, openingDate: opts.startDate, imported: 2, warnings: [],
      }));
    },
  });
  const body = new URLSearchParams([['upAccountIds', 'up-a'], ['upAccountIds', 'up-b'], ['startDate', '2026-11-01']]);
  const res = await fetch(`${base}/accounts/create`, { method: 'POST', body });
  assert.equal(res.status, 200);
  assert.deepEqual(received.upAccountIds, ['up-a', 'up-b']);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.linkedAccounts, { 'up-a': 'act-0', 'up-b': 'act-1' });
  assert.deepEqual(saved.importFrom, { 'up-a': '2026-11-01', 'up-b': '2026-11-01' });

  // Re-linking to a different Actual account drops the start date.
  await fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams({ account: 'up-a', accID: 'other' }), redirect: 'manual' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).importFrom, { 'up-b': '2026-11-01' });
});

test('POST /accounts/create shows errors', async (t) => {
  const { base } = await start(t, { createAccounts: async () => { throw new Error('Invalid start date: x'); } });
  const res = await fetch(`${base}/accounts/create`, { method: 'POST', body: new URLSearchParams({ startDate: 'x' }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Invalid start date/);
});

test('choosing "create new" on the link page creates and links that account', async (t) => {
  let received;
  const { base, file } = await start(t, {
    createAccounts: async (opts) => {
      received = opts;
      return [{ upAccountId: 'up-new', actualAccountId: 'act-new', name: 'New', offbudget: false,
        openingBalance: 0, openingDate: opts.startDate, imported: 0, transfers: 0, warnings: [] }];
    },
  });
  const res = await fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams({ account: 'up-new', accID: '__create__' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(received.upAccountIds, ['up-new']);
  // The fake account opened "in 2099", so history starts from its open date.
  assert.equal(received.startDate, '2099-01-01');
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.linkedAccounts, { 'up-new': 'act-new' });
  assert.deepEqual(saved.importFrom, { 'up-new': '2099-01-01' });
});

test('off-budget choices are passed through from both create paths', async (t) => {
  const calls = [];
  const { base } = await start(t, {
    createAccounts: async (opts) => {
      calls.push(opts);
      return opts.upAccountIds.map((id) => ({ upAccountId: id, actualAccountId: `act-${id}`, name: id,
        offbudget: opts.offBudgetIds.includes(id), openingBalance: 0, openingDate: opts.startDate,
        imported: 0, transfers: 0, warnings: [] }));
    },
  });
  const bulk = new URLSearchParams([
    ['upAccountIds', 'a'], ['upAccountIds', 'b'], ['offBudgetIds', 'b'], ['offBudgetIds', 'not-selected'], ['startDate', '2026-11-01'],
  ]);
  assert.equal((await fetch(`${base}/accounts/create`, { method: 'POST', body: bulk })).status, 200);
  assert.deepEqual(calls[0].offBudgetIds, ['b']);

  await fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams({ account: 'c', accID: '__create_off_budget__' }) });
  assert.deepEqual([calls[1].upAccountIds, calls[1].offBudgetIds], [['c'], ['c']]);
  await fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams({ account: 'd', accID: '__create__' }) });
  assert.deepEqual(calls[2].offBudgetIds, []);
});

test('staleLinks lists links whose Up account is gone', () => {
  const { staleLinks } = require('../src/server');
  const stale = staleLinks(
    { 'up-a': 'act-a', 'up-gone': 'act-g', 'up-gone2': 'act-missing', 'up-unlinked': '' },
    [{ id: 'up-a' }, { id: 'up-unlinked' }],
    [{ id: 'act-a', name: 'A' }, { id: 'act-g', name: 'Old saver', closed: true }],
  );
  assert.deepEqual(stale, [
    { upId: 'up-gone', actualName: 'Old saver (closed)' },
    { upId: 'up-gone2', actualName: '(not in Actual)' },
  ]);
});
