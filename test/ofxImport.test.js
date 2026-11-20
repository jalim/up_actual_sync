'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useLocalBudget, txnsIn } = require('./helpers/localBudget');
const { parse } = require('../src/ofx');
const { importStatements, reconcileTransfers } = require('../src/ofxImport');
const { statement } = require('./helpers/ofx');

const budget = useLocalBudget(test);
const create = (options) => parse(statement(options))[0];
const choicesFor = (statements) => statements.map((s) => ({ key: s.key, name: `${s.accountId}-${Math.random()}`,
  closingBalance: (s.suggestedBalance / 100).toFixed(2), offbudget: s.loan }));
async function run(statements, mappings = {}, choices = choicesFor(statements), upAccountIds = []) {
  const result = await importStatements(budget.api, { statements, mappings, choices, upAccountIds, saveMappings: async () => {} });
  return { result, mappings, choices };
}

test('creates accounts, derives balances, links internal transfers and safely reimports', async () => {
  const sav = create({ account: 'savings-A', balance: '200.00', transactions: [
    { amount: '50.00', memo: 'Transfer from HL Ref#987' },
    { amount: '-10.00', memo: 'Purchase Ref#988' },
    { amount: '-10.00', memo: 'Purchase Ref#989' },
  ] });
  const loan = create({ account: 'loan-A', balance: '1000.00', transactions: [
    { amount: '-50.00', memo: 'Loan Redraw to SAV Ref#987' },
  ] });
  const { result, mappings, choices } = await run([sav, loan]);
  assert.equal(result.linked, 1);
  assert.ok(result.accounts.every((a) => a.balanceMatches));
  const sa = mappings[sav.key].actualAccountId;
  const la = mappings[loan.key].actualAccountId;
  const ts = await txnsIn(budget.api, sa);
  const tl = await txnsIn(budget.api, la);
  const a = ts.find((t) => t.amount === 5000);
  const b = tl.find((t) => t.amount === -5000);
  assert.equal(a.transfer_id, b.id);
  assert.equal(b.transfer_id, a.id);
  assert.equal(await budget.api.getAccountBalance(sa), 20000);
  assert.equal(await budget.api.getAccountBalance(la), -100000);
  assert.equal(ts.length, 4, 'same-amount purchases must both survive');
  assert.ok(ts.find((t) => t.imported_id?.startsWith('ofx-opening:')).category, 'opening balance is assigned to an income category');
  const again = await run([sav, loan], mappings, choices);
  assert.equal(again.result.linked, 0);
  assert.ok(again.result.accounts.every((a) => a.added === 0));
  assert.equal((await txnsIn(budget.api, sa)).length, 4);
  assert.equal((await txnsIn(budget.api, la)).length, 2);
});

test('separate uploads match previously imported transfer halves', async () => {
  const a = create({ account: 'separate-a', transactions: [{ amount: '20.00', memo: 'Transfer from HL Ref#567' }] });
  const b = create({ account: 'separate-b', transactions: [{ amount: '-20.00', memo: 'Loan Redraw to SAV Ref#567' }] });
  const first = await run([a]);
  assert.equal(first.result.linked, 0);
  const second = await run([b], first.mappings);
  assert.equal(second.result.linked, 1);
  assert.equal(second.result.review.length, 0);
});

test('earlier history adjusts the opening balance once and repeat uploads do not drift', async () => {
  const newer = create({ account: 'history-a', start: '20261010', transactions: [{ amount: '20.00', memo: 'Credit Ref#444' }] });
  const first = await run([newer]);
  const earlier = create({ account: 'history-a', start: '20261001', transactions: [
    { amount: '10.00', date: '20261002', memo: 'Credit Ref#333' }, { amount: '20.00', memo: 'Credit Ref#444' },
  ] });
  await run([earlier], first.mappings, first.choices);
  await run([earlier], first.mappings, first.choices);
  const id = first.mappings[newer.key].actualAccountId;
  assert.equal(await budget.api.getAccountBalance(id), 20000);
  assert.equal((await txnsIn(budget.api, id)).length, 3);
});

