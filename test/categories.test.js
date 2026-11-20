'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useLocalBudget, txnsIn } = require('./helpers/localBudget');
const { upTxn, upTransfer } = require('./helpers/up');
const { resolveCategories } = require('../src/categories');
const importer = require('../src/importer');
const sync = require('../src/sync');

const budget = useLocalBudget(test);
const api = () => budget.api;

const UP_CATEGORIES = [
  { id: 'home', attributes: { name: 'Home' }, relationships: { parent: { data: null } } },
  { id: 'good-life', attributes: { name: 'Good Life' }, relationships: { parent: { data: null } } },
  { id: 'groceries', attributes: { name: 'Groceries' }, relationships: { parent: { data: { id: 'home' } } } },
  { id: 'takeaway', attributes: { name: 'Takeaway' }, relationships: { parent: { data: { id: 'good-life' } } } },
];

const withCat = (t, cat) => ({ ...t, relationships: { ...t.relationships, category: { data: cat ? { id: cat } : null } } });
const NOW = Date.parse('2026-11-20T12:00:00+11:00');

async function income(name) {
  const group = (await api().getCategoryGroups()).find((g) => g.is_income);
  return api().createCategory({ name, group_id: group.id, is_income: true });
}

test('resolveCategories mirrors Up groups/categories once and reuses them', async () => {
  const first = await resolveCategories(api(), { upCategories: UP_CATEGORIES, usedUpIds: ['groceries', 'takeaway', 'groceries'], settings: { fromUp: true } });
  assert.deepEqual(first.created.sort(), ['Good Life', 'Good Life › Takeaway', 'Home', 'Home › Groceries'].sort());
  const again = await resolveCategories(api(), { upCategories: UP_CATEGORIES, usedUpIds: ['groceries'], settings: { fromUp: true } });
  assert.deepEqual(again.created, []);
  assert.equal(again.byUp.get('groceries'), first.byUp.get('groceries'));
});

test('resolveCategories does nothing for Up categories when fromUp is off, and warns on unknown transfer categories', async () => {
  const res = await resolveCategories(api(), {
    upCategories: UP_CATEGORIES, usedUpIds: ['groceries'], settings: { fromUp: false, transfers: { x: 'No Such Category' } },
  });
  assert.equal(res.byUp.size, 0);
  assert.match(res.warnings[0], /not found/);
});

test('sync assigns Up categories on on-budget accounts only, and never overrides a user category', async () => {
  const fam = await api().createAccount({ name: 'Fam' }, 0);
  const me = await api().createAccount({ name: 'Me', offbudget: true }, 0);
  const famTxn = withCat(upTxn({ amount: -1000, at: '2026-11-15T10:00:00+11:00' }), 'groceries');
  const meTxn = withCat(upTxn({ amount: -500, at: '2026-11-15T10:00:00+11:00' }), 'takeaway');
  const args = {
    token: 'tok', actual: {}, syncDays: 5, now: NOW, openBudget: budget.openBudget,
    linkedAccounts: { 'up-fam': fam, 'up-me': me },
    categorySettings: { fromUp: true },
    upClient: { getCategories: async () => UP_CATEGORIES, getTransactions: async (t, id) => (id === 'up-fam' ? [famTxn] : [meTxn]) },
  };
  await sync.run(args);
  const cats = await api().getCategories();
  const [f] = await txnsIn(api(), fam);
  const [m] = await txnsIn(api(), me);
  assert.equal(cats.find((c) => c.id === f.category)?.name, 'Groceries');
  assert.equal(m.category, null, 'off-budget transactions are not categorised');

  const mine = await income('Refunds');
  await api().updateTransaction(f.id, { category: mine });
  await sync.run(args);
  assert.equal((await txnsIn(api(), fam))[0].category, mine);
});

test('transfers across the budget boundary get the configured category on the on-budget half', async () => {
  const fam = await api().createAccount({ name: 'Fam2' }, 0);
  const me = await api().createAccount({ name: 'Me2', offbudget: true }, 0);
  const kid = await api().createAccount({ name: 'Kid2', offbudget: true }, 0);
  const contrib = await income('Contributions');
  const g = await api().createCategoryGroup({ name: 'Family' });
  const pocket = await api().createCategory({ name: 'Pocket Money', group_id: g });
  const [inOut, inIn] = upTransfer('up-me', 'up-fam', 5000, '2026-11-15T09:00:00+11:00');
  const [kOut, kIn] = upTransfer('up-fam', 'up-kid', 1000, '2026-11-15T09:30:00+11:00');
  const entries = [
    { upAccountId: 'up-me', actualAccountId: me, txns: [inOut] },
    { upAccountId: 'up-fam', actualAccountId: fam, txns: [inIn, kOut] },
    { upAccountId: 'up-kid', actualAccountId: kid, txns: [kIn] },
  ];
  const categories = await resolveCategories(api(), { settings: { transfers: { [me]: 'Contributions', [kid]: 'pocket money' } } });
  await importer.importAll(api(), entries, { now: NOW, categories });
  const famTx = await txnsIn(api(), fam);
  assert.equal(famTx.find((t) => t.amount === 5000).category, contrib, 'money in from personal account');
  assert.equal(famTx.find((t) => t.amount === -1000).category, pocket, 'money out to kid (outgoing side on-budget)');
  assert.equal((await txnsIn(api(), me))[0].category, null);
  assert.equal((await txnsIn(api(), kid))[0].category, null);
});

test('linkExistingTransfers applies the transfer category when none was set', async () => {
  const fam = await api().createAccount({ name: 'Fam3' }, 0);
  const kid = await api().createAccount({ name: 'Kid3', offbudget: true }, 0);
  const pocket = (await api().getCategories()).find((c) => c.name === 'Pocket Money').id;
  const { mapTransaction } = require('../src/mapping');
  const [out, inc] = upTransfer('up-fam', 'up-kid', 700, '2026-11-14T09:00:00+11:00');
  await api().importTransactions(fam, [mapTransaction(out, fam)]);
  await api().importTransactions(kid, [mapTransaction(inc, kid)]);
  const categories = await resolveCategories(api(), { settings: { transfers: { [kid]: 'Pocket Money' } } });
  await importer.linkExistingTransfers(api(), [
    { upAccountId: 'up-fam', actualAccountId: fam, txns: [out] },
    { upAccountId: 'up-kid', actualAccountId: kid, txns: [inc] },
  ], { categories });
  const [f] = await txnsIn(api(), fam);
  assert.ok(f.transfer_id);
  assert.equal(f.category, pocket);
});
