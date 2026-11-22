'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { createApp, syncLabel, suggestedChoice } = require('../src/server');
const { SyncInProgressError } = require('../src/sync');

async function start(t, { settings = {}, runSync = async () => [], lastSync = null, getNextRun, fileContents = {}, createAccounts, linkTransfers, openBudget } = {}) {
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
    getLastSync: () => lastSync,
    ...(getNextRun && { getNextRun }),
    upClient: {
      validate: async () => true,
      getAccounts: async () => [],
      getAccount: async (token, id) => ({ id, attributes: { createdAt: '2099-01-01T00:00:00+11:00' } }),
    },
    ...(createAccounts && { createAccounts }),
    ...(linkTransfers && { linkTransfers }),
    ...(openBudget && { openBudget }),
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

test('syncLabel reflects per-account errors', () => {
  assert.equal(syncLabel(null), 'Not yet synced');
  assert.equal(syncLabel({ ok: false, error: 'x' }), 'Needs attention');
  assert.equal(syncLabel({ ok: true, results: [{ errors: [] }] }), 'Completed');
  assert.equal(syncLabel({ ok: true, results: [{ errors: [] }, { errors: ['boom'] }] }), 'Completed with issues');
});

const configured = { UP: { token: 'tok' }, actual: { serverUrl: 'https://a.example', budgetId: 'b', apiKey: 'k' } };

test('overview points an unconfigured install at setup, and /link redirects there', async (t) => {
  const { base } = await start(t);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Get started/);
  assert.match(html, /<a href="\/setup">Connect Up and Actual<\/a>/);
  assert.match(html, /id="sync"[^>]*disabled/);
  const link = await fetch(`${base}/link`, { redirect: 'manual' });
  assert.equal(link.status, 302);
  assert.equal(link.headers.get('location'), '/setup?next=link');
  assert.match(await (await fetch(`${base}/setup?next=link`)).text(), /Connect Up Bank and your Actual budget first/);
});

test('overview linked count leaves out links the last sync found deleted in Up', async (t) => {
  const lastSync = { at: new Date().toISOString(), ok: true, results: [
    { upAccountId: 'u1', name: 'Spending', added: 0, updated: 0, transfers: 0, errors: [] },
    { upAccountId: 'u2', name: 'Old saver', added: 0, updated: 0, transfers: 0, goneFromUp: true, errors: ['gone'] },
  ] };
  const { base } = await start(t, { lastSync, fileContents: { ...configured, linkedAccounts: { u1: 'a1', u2: 'a2' } } });
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Linked accounts<\/span><strong>1<\/strong>/);
  assert.match(html, /1 no longer in Up/);
  assert.match(html, /Completed with issues/);
  assert.doesNotMatch(html, /Get started/);
});

test('overview shows the trigger, totals and next scheduled run', async (t) => {
  const lastSync = { at: '2026-11-22T01:00:00.000Z', ok: true, trigger: 'schedule', results: [
    { upAccountId: 'u1', name: 'Spending', added: 3, updated: 1, transfers: 0, errors: [] },
    { upAccountId: 'u2', name: 'Saver', added: 2, updated: 0, transfers: 0, errors: [] },
  ] };
  const { base } = await start(t, {
    lastSync,
    getNextRun: () => '2026-11-22T04:00:00.000Z',
    settings: { cronEnabled: true, cronSchedule: '0 */4 * * *' },
    fileContents: { ...configured, linkedAccounts: { u1: 'a1', u2: 'a2' } },
  });
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Scheduled sync/);
  assert.match(html, /id="stat-added">5</);
  assert.match(html, /Every 4 hours/);
  assert.match(html, /datetime="2026-11-22T04:00:00.000Z"/);
});

