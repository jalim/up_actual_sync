'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const init = require('../src/initialise');

const { useLocalBudget, txnsIn } = require('./helpers/localBudget');
const h = require('./helpers/up');

const budget = useLocalBudget(test);
const upTxn = (id, date, amount) => h.upTxn({ id, amount, at: `${date}T12:00:00+11:00` });
const upAccount = (id, balance, attrs = {}) => h.upAccount(id, balance, { displayName: 'Spending', ...attrs });

test('isValidDate rejects malformed and impossible dates', () => {
  assert.equal(init.isValidDate('2026-11-01'), true);
  assert.equal(init.isValidDate('2026-02-30'), false);
  assert.equal(init.isValidDate('2026-1-1'), false);
  assert.equal(init.isValidDate(''), false);
});

test('defaultStartDate is the first of the month', () => {
  assert.equal(init.defaultStartDate(new Date(2026, 10, 20)), '2026-11-01');
});

test('startDateFor uses the account open date when it is newer than the 1st', () => {
  const now = new Date(2026, 10, 20);
  assert.equal(init.startDateFor(upAccount('a', 0, { createdAt: '2026-11-12T09:00:00+11:00' }), now), '2026-11-12');
  assert.equal(init.startDateFor(upAccount('a', 0, { createdAt: '2024-01-01T09:00:00+11:00' }), now), '2026-11-01');
  assert.equal(init.startDateFor(undefined, now), '2026-11-01');
});

test('fetchSince starts a day early to cover AU timezones', () => {
  assert.equal(init.fetchSince('2026-11-01').toISOString(), '2026-10-31T00:00:00.000Z');
});

test('plan: opening balance + imported transactions = current balance', () => {
  const snap = {
    balance: 50000,
    txns: [upTxn('a', '2026-10-31', -999), upTxn('b', '2026-11-01', -2000), upTxn('c', '2026-11-05', 10000)],
  };
  const p = init.plan(snap, '2026-11-01');
  assert.deepEqual(p.transactions.map((t) => t.imported_id), ['b', 'c']); // 'a' is before the start date
  assert.deepEqual(p.upTxns.map((t) => t.id), ['b', 'c']);
  assert.equal(p.openingBalance, 50000 - (-2000 + 10000));
  assert.equal(p.openingBalance + p.transactions.reduce((s, t) => s + t.amount, 0), snap.balance);
});

test('openingBalanceDate moves out of the fuzzy-match window only on collision', () => {
  const txns = [{ amount: 500, date: '2026-11-03' }];
  assert.equal(init.openingBalanceDate('2026-11-01', 1000, txns), '2026-11-01');
  assert.equal(init.openingBalanceDate('2026-11-01', 500, txns), '2026-10-24');
  assert.equal(init.openingBalanceDate('2026-11-01', 500, [{ amount: 500, date: '2026-11-20' }]), '2026-11-01');
});

test('accountName marks 2Up accounts and avoids duplicates', () => {
  const taken = new Set(['spending']);
  assert.equal(init.accountName(upAccount('1', 0), taken), 'Spending 2');
  assert.equal(init.accountName(upAccount('2', 0, { ownershipType: 'JOINT' }), taken), 'Spending (2Up)');
  assert.equal(init.accountName(upAccount('3', 0), taken), 'Spending 3');
});

test('plan counts synthesised round-ups in the opening balance', () => {
  const purchase = h.upTxn({ amount: -1800, roundUp: -200, at: '2026-11-02T12:00:00+11:00' });
  const p = init.plan({ balance: 10000, txns: [purchase] }, '2026-11-01');
  assert.equal(p.transactions.length, 2);
  assert.equal(p.openingBalance, 12000);
});

function fakeUp(accounts, txnsById, balances = {}) {
  const calls = { getAccount: 0 };
  return {
    calls,
    getAccount: async (token, id) => {
      calls.getAccount++;
      const seq = balances[id];
      const acc = accounts.find((a) => a.id === id);
      if (seq?.length) {
        const { balance: _ignored, ...attrs } = acc.attributes;
        return upAccount(id, seq.shift(), attrs);
      }
      return acc;
    },
    getTransactions: async (token, id) => txnsById[id] || [],
  };
}