test('Up transfers link existing bank entries and preserve their IDs and dates', async () => {
  const up = await budget.api.createAccount({ name: 'Up external test' }, 0);
  await budget.api.addTransactions(up, [{ date: '2026-10-11', amount: 10000, payee_name: 'From P&N',
    imported_payee: 'From P&N', imported_id: 'up-existing-uuid', cleared: true }]);
  const s = create({ account: 'up-transfer-test', transactions: [{ amount: '-100.00', memo: 'Osko Payment To BBL - Up Ref#222' }] });
  const choices = choicesFor([s]);
  choices[0].upAccountId = up;
  const { result, mappings } = await run([s], {}, choices, [up]);
  assert.equal(result.linked, 1);
  const upRows = await txnsIn(budget.api, up);
  assert.equal(upRows.length, 1);
  assert.equal(upRows[0].imported_id, 'up-existing-uuid');
  assert.equal(upRows[0].date, '2026-10-11');
  assert.ok(upRows[0].transfer_id);
  assert.equal((await reconcileTransfers(budget.api, mappings, [up])).linked, 0);
});

test('ambiguous Up matches remain unlinked and a later sync can link a unique match', async () => {
  const up = await budget.api.createAccount({ name: 'Up late test' }, 0);
  const s = create({ account: 'up-late-test', transactions: [{ amount: '-100.00', memo: 'Osko Payment To BBL - Up Ref#777' }] });
  const choices = choicesFor([s]);
  choices[0].upAccountId = up;
  const { mappings } = await run([s], {}, choices, [up]);
  await budget.api.addTransactions(up, [1, 2].map((n) => ({ date: '2026-10-10', amount: 10000,
    imported_payee: 'From P&N', imported_id: `up-late-${n}` })));
  assert.equal((await reconcileTransfers(budget.api, mappings, [up])).linked, 0);
  const rows = await txnsIn(budget.api, up);
  await budget.api.deleteTransaction(rows[0].id);
  assert.equal((await reconcileTransfers(budget.api, mappings, [up])).linked, 1);
});

test('OFX attaches to a P&N transfer half already created by Up, without another transaction', async () => {
  const up = await budget.api.createAccount({ name: 'Up preexisting transfer' }, 0);
  const pn = await budget.api.createAccount({ name: 'P&N preexisting transfer' }, 0);
  const payee = (await budget.api.getPayees()).find((p) => p.transfer_acct === pn).id;
  await budget.api.addTransactions(up, [{ date: '2026-10-09', amount: -10000, imported_id: 'up-before-ofx', payee, cleared: true }], { runTransfers: true });
  const [upBefore] = await txnsIn(budget.api, up);
  const s = create({ account: 'preexisting-transfer', balance: '100.00', transactions: [{ amount: '100.00', memo: 'Osko Payment From Up Ref#654' }] });
  const choices = choicesFor([s]);
  choices[0].actualAccountId = pn;
  const { result, mappings } = await run([s], {}, choices, [up]);
  assert.equal(result.accounts[0].added, 0);
  assert.equal(result.accounts[0].attached, 1);
  const rows = await txnsIn(budget.api, pn);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, upBefore.transfer_id);
  assert.equal(rows[0].imported_id, s.transactions[0].imported_id);
  assert.equal(rows[0].date, '2026-10-10');
  assert.equal(rows[0].transfer_id, upBefore.id);
  assert.equal((await txnsIn(budget.api, up))[0].imported_id, 'up-before-ofx');
  await run([s], mappings, choices, [up]);
  assert.equal((await txnsIn(budget.api, pn)).length, 1);
  assert.equal((await txnsIn(budget.api, up)).length, 1);
});