test('OFX preview is read-only and import reuses the server-side statement', async (t) => {
  const { statement } = require('./helpers/ofx');
  // This route test uses a small API stub; real import/transfer behavior is
  // exercised against Actual itself in ofxImport.test.js.
  let created = 0;
  const txns = [];
  let accounts = [];
  const api = {
    getAccounts: async () => accounts, getNote: async () => null, getCategories: async () => [], getPayees: async () => [],
    createAccount: async () => { created++; return 'ofx-created'; },
    addTransactions: async (account, rows) => { txns.push(...rows.map((r) => ({ ...r, account }))); },
    getTransactions: async () => txns, getAccountBalance: async () => 20000, sync: async () => {},
  };
  const { base, file } = await start(t, { openBudget: async (_a, _d, fn) => fn(api) });
  assert.equal((await fetch(`${base}/ofx`)).status, 200);
  const post = (url, data) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  let res = await post('/ofx/preview', { files: [{ content: Buffer.from(statement({ transactions: [{ amount: '10.00', memo: '<script>alert(1)</script>' }] })).toString('base64') }] });
  assert.equal(res.status, 400, 'tag-shaped memo is invalid scalar content');
  res = await post('/ofx/preview', { files: [{ content: Buffer.from(statement({ transactions: [{ amount: '10.00', memo: 'Credit Ref#123' }] })).toString('base64') }] });
  assert.equal(res.status, 200);
  const preview = await res.json();
  assert.equal(created, 0);
  assert.equal(preview.statements[0].transactions[0].imported, false);
  assert.equal(preview.statements[0].maskedAccount, '…ings');
  assert.equal(preview.statements[0].accountId, undefined);
  assert.equal((await post('/ofx/import', { token: 'unknown', choices: [] })).status, 400);
  const choices = [{ key: preview.statements[0].key, name: 'P&N Test', offbudget: false, closingBalance: '200.00' }];
  res = await post('/ofx/import', { token: preview.token, choices });
  assert.equal(res.status, 200);
  assert.equal(created, 1);
  assert.equal((await res.json()).accounts[0].added, 1);
  assert.equal((await post('/ofx/import', { token: preview.token, choices })).status, 400, 'successful previews cannot be replayed');
  accounts = [{ id: 'ofx-created', name: 'P&N Test' }];
  res = await post('/ofx/preview', { files: [{ content: Buffer.from(statement({ transactions: [{ amount: '10.00', memo: 'Credit Ref#123' }] })).toString('base64') }] });
  const again = (await res.json()).statements[0];
  assert.equal(again.saved.actualAccountId, 'ofx-created');
  assert.equal(again.transactions[0].imported, true, 'preview marks rows that are already in Actual');
  assert.match(fs.readFileSync(file, 'utf8'), /ofx-created/);
});

test('OFX routes reject cross-origin and malformed uploads before opening a budget', async (t) => {
  let opened = 0;
  const { base } = await start(t, { openBudget: async () => { opened++; } });
  const post = (body, extra = {}) => fetch(`${base}/ofx/preview`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ files: [] })).status, 400);
  assert.equal((await post({ files: [{ content: Buffer.from('not ofx').toString('base64') }] })).status, 400);
  assert.equal((await post({ files: [] }, { Origin: 'https://other.example' })).status, 403);
  assert.equal(opened, 0);
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

