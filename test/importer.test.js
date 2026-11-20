'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useLocalBudget, txnsIn } = require('./helpers/localBudget');
const { upTxn, upTransfer } = require('./helpers/up');
const importer = require('../src/importer');

const budget = useLocalBudget(test);
const NOW = Date.parse('2026-11-20T12:00:00+11:00');

async function accounts(...names) {
  const ids = {};
  for (const n of names) ids[n] = await budget.api.createAccount({ name: `${n}-${Math.random()}` }, 0);
  return ids;
}

const entry = (up, actual, txns) => ({ upAccountId: up, actualAccountId: actual, txns });
const run = (entries, opts = {}) => importer.importAll(budget.api, entries, { now: NOW, ...opts });
const bal = (id) => budget.api.getAccountBalance(id);

test('a transfer between linked accounts becomes one Actual transfer', async () => {
  const ids = await accounts('spend', 'saver');
  const [out, inc] = upTransfer('up-spend', 'up-saver', 5000, '2026-11-10T12:00:00+11:00', '2026-11-10T12:00:02+11:00');
  const stats = await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [inc])]);

  const [a] = await txnsIn(budget.api, ids.spend);
  const [b] = await txnsIn(budget.api, ids.saver);
  assert.equal(a.amount, -5000);
  assert.equal(b.amount, 5000);
  assert.equal(a.transfer_id, b.id);
  assert.equal(a.imported_id, out.id);
  assert.equal(b.imported_id, inc.id);
  assert.equal(stats.get(ids.spend).transfers, 1);
  assert.equal(stats.get(ids.saver).transfers, 1);

  // Re-running is a no-op.
  await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [inc])]);
  assert.equal((await txnsIn(budget.api, ids.spend)).length, 1);
  assert.equal((await txnsIn(budget.api, ids.saver)).length, 1);
});

test('round-ups are synthesised in spending and paired with the saver credit', async () => {
  const ids = await accounts('spend', 'saver');
  const purchase = upTxn({ account: 'up-spend', amount: -1800, roundUp: -200, at: '2026-11-10T09:00:00+11:00' });
  const credit = upTxn({
    account: 'up-saver', amount: 200, transferAccount: 'up-spend', type: 'Round Up', description: 'Round Up', at: '2026-11-10T09:00:03+11:00',
  });
  await run([entry('up-spend', ids.spend, [purchase]), entry('up-saver', ids.saver, [credit])]);

  assert.equal(await bal(ids.spend), -2000);
  assert.equal(await bal(ids.saver), 200);
  const spend = await txnsIn(budget.api, ids.spend);
  const roundUp = spend.find((t) => t.imported_id === importer.roundUpId(purchase.id));
  assert.ok(roundUp?.transfer_id, 'round-up is a transfer');
  assert.equal((await txnsIn(budget.api, ids.saver))[0].imported_id, credit.id);
});

test('round-ups to an unlinked saver still reduce the spending balance', async () => {
  const ids = await accounts('spend');
  const purchase = upTxn({ account: 'up-spend', amount: -1800, roundUp: -200 });
  await run([entry('up-spend', ids.spend, [purchase])]);
  assert.equal(await bal(ids.spend), -2000);
  const t = await txnsIn(budget.api, ids.spend);
  assert.equal(t.length, 2);
  assert.ok(t.every((x) => !x.transfer_id));
});

test('transfers to unlinked accounts are ordinary transactions', async () => {
  const ids = await accounts('spend');
  const [out] = upTransfer('up-spend', 'up-someone-else', 1000);
  await run([entry('up-spend', ids.spend, [out])]);
  const [t] = await txnsIn(budget.api, ids.spend);
  assert.equal(t.amount, -1000);
  assert.equal(t.transfer_id, null);
});

test('a pair with one side already imported as plain gets the other side plain', async () => {
  const ids = await accounts('spend', 'saver');
  const [out, inc] = upTransfer('up-spend', 'up-saver', 700);
  // Legacy: spending side imported before transfers were supported.
  await run([entry('up-spend', ids.spend, [out])]);
  await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [inc])]);
  assert.equal((await txnsIn(budget.api, ids.spend)).length, 1);
  assert.equal((await txnsIn(budget.api, ids.saver)).length, 1);
  assert.equal(await bal(ids.spend), -700);
  assert.equal(await bal(ids.saver), 700);
});

test('young unpaired transfer halves wait for their counterpart', async () => {
  const ids = await accounts('spend', 'saver');
  const recent = new Date(NOW - 60 * 1000).toISOString();
  const [out, inc] = upTransfer('up-spend', 'up-saver', 300, recent, recent);
  // Only the outgoing half is visible so far.
  const stats = await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [])]);
  assert.equal(stats.get(ids.spend).deferred, 1);
  assert.equal((await txnsIn(budget.api, ids.spend)).length, 0);
  // Next run sees both and links them.
  await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [inc])]);
  const [a] = await txnsIn(budget.api, ids.spend);
  assert.ok(a.transfer_id);
});

test('old unpaired halves import plain instead of waiting forever', async () => {
  const ids = await accounts('spend', 'saver');
  const [out] = upTransfer('up-spend', 'up-saver', 300, '2026-11-01T10:00:00+11:00');
  await run([entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [])]);
  assert.equal(await bal(ids.spend), -300);
});

