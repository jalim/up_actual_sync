'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/sync');
const { useLocalBudget, txnsIn } = require('./helpers/localBudget');
const { upTxn, upTransfer } = require('./helpers/up');

const budget = useLocalBudget(test);

test('mapTransaction maps Up fields to an Actual import transaction', () => {
  const t = upTxn({ id: 't1', amount: -1234, description: 'Coffee Shop', at: '2026-11-19T23:30:00+11:00' });
  assert.deepEqual(sync.mapTransaction(t, 'actual-1'), {
    account: 'actual-1',
    date: '2026-11-19',
    amount: -1234,
    payee_name: 'Coffee Shop',
    imported_payee: 'Coffee Shop',
    notes: 'Coffee Shop',
    imported_id: 't1',
    cleared: true,
  });
});

test('mapTransaction keeps the local date for late-night transactions', () => {
  // 00:30 local on the 20th is 13:30Z on the 19th; Actual should see the 20th.
  const t = sync.mapTransaction(upTxn({ amount: 1, at: '2026-11-20T00:30:00+11:00' }), 'a');
  assert.equal(t.date, '2026-11-20');
});

test('held transactions are imported uncleared', () => {
  assert.equal(sync.mapTransaction(upTxn({ amount: 1, status: 'HELD' }), 'a').cleared, false);
});

test('sinceDate subtracts days', () => {
  const d = sync.sinceDate(5, new Date('2026-11-20T12:00:00Z'));
  assert.equal(d.toISOString(), '2026-11-15T12:00:00.000Z');
});

const fakeUp = (byAccount) => ({ getTransactions: async (token, id) => byAccount[id] || [] });
const NOW = Date.parse('2026-11-20T12:00:00+11:00');

function args(overrides) {
  return { token: 'tok', actual: {}, syncDays: 5, openBudget: budget.openBudget, now: NOW, ...overrides };
}

test('run imports each linked account, links transfers, and reports per account', async () => {
  const spend = await budget.api.createAccount({ name: 'Spending' }, 0);
  const saver = await budget.api.createAccount({ name: 'Saver' }, 0);
  const [out, inc] = upTransfer('up-1', 'up-2', 1000);
  const results = await sync.run(
    args({
      linkedAccounts: { 'up-1': spend, 'up-2': saver, 'up-3': '' },
      upClient: fakeUp({ 'up-1': [upTxn({ amount: -250 }), out], 'up-2': [inc] }),
    }),
  );
  assert.deepEqual(
    results.map((r) => [r.name, r.added, r.transfers, r.errors.length]),
    [
      ['Spending', 2, 1, 0],
      ['Saver', 1, 1, 0],
    ],
  );
  assert.equal(await budget.api.getAccountBalance(spend), -1250);
  assert.equal(await budget.api.getAccountBalance(saver), 1000);
});

test('run skips links to Actual accounts that no longer exist', async () => {
  const results = await sync.run(
    args({ linkedAccounts: { 'up-1': 'gone' }, upClient: fakeUp({ 'up-1': [upTxn({ amount: -1 })] }) }),
  );
  assert.deepEqual(results[0].errors, ['Actual account not found']);
});

test('run does not open the budget if Up fails', async () => {
  let opened = false;
  await assert.rejects(
    sync.run(
      args({
        linkedAccounts: { 'up-1': 'act-1' },
        upClient: { getTransactions: async () => { throw new Error('up down'); } },
        openBudget: async () => { opened = true; },
      }),
    ),
    /up down/,
  );
  assert.equal(opened, false);
  assert.equal(sync.isRunning(), false);
});

test('run rejects concurrent syncs', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const a = args({
    linkedAccounts: { 'up-1': 'act-1' },
    upClient: { getTransactions: async () => { await gate; return []; } },
    openBudget: async () => [],
  });
  const first = sync.run(a);
  assert.equal(sync.isRunning(), true);
  await assert.rejects(sync.run(a), sync.SyncInProgressError);
  release();
  await first;
  assert.equal(sync.isRunning(), false);
});

test('run requires a token', async () => {
  await assert.rejects(sync.run({ token: '', linkedAccounts: { a: 'b' } }), /token/);
});

test("run never imports transactions before an account's importFrom date", async () => {
  const acct = await budget.api.createAccount({ name: 'From' }, 0);
  await sync.run(
    args({
      linkedAccounts: { 'up-1': acct },
      importFrom: { 'up-1': '2026-11-19' },
      upClient: fakeUp({
        'up-1': [
          upTxn({ id: 'old', amount: -1, at: '2026-11-18T09:00:00+11:00' }),
          upTxn({ id: 'new', amount: -2, at: '2026-11-19T09:00:00+11:00' }),
        ],
      }),
    }),
  );
  assert.deepEqual((await txnsIn(budget.api, acct)).map((t) => t.imported_id), ['new']);
});

test('a deleted Up account is reported but does not stop the other accounts syncing', async () => {
  const { UpApiError } = require('../src/upBank');
  const ok = await budget.api.createAccount({ name: 'Still here' }, 0);
  const gone = await budget.api.createAccount({ name: 'Old saver' }, 0);
  const results = await sync.run(
    args({
      linkedAccounts: { 'up-ok': ok, 'up-gone': gone },
      upClient: {
        getTransactions: async (token, id) => {
          if (id === 'up-gone') throw new UpApiError('Up API 404: The requested account does not exist.', 404);
          return [upTxn({ amount: -900 })];
        },
      },
    }),
  );
  assert.equal(await budget.api.getAccountBalance(ok), -900);
  const r = results.find((x) => x.upAccountId === 'up-gone');
  assert.equal(r.name, 'Old saver');
  assert.match(r.errors[0], /no longer exists/);
  assert.equal(r.goneFromUp, true);
});

test('other Up errors still fail the sync', async () => {
  const { UpApiError } = require('../src/upBank');
  await assert.rejects(
    sync.run(args({
      linkedAccounts: { 'up-1': 'x' },
      upClient: { getTransactions: async () => { throw new UpApiError('Up API 500', 500); } },
    })),
    /500/,
  );
});

test('a failure in OFX transfer matching does not fail the Up sync', async (t) => {
  const ofxImport = require('../src/ofxImport');
  t.mock.method(ofxImport, 'reconcileTransfers', async () => { throw new Error('boom'); });
  t.mock.method(console, 'error', () => {});
  // sync.js captured reconcileTransfers at require time; reload it to pick up the mock.
  delete require.cache[require.resolve('../src/sync')];
  const freshSync = require('../src/sync');
  t.after(() => { delete require.cache[require.resolve('../src/sync')]; });
  const acct = await budget.api.createAccount({ name: 'OFX-safe' }, 0);
  const results = await freshSync.run(args({
    linkedAccounts: { 'up-1': acct },
    ofxAccounts: { k: { actualAccountId: acct, start: '2026-11-01' } },
    upClient: fakeUp({ 'up-1': [upTxn({ amount: -321 })] }),
  }));
  assert.equal(await budget.api.getAccountBalance(acct), -321);
  const warn = results.find((r) => r.name === 'P&N transfer matching');
  assert.match(warn.errors[0], /OFX transfer matching failed: boom/);
});