test('a transfer created by Up after OFX import merges its duplicate P&N half', async () => {
  const up = await budget.api.createAccount({ name: 'Up rule after OFX' }, 0);
  const s = create({ account: 'ofx-before-up-rule', balance: '100.00', transactions: [{ amount: '100.00', memo: 'Osko Payment From Up Ref#765' }] });
  const { mappings } = await run([s]);
  const pn = mappings[s.key].actualAccountId;
  const bankBefore = (await txnsIn(budget.api, pn)).find((t) => t.imported_id === s.transactions[0].imported_id);
  const payee = (await budget.api.getPayees()).find((p) => p.transfer_acct === pn).id;
  await budget.api.addTransactions(up, [{ date: '2026-10-09', amount: -10000, imported_id: 'up-after-ofx', payee }], { runTransfers: true });
  assert.equal((await reconcileTransfers(budget.api, mappings, [up])).linked, 1);
  const bankAfter = (await txnsIn(budget.api, pn)).find((t) => t.id === bankBefore.id);
  assert.ok(bankAfter.transfer_id);
  assert.equal(bankAfter.date, '2026-10-10');
  assert.equal((await txnsIn(budget.api, pn)).length, 2, 'only opening balance and one transfer');
  assert.equal((await txnsIn(budget.api, up)).length, 1);
  assert.equal(await budget.api.getAccountBalance(pn), 10000);
});

test('ambiguous existing Up-created halves defer OFX entries instead of duplicating them', async () => {
  const up = await budget.api.createAccount({ name: 'Up ambiguous generated' }, 0);
  const pn = await budget.api.createAccount({ name: 'P&N ambiguous generated' }, 0);
  const payee = (await budget.api.getPayees()).find((p) => p.transfer_acct === pn).id;
  await budget.api.addTransactions(up, [1, 2].map((n) => ({ date: '2026-10-10', amount: -10000,
    imported_id: `up-ambiguous-${n}`, payee })), { runTransfers: true });
  const s = create({ account: 'ambiguous-generated', transactions: [{ amount: '100.00', memo: 'Osko Payment From Up Ref#876' }] });
  const choices = choicesFor([s]);
  choices[0].actualAccountId = pn;
  const { result } = await run([s], {}, choices, [up]);
  assert.equal(result.accounts[0].added, 0);
  assert.equal(result.accounts[0].deferred.length, 1);
  assert.equal((await txnsIn(budget.api, pn)).length, 2);
});

test('cross-budget transfer keeps the selected category only on the on-budget side', async () => {
  const group = await budget.api.createCategoryGroup({ name: 'Test transfer categories' });
  const category = await budget.api.createCategory({ name: 'Loan redraw', group_id: group });
  const a = create({ account: 'category-savings', transactions: [{ amount: '50.00', memo: 'Transfer from HL Ref#543' }] });
  const b = create({ account: 'category-loan', transactions: [{ amount: '-50.00', memo: 'Loan Redraw to SAV Ref#543' }] });
  const choices = choicesFor([a, b]);
  choices[1].transferCategoryId = category;
  const { mappings } = await run([a, b], {}, choices);
  const sa = (await txnsIn(budget.api, mappings[a.key].actualAccountId)).find((t) => t.amount === 5000);
  const lo = (await txnsIn(budget.api, mappings[b.key].actualAccountId)).find((t) => t.amount === -5000);
  assert.equal(sa.category, category);
  assert.equal(lo.category, null);
});