test('pairing requires matching amount, direction and a close time', () => {
  const [out, inc] = upTransfer('A', 'B', 100, '2026-11-10T12:00:00+11:00', '2026-11-10T12:00:30+11:00');
  const far = upTransfer('A', 'B', 100, '2026-11-10T12:00:00+11:00', '2026-11-10T12:05:00+11:00')[1];
  const wrongAmt = upTransfer('A', 'B', 101)[1];
  const items = (txnsA, txnsB) => [
    ...importer.itemsFor({ upAccountId: 'A', actualAccountId: 'a', txns: txnsA }),
    ...importer.itemsFor({ upAccountId: 'B', actualAccountId: 'b', txns: txnsB }),
  ];
  assert.equal(importer.pairItems(items([out], [inc])).pairs.length, 1);
  assert.equal(importer.pairItems(items([out], [far])).pairs.length, 0);
  assert.equal(importer.pairItems(items([out], [wrongAmt])).pairs.length, 0);
});

test('two identical transfers pair one-to-one', async () => {
  const ids = await accounts('spend', 'saver');
  const p1 = upTransfer('up-spend', 'up-saver', 500, '2026-11-10T12:00:00+11:00', '2026-11-10T12:00:01+11:00');
  const p2 = upTransfer('up-spend', 'up-saver', 500, '2026-11-10T12:00:20+11:00', '2026-11-10T12:00:21+11:00');
  await run([entry('up-spend', ids.spend, [p1[0], p2[0]]), entry('up-saver', ids.saver, [p1[1], p2[1]])]);
  assert.equal((await txnsIn(budget.api, ids.spend)).length, 2);
  assert.equal((await txnsIn(budget.api, ids.saver)).length, 2);
  assert.equal(await bal(ids.saver), 1000);
});

async function importPlain(id, upTxns) {
  const { mapTransaction } = require('../src/mapping');
  await budget.api.importTransactions(id, upTxns.map((t) => mapTransaction(t, id)));
}

test('linkExistingTransfers converts plain pairs into transfers, idempotently', async () => {
  const ids = await accounts('spend', 'saver');
  const [out, inc] = upTransfer('up-spend', 'up-saver', 2500, '2026-11-08T10:00:00+11:00', '2026-11-08T10:00:01+11:00');
  const purchase = upTxn({ account: 'up-spend', amount: -900, roundUp: -100, at: '2026-11-09T10:00:00+11:00' });
  const credit = upTxn({ account: 'up-saver', amount: 100, transferAccount: 'up-spend', type: 'Round Up', at: '2026-11-09T10:00:02+11:00' });
  const entries = [entry('up-spend', ids.spend, [out, purchase]), entry('up-saver', ids.saver, [inc, credit])];
  // Legacy state: everything imported plain, round-up debit included.
  const legacy = importer.itemsFor(entries[0]).map((i) => i.txn);
  await budget.api.importTransactions(ids.spend, legacy);
  await importPlain(ids.saver, [inc, credit]);

  const dry = await importer.linkExistingTransfers(budget.api, entries, { dryRun: true });
  assert.deepEqual(dry, { pairs: 2, linked: 2, alreadyLinked: 0, skipped: 0 });
  assert.ok((await txnsIn(budget.api, ids.spend)).every((t) => !t.transfer_id), 'dry run changes nothing');

  const res = await importer.linkExistingTransfers(budget.api, entries);
  assert.equal(res.linked, 2);
  const spend = await txnsIn(budget.api, ids.spend);
  const saver = await txnsIn(budget.api, ids.saver);
  assert.equal(saver.length, 2);
  assert.ok(saver.every((t) => t.transfer_id && t.imported_id), 'saver halves are transfers carrying their Up ids');
  assert.deepEqual(saver.map((t) => t.imported_id).sort(), [inc.id, credit.id].sort());
  assert.equal(spend.filter((t) => t.transfer_id).length, 2);
  assert.equal(await bal(ids.spend), -2500 - 900 - 100);
  assert.equal(await bal(ids.saver), 2600);

  // A normal sync afterwards adds nothing, and a second repair finds nothing to do.
  await run(entries);
  assert.equal((await txnsIn(budget.api, ids.saver)).length, 2);
  assert.equal((await txnsIn(budget.api, ids.spend)).length, 3);
  assert.deepEqual(await importer.linkExistingTransfers(budget.api, entries), { pairs: 2, linked: 0, alreadyLinked: 2, skipped: 0 });
});

test('linkExistingTransfers keeps the category on the on-budget half of an off-budget transfer', async () => {
  const kid = await budget.api.createAccount({ name: `kid-${Math.random()}`, offbudget: true }, 0);
  const home = await budget.api.createAccount({ name: `home-${Math.random()}` }, 0);
  const group = await budget.api.createCategoryGroup({ name: `g-${Math.random()}` });
  const cat = await budget.api.createCategory({ name: 'Pocket money', group_id: group });
  const [out, inc] = upTransfer('up-kid', 'up-home', 400, '2026-11-08T10:00:00+11:00');
  await importPlain(kid, [out]);
  await importPlain(home, [inc]);
  const [plainIn] = await txnsIn(budget.api, home);
  await budget.api.updateTransaction(plainIn.id, { category: cat });

  await importer.linkExistingTransfers(budget.api, [entry('up-kid', kid, [out]), entry('up-home', home, [inc])]);
  const [linkedIn] = await txnsIn(budget.api, home);
  assert.ok(linkedIn.transfer_id);
  assert.equal(linkedIn.category, cat);
});

test('linkExistingTransfers skips pairs with a missing half', async () => {
  const ids = await accounts('spend', 'saver');
  const [out, inc] = upTransfer('up-spend', 'up-saver', 100, '2026-11-08T10:00:00+11:00');
  await importPlain(ids.spend, [out]);
  const res = await importer.linkExistingTransfers(budget.api, [entry('up-spend', ids.spend, [out]), entry('up-saver', ids.saver, [inc])]);
  assert.deepEqual(res, { pairs: 1, linked: 0, alreadyLinked: 0, skipped: 1 });
});