const create = (opts) =>
  init.createAccounts({ token: 'tok', actual: {}, startDate: '2026-11-01', today: '2026-11-20', openBudget: budget.openBudget, ...opts });

test('createAccounts creates, dates the opening balance, imports and verifies', async () => {
  await budget.api.createAccount({ name: 'Spending' }, 0); // force a name clash
  const up = fakeUp(
    [upAccount('up-1', 10000), upAccount('up-2', -500000, { displayName: 'Home', accountType: 'HOME_LOAN' })],
    { 'up-1': [upTxn('t1', '2026-11-02', -2500), upTxn('t0', '2026-10-31', -100)] },
  );
  const [spend, home] = await create({ upAccountIds: ['up-1', 'up-2'], upClient: up });
  assert.equal(spend.name, 'Spending 2');
  assert.equal(spend.openingBalance, 12500);
  assert.equal(spend.openingDate, '2026-11-01');
  assert.equal(spend.imported, 1);
  assert.deepEqual(spend.warnings, []);
  assert.equal(home.offbudget, true);
  assert.deepEqual(home.warnings, []);
  const t = await txnsIn(budget.api, spend.actualAccountId);
  assert.deepEqual(t.map((x) => [x.date, x.amount, !!x.starting_balance_flag]), [
    ['2026-11-01', 12500, true],
    ['2026-11-02', -2500, false],
  ]);
});

test('createAccounts links transfers and round-ups between accounts created together', async () => {
  const [out, inc] = h.upTransfer('up-s', 'up-v', 3000, '2026-11-05T10:00:00+11:00', '2026-11-05T10:00:01+11:00');
  const purchase = h.upTxn({ account: 'up-s', amount: -1800, roundUp: -200, at: '2026-11-06T10:00:00+11:00' });
  const credit = h.upTxn({ account: 'up-v', amount: 200, transferAccount: 'up-s', type: 'Round Up', at: '2026-11-06T10:00:02+11:00' });
  const up = fakeUp(
    [upAccount('up-s', 50000, { displayName: 'S' }), upAccount('up-v', 8000, { displayName: 'V', accountType: 'SAVER' })],
    { 'up-s': [out, purchase], 'up-v': [inc, credit] },
  );
  const [s, v] = await create({ upAccountIds: ['up-s', 'up-v'], upClient: up });
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(v.warnings, []);
  assert.equal(s.transfers, 2);
  assert.equal(v.transfers, 2);
  assert.equal(await budget.api.getAccountBalance(s.actualAccountId), 50000);
  assert.equal(await budget.api.getAccountBalance(v.actualAccountId), 8000);
});

test('createAccounts imports transfers to already-linked accounts as plain', async () => {
  const [, inc] = h.upTransfer('up-existing', 'up-new', 4000, '2026-11-05T10:00:00+11:00');
  const up = fakeUp([upAccount('up-new', 4000, { displayName: 'New' })], { 'up-new': [inc] });
  const [c] = await create({ upAccountIds: ['up-new'], upClient: up });
  const t = await txnsIn(budget.api, c.actualAccountId);
  assert.equal(t.length, 1);
  assert.equal(t[0].transfer_id, null);
  assert.equal(c.openingBalance, 0);
  assert.deepEqual(c.warnings, []);
});

test('createAccounts retries when the Up balance moves mid-read', async (t) => {
  t.mock.method(console, 'log', () => {});
  const up = fakeUp([upAccount('up-r', 300, { displayName: 'R' })], {}, { 'up-r': [100, 200, 300, 300] });
  const [c] = await create({ upAccountIds: ['up-r'], upClient: up });
  assert.equal(c.openingBalance, 300);
  assert.equal(up.calls.getAccount, 4);
});

test('createAccounts validates input before touching anything', async () => {
  const opts = { upAccountIds: ['a'], openBudget: () => assert.fail() };
  await assert.rejects(create({ ...opts, startDate: 'nope' }), /Invalid start date/);
  await assert.rejects(create({ ...opts, startDate: '2026-12-01' }), /future/);
  await assert.rejects(create({ ...opts, upAccountIds: [] }), /No Up accounts/);
  await assert.rejects(create({ ...opts, token: '' }), /token/);
});