test('a failed merge can be retried without leaving a duplicate Up half', async () => {
  const up = await budget.api.createAccount({ name: 'Up interrupted merge' }, 0);
  await budget.api.addTransactions(up, [{ date: '2026-10-10', amount: 10000, imported_payee: 'P&N',
    imported_id: 'up-merge-retry', cleared: true }]);
  const s = create({ account: 'merge-retry', transactions: [{ amount: '-100.00', memo: 'Osko Payment To Up Ref#665' }] });
  const choices = choicesFor([s]);
  choices[0].upAccountId = up;
  const mappings = {};
  const failing = new Proxy(budget.api, { get: (api, key) => key === 'mergeTransactions' ? async () => { throw new Error('test interruption'); } : api[key] });
  await assert.rejects(importStatements(failing, { statements: [s], choices, mappings, upAccountIds: [up], saveMappings: async () => {} }), /test interruption/);
  assert.equal((await txnsIn(budget.api, up)).length, 2, 'interruption leaves the generated half to recover');
  const { result } = await run([s], mappings, choices, [up]);
  assert.equal(result.accounts[0].added, 0);
  assert.equal((await txnsIn(budget.api, up)).length, 1);
  assert.equal((await txnsIn(budget.api, up))[0].imported_id, 'up-merge-retry');
  assert.ok((await txnsIn(budget.api, up))[0].transfer_id);
});

test('historical statement balance checks exclude newer transactions already in Actual', async () => {
  const id = await budget.api.createAccount({ name: 'Historical balance check' }, 0);
  await budget.api.addTransactions(id, [{ date: '2026-11-01', amount: 5000, imported_id: 'newer-bank-entry' }]);
  const s = create({ account: 'historical-balance', balance: '100.00', transactions: [{ amount: '100.00', memo: 'Credit Ref#991' }] });
  const choices = choicesFor([s]);
  choices[0].actualAccountId = id;
  const { result } = await run([s], {}, choices);
  assert.equal(result.accounts[0].actualBalance, 10000);
  assert.equal(result.accounts[0].balanceMatches, true);
  assert.equal(await budget.api.getAccountBalance(id), 15000);
});

test('linking an existing account with history only imports from the chosen date, on every later upload', async () => {
  const id = await budget.api.createAccount({ name: 'Existing P&N with history' }, 0);
  await budget.api.addTransactions(id, [{ date: '2026-10-05', amount: 2000, payee_name: 'Entered by hand' }]);
  const s = create({ account: 'existing-history', balance: '50.00', transactions: [
    { amount: '20.00', date: '20261005', memo: 'Credit Ref#701' },
    { amount: '30.00', date: '20261012', memo: 'Credit Ref#702' },
  ] });
  const choices = choicesFor([s]);
  Object.assign(choices[0], { actualAccountId: id, importFrom: '2026-10-06' });
  const { result, mappings } = await run([s], {}, choices);
  assert.equal(result.accounts[0].added, 1);
  assert.equal(result.accounts[0].beforeImportFrom, 1);
  assert.equal(result.accounts[0].balanceMatches, true);
  assert.equal(mappings[s.key].importFrom, '2026-10-06');
  // A later, overlapping export: the saved date still applies, even if the
  // browser sends no date for an already-linked account.
  const later = create({ account: 'existing-history', end: '20261120', balance: '60.00', transactions: [
    { amount: '20.00', date: '20261005', memo: 'Credit Ref#701' },
    { amount: '30.00', date: '20261012', memo: 'Credit Ref#702' },
    { amount: '10.00', date: '20261115', memo: 'Credit Ref#703' },
  ] });
  const again = await run([later], mappings, [{ ...choices[0], importFrom: '' }]);
  assert.deepEqual([again.result.accounts[0].added, again.result.accounts[0].duplicates, again.result.accounts[0].beforeImportFrom], [1, 1, 1]);
  assert.equal(await budget.api.getAccountBalance(id), 6000);
});

test('a statement linked to a deleted account can be linked again', async () => {
  const s = create({ account: 'relink-after-delete', transactions: [{ amount: '10.00', memo: 'Credit Ref#801' }] });
  const first = await run([s]);
  const old = first.mappings[s.key].actualAccountId;
  await budget.api.deleteAccount(old);
  const choices = choicesFor([s]);
  const { result, mappings } = await run([s], first.mappings, choices);
  const id = mappings[s.key].actualAccountId;
  assert.notEqual(id, old);
  assert.equal(result.accounts[0].added, 1);
  assert.equal(await budget.api.getAccountBalance(id), 20000);
});