test('POST /link saves and removes one link, or the whole list', async (t) => {
  const { base, file } = await start(t);
  const post = (body) =>
    fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
  let res = await post({ account: 'up-1', accID: 'act-1' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/link?saved=1');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, { 'up-1': 'act-1' });
  await post({ account: 'up-1', accID: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, {});

  await post({ account: 'up-1', accID: 'act-1' });
  await post({ account: 'up-2', accID: 'act-2' });
  res = await post({ 'link:up-1': 'act-1', 'link:up-2': '' });
  assert.equal(res.headers.get('location'), '/link?saved=1', 'unchanged rows are not counted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, { 'up-1': 'act-1' });
  assert.equal((await post({})).status, 400);
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

function fakeCreate(calls) {
  return async (opts) => {
    calls.push(opts);
    return opts.upAccountIds.map((id) => ({ upAccountId: id, actualAccountId: `act-${id}`, name: `N-${id}`,
      offbudget: opts.offBudgetIds.includes(id), openingBalance: 100, openingDate: opts.startDate,
      imported: 2, transfers: 0, warnings: [] }));
  };
}

test('POST /accounts/add creates and links accounts in one go', async (t) => {
  const calls = [];
  const { base, file } = await start(t, { createAccounts: fakeCreate(calls), fileContents: { importFrom: { 'up-c': '2026-01-01' } } });
  const body = new URLSearchParams({
    'choice:up-a': 'create', 'choice:up-b': 'create-offbudget', 'choice:up-c': 'act-existing', 'choice:up-d': '',
    startDate: '2026-11-01',
  });
  const res = await fetch(`${base}/accounts/add`, { method: 'POST', body });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Also linked 1 existing account\./);
  assert.deepEqual(calls[0].upAccountIds, ['up-a', 'up-b']);
  assert.deepEqual(calls[0].offBudgetIds, ['up-b']);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.linkedAccounts, { 'up-a': 'act-up-a', 'up-b': 'act-up-b', 'up-c': 'act-existing' });
  // Linking an existing account drops any start date; created ones record theirs.
  assert.deepEqual(saved.importFrom, { 'up-a': '2026-11-01', 'up-b': '2026-11-01' });

  // Re-linking to a different Actual account drops the start date.
  await fetch(`${base}/link`, { method: 'POST', body: new URLSearchParams({ account: 'up-a', accID: 'other' }), redirect: 'manual' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).importFrom, { 'up-b': '2026-11-01' });
});

test('POST /accounts/add links existing accounts without creating any', async (t) => {
  const calls = [];
  const { base, file } = await start(t, { createAccounts: fakeCreate(calls) });
  const res = await fetch(`${base}/accounts/add`, { method: 'POST', body: new URLSearchParams({ 'choice:up-a': 'act-1' }), redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/link?saved=1');
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).linkedAccounts, { 'up-a': 'act-1' });
  const none = await fetch(`${base}/accounts/add`, { method: 'POST', body: new URLSearchParams({ 'choice:up-b': '' }), redirect: 'manual' });
  assert.equal(none.headers.get('location'), '/link');
});

test('POST /accounts/add shows errors with a way back to Accounts', async (t) => {
  const { base } = await start(t, { createAccounts: async () => { throw new Error('Invalid start date: x'); } });
  const res = await fetch(`${base}/accounts/add`, { method: 'POST', body: new URLSearchParams({ 'choice:up-a': 'create', startDate: 'x' }) });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Invalid start date/);
  assert.match(html, /href="\/link"[^>]*>Back to Accounts/);
});

test('suggestedChoice prefers a same-name Actual account, and only creates on first setup', () => {
  const actual = [{ id: 'a1', name: 'Spending' }, { id: 'a2', name: 'Bills' }];
  const up = (displayName, accountType = 'TRANSACTIONAL') => ({ displayName, accountType });
  assert.equal(suggestedChoice(up(' spending '), actual, new Set(), false), 'a1');
  assert.equal(suggestedChoice(up('Spending'), actual, new Set(['a1']), true), 'create');
  assert.equal(suggestedChoice(up('Home', 'HOME_LOAN'), actual, new Set(), true), 'create-offbudget');
  assert.equal(suggestedChoice(up('Kids saver'), actual, new Set(['a1']), false), '');
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

test('link existing transfers: preview, then confirm', async (t) => {
  const calls = [];
  const { base } = await start(t, {
    linkTransfers: async (opts) => {
      calls.push(opts.dryRun);
      return { pairs: 5, linked: 3, alreadyLinked: 2, skipped: 0 };
    },
  });
  const preview = await fetch(`${base}/transfers/preview`, { method: 'POST' });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Link 3 transfers/);
  const noConfirm = await fetch(`${base}/transfers/link`, { method: 'POST', redirect: 'manual' });
  assert.equal(noConfirm.status, 302);
  const done = await fetch(`${base}/transfers/link`, { method: 'POST', body: new URLSearchParams({ confirm: '1' }) });
  assert.match(await done.text(), /Linked 3 transfers/);
  assert.deepEqual(calls, [true, false]);
});
