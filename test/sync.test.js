'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../src/sync');

const upTxn = (id, overrides = {}) => ({
  id,
  attributes: {
    createdAt: '2026-11-19T23:30:00+11:00',
    amount: { valueInBaseUnits: -1234 },
    description: 'Coffee Shop',
    status: 'SETTLED',
    ...overrides,
  },
});

test('mapTransaction maps Up fields to an Actual import transaction', () => {
  assert.deepEqual(sync.mapTransaction(upTxn('t1'), 'actual-1'), {
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
  const t = sync.mapTransaction(upTxn('t2', { createdAt: '2026-11-20T00:30:00+11:00' }), 'a');
  assert.equal(t.date, '2026-11-20');
});

test('held transactions are imported uncleared', () => {
  assert.equal(sync.mapTransaction(upTxn('t3', { status: 'HELD' }), 'a').cleared, false);
});

test('sinceDate subtracts days', () => {
  const d = sync.sinceDate(5, new Date('2026-11-20T12:00:00Z'));
  assert.equal(d.toISOString(), '2026-11-15T12:00:00.000Z');
});

function fakeBudget(accounts, importResult = { added: ['x'], updated: [], errors: [] }) {
  const calls = { imports: [], synced: false };
  const api = {
    getAccounts: async () => accounts,
    importTransactions: async (id, txns) => {
      calls.imports.push({ id, txns });
      return importResult;
    },
    sync: async () => {
      calls.synced = true;
    },
  };
  return { calls, openBudget: (actual, dir, fn) => fn(api) };
}

test('run imports each linked account and syncs', async () => {
  const { calls, openBudget } = fakeBudget([{ id: 'act-1', name: 'Spending' }]);
  const upClient = { getTransactions: async () => [upTxn('t1'), upTxn('t2')] };
  const results = await sync.run({
    token: 'tok',
    actual: {},
    linkedAccounts: { 'up-1': 'act-1', 'up-2': '' },
    dataDir: '/unused',
    syncDays: 5,
    upClient,
    openBudget,
  });
  assert.equal(calls.imports.length, 1);
  assert.equal(calls.imports[0].id, 'act-1');
  assert.equal(calls.imports[0].txns.length, 2);
  assert.ok(calls.synced);
  assert.deepEqual(results, [
    { upAccountId: 'up-1', actualAccountId: 'act-1', name: 'Spending', added: 1, updated: 0, errors: [] },
  ]);
});

test('run skips links to Actual accounts that no longer exist', async () => {
  const { calls, openBudget } = fakeBudget([]);
  const results = await sync.run({
    token: 'tok',
    actual: {},
    linkedAccounts: { 'up-1': 'gone' },
    syncDays: 5,
    upClient: { getTransactions: async () => [] },
    openBudget,
  });
  assert.equal(calls.imports.length, 0);
  assert.deepEqual(results[0].errors, ['Actual account not found']);
});

test('run does not open the budget if Up fails', async () => {
  let opened = false;
  await assert.rejects(
    sync.run({
      token: 'tok',
      actual: {},
      linkedAccounts: { 'up-1': 'act-1' },
      syncDays: 5,
      upClient: { getTransactions: async () => { throw new Error('up down'); } },
      openBudget: async () => { opened = true; },
    }),
    /up down/,
  );
  assert.equal(opened, false);
  assert.equal(sync.isRunning(), false);
});

test('run rejects concurrent syncs', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const args = {
    token: 'tok',
    actual: {},
    linkedAccounts: { 'up-1': 'act-1' },
    syncDays: 5,
    upClient: { getTransactions: async () => { await gate; return []; } },
    openBudget: fakeBudget([{ id: 'act-1', name: 'A' }]).openBudget,
  };
  const first = sync.run(args);
  assert.equal(sync.isRunning(), true);
  await assert.rejects(sync.run(args), sync.SyncInProgressError);
  release();
  await first;
  assert.equal(sync.isRunning(), false);
});

test('run requires a token', async () => {
  await assert.rejects(sync.run({ token: '', linkedAccounts: { a: 'b' } }), /token/);
});

test('run never imports transactions before an account\'s importFrom date', async () => {
  const { calls, openBudget } = fakeBudget([{ id: 'act-1', name: 'A' }]);
  await sync.run({
    token: 'tok',
    actual: {},
    linkedAccounts: { 'up-1': 'act-1' },
    importFrom: { 'up-1': '2026-11-19' },
    syncDays: 5,
    upClient: {
      getTransactions: async () => [
        upTxn('old', { createdAt: '2026-11-18T09:00:00+11:00' }),
        upTxn('new', { createdAt: '2026-11-19T09:00:00+11:00' }),
      ],
    },
    openBudget,
  });
  assert.deepEqual(calls.imports[0].txns.map((t) => t.imported_id), ['new']);
});
