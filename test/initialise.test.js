'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const init = require('../src/initialise');

const upTxn = (id, date, amount) => ({
  id,
  attributes: {
    createdAt: `${date}T12:00:00+11:00`,
    amount: { valueInBaseUnits: amount },
    description: `txn ${id}`,
    status: 'SETTLED',
  },
});

const upAccount = (id, balance, attrs = {}) => ({
  id,
  attributes: {
    displayName: 'Spending',
    accountType: 'TRANSACTIONAL',
    ownershipType: 'INDIVIDUAL',
    balance: { valueInBaseUnits: balance },
    ...attrs,
  },
});

test('isValidDate rejects malformed and impossible dates', () => {
  assert.equal(init.isValidDate('2026-11-01'), true);
  assert.equal(init.isValidDate('2026-02-30'), false);
  assert.equal(init.isValidDate('2026-1-1'), false);
  assert.equal(init.isValidDate(''), false);
});

test('defaultStartDate is the first of the month', () => {
  assert.equal(init.defaultStartDate(new Date(2026, 10, 20)), '2026-11-01');
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

function fakeApi({ existing = [], balanceOverride } = {}) {
  const state = { accounts: [...existing], txns: [], synced: false, nextId: 1 };
  const api = {
    getAccounts: async () => state.accounts,
    createAccount: async ({ name, offbudget }, initial) => {
      const id = `act-${state.nextId++}`;
      state.accounts.push({ id, name, offbudget });
      if (initial) state.txns.push({ id: `sb-${id}`, account: id, amount: initial, date: '2026-11-20', starting: true });
      return id;
    },
    getTransactions: async (id) => state.txns.filter((t) => t.account === id),
    updateTransaction: async (id, fields) => Object.assign(state.txns.find((t) => t.id === id), fields),
    importTransactions: async (id, txns) => {
      state.txns.push(...txns.map((t) => ({ ...t, id: t.imported_id })));
      return { added: txns.map((t) => t.imported_id), updated: [], errors: [] };
    },
    getAccountBalance: async (id) =>
      balanceOverride ?? state.txns.filter((t) => t.account === id).reduce((s, t) => s + t.amount, 0),
    sync: async () => {
      state.synced = true;
    },
  };
  return { state, openBudget: (actual, dir, fn) => fn(api) };
}

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

test('createAccounts creates, dates the opening balance, imports and verifies', async () => {
  const { state, openBudget } = fakeApi({ existing: [{ id: 'x', name: 'Spending' }] });
  const up = fakeUp(
    [upAccount('up-1', 10000), upAccount('up-2', 500000, { displayName: 'Home', accountType: 'HOME_LOAN' })],
    { 'up-1': [upTxn('t1', '2026-11-02', -2500), upTxn('t0', '2026-10-31', -100)] },
  );
  const created = await init.createAccounts({
    token: 'tok',
    actual: {},
    upAccountIds: ['up-1', 'up-2'],
    startDate: '2026-11-01',
    today: '2026-11-20',
    upClient: up,
    openBudget,
  });
  assert.equal(created.length, 2);
  const [spend, home] = created;
  assert.equal(spend.name, 'Spending 2');
  assert.equal(spend.openingBalance, 12500);
  assert.equal(spend.openingDate, '2026-11-01');
  assert.equal(spend.imported, 1);
  assert.deepEqual(spend.warnings, []);
  assert.equal(home.offbudget, true);
  const sb = state.txns.find((t) => t.starting && t.account === spend.actualAccountId);
  assert.equal(sb.date, '2026-11-01');
  assert.ok(state.synced);
});

test('createAccounts warns when the Actual balance does not match Up', async () => {
  const { openBudget } = fakeApi({ balanceOverride: 1 });
  const up = fakeUp([upAccount('up-1', 10000)], {});
  const [c] = await init.createAccounts({
    token: 'tok', actual: {}, upAccountIds: ['up-1'], startDate: '2026-11-01', today: '2026-11-20', upClient: up, openBudget,
  });
  assert.match(c.warnings[0], /does not match/);
});

test('createAccounts retries when the Up balance moves mid-read', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { openBudget } = fakeApi();
  const up = fakeUp([upAccount('up-1', 300)], {}, { 'up-1': [100, 200, 300, 300] });
  const [c] = await init.createAccounts({
    token: 'tok', actual: {}, upAccountIds: ['up-1'], startDate: '2026-11-01', today: '2026-11-20', upClient: up, openBudget,
  });
  assert.equal(c.openingBalance, 300);
  assert.equal(up.calls.getAccount, 4);
});

test('createAccounts validates input before touching anything', async () => {
  const opts = { token: 'tok', actual: {}, upAccountIds: ['a'], today: '2026-11-20', openBudget: () => assert.fail() };
  await assert.rejects(init.createAccounts({ ...opts, startDate: 'nope' }), /Invalid start date/);
  await assert.rejects(init.createAccounts({ ...opts, startDate: '2026-12-01' }), /future/);
  await assert.rejects(init.createAccounts({ ...opts, startDate: '2026-11-01', upAccountIds: [] }), /No Up accounts/);
  await assert.rejects(init.createAccounts({ ...opts, token: '', startDate: '2026-11-01' }), /token/);
});
