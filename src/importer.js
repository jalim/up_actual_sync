'use strict';

/**
 * Turns Up transactions into Actual transactions, recognising transfers
 * between linked Up accounts and round-ups.
 *
 * Up reports a transfer once in each account, each side naming the other
 * via relationships.transferAccount. Round-ups are different: the purchase
 * in the spending account only carries an `attributes.roundUp` amount, and
 * the saver gets a separate "Round Up" credit naming the spending account.
 * We synthesise the spending-side round-up so balances match Up, then pair
 * it with the saver credit like any other transfer.
 *
 * For each pair, against what is already in Actual:
 *   neither side imported -> create one Actual transfer, tag both halves
 *                            with their Up ids
 *   both imported         -> leave alone
 *   one imported          -> (legacy plain import) import the other plain
 * Anything unpaired is imported as an ordinary transaction.
 */

const { mapTransaction } = require('./mapping');

const PAIR_WINDOW_MS = 60 * 1000;
const DEFAULT_SETTLE_MS = 10 * 60 * 1000;
const ROUND_UP = 'Round Up';

function roundUpId(upTxnId) {
  return `${upTxnId}:roundup`;
}

/** Expand one linked account's Up transactions into importable items. */
function itemsFor({ upAccountId, actualAccountId, txns }) {
  const items = [];
  for (const t of txns) {
    const a = t.attributes;
    const at = Date.parse(a.createdAt);
    items.push({
      upAccountId,
      actualAccountId,
      at,
      counterpartUp: t.relationships?.transferAccount?.data?.id || null,
      upCategory: t.relationships?.category?.data?.id || null,
      isRoundUpCredit: a.transactionType === ROUND_UP,
      txn: mapTransaction(t, actualAccountId),
    });
    if (a.roundUp?.amount?.valueInBaseUnits) {
      const base = mapTransaction(t, actualAccountId);
      items.push({
        upAccountId,
        actualAccountId,
        at,
        counterpartUp: null, // destination saver isn't reported on the purchase
        isRoundUpDebit: true,
        txn: {
          ...base,
          amount: a.roundUp.amount.valueInBaseUnits,
          payee_name: ROUND_UP,
          imported_payee: ROUND_UP,
          notes: `${ROUND_UP}: ${a.description}`,
          imported_id: roundUpId(t.id),
        },
      });
    }
  }
  return items;
}

/**
 * Pair outgoing items with their incoming counterpart. Returns
 * { pairs: [{ out, in }], single: [item] }.
 */
function pairItems(items) {
  const incoming = items.filter((i) => i.txn.amount > 0 && i.counterpartUp);
  const used = new Set();
  const pairs = [];
  const paired = new Set();

  const outgoing = items.filter((i) => i.txn.amount < 0 && (i.counterpartUp || i.isRoundUpDebit));
  for (const out of outgoing) {
    let best = null;
    for (const cand of incoming) {
      if (used.has(cand) || cand.upAccountId === out.upAccountId) continue;
      if (cand.counterpartUp !== out.upAccountId) continue;
      if (cand.txn.amount !== -out.txn.amount) continue;
      if (out.isRoundUpDebit ? !cand.isRoundUpCredit : out.counterpartUp !== cand.upAccountId) continue;
      const dt = Math.abs(cand.at - out.at);
      if (dt > PAIR_WINDOW_MS) continue;
      if (!best || dt < best.dt) best = { cand, dt };
    }
    if (best) {
      used.add(best.cand);
      paired.add(out).add(best.cand);
      pairs.push({ out, in: best.cand });
    }
  }
  return { pairs, single: items.filter((i) => !paired.has(i)) };
}

/**
 * Category for `accountId`'s half of a transfer with `otherId`: only when
 * money crosses the budget boundary (this side on-budget, other off-budget)
 * and a category is configured for the off-budget account.
 */
function transferCategory(categories, offBudget, accountId, otherId) {
  if (offBudget.has(accountId) || !offBudget.has(otherId)) return {};
  const category = categories?.transfer?.get(otherId);
  return category ? { category } : {};
}

/** Could this item still be waiting for its other half to appear in Up? */
function awaitingCounterpart(item, linkedUpIds) {
  if (item.isRoundUpDebit || item.isRoundUpCredit) return true;
  return !!item.counterpartUp && linkedUpIds.has(item.counterpartUp);
}

/** Map from Actual account id to the set of imported_ids already present. */
async function existingImportedIds(api, items) {
  const byAccount = new Map();
  if (!items.length) return byAccount;
  const dates = items.map((i) => i.txn.date).sort();
  const pad = (d, days) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + days);
    return x.toISOString().slice(0, 10);
  };
  const start = pad(dates[0], -1);
  const end = pad(dates[dates.length - 1], 1);
  for (const id of new Set(items.map((i) => i.actualAccountId))) {
    const txns = await api.getTransactions(id, start, end);
    byAccount.set(id, new Set(txns.map((t) => t.imported_id).filter(Boolean)));
  }
  return byAccount;
}

/**
 * Import Up transactions for a set of linked accounts.
 *
 * @param {object} api - @actual-app/api with a budget open
 * @param {Array<{upAccountId, actualAccountId, txns}>} entries - raw Up transactions per linked account
 * @param {object} [opts]
 * @param {number} [opts.settleMs] - defer unpaired transfer-like items younger than this
 * @param {number} [opts.now]
 * @param {{byUp: Map, transfer: Map}} [opts.categories] - from categories.resolveCategories
 * @returns {Promise<Map<actualAccountId, {added, updated, transfers, deferred, errors}>>}
 */
async function importAll(
  api,
  entries,
  { settleMs = DEFAULT_SETTLE_MS, now = Date.now(), categories = { byUp: new Map(), transfer: new Map() } } = {},
) {
  const items = entries.flatMap(itemsFor);
  const linkedUpIds = new Set(entries.map((e) => e.upAccountId));
  const { pairs, single } = pairItems(items);
  const existing = await existingImportedIds(api, items);
  const has = (item) => existing.get(item.actualAccountId)?.has(item.txn.imported_id) ?? false;

  const stats = new Map(
    entries.map((e) => [e.actualAccountId, { added: 0, updated: 0, transfers: 0, deferred: 0, errors: [] }]),
  );
  const offBudget = new Set((await api.getAccounts()).filter((a) => a.offbudget).map((a) => a.id));
  const plain = new Map(); // actualAccountId -> txns to importTransactions
  const queuePlain = (item) => {
    if (!plain.has(item.actualAccountId)) plain.set(item.actualAccountId, []);
    // Category only applies to new transactions; Actual keeps any existing one.
    const category = offBudget.has(item.actualAccountId) ? null : categories.byUp.get(item.upCategory);
    plain.get(item.actualAccountId).push(category ? { ...item.txn, category } : item.txn);
  };

  const transferPayee = new Map(
    (await api.getPayees()).filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]),
  );

  for (const { out, in: inc } of pairs) {
    const outExists = has(out);
    const inExists = has(inc);
    if (outExists && inExists) continue;
    if (outExists || inExists) {
      queuePlain(outExists ? inc : out);
      continue;
    }
    const payee = transferPayee.get(inc.actualAccountId);
    if (!payee) {
      queuePlain(out);
      queuePlain(inc);
      continue;
    }
    const { payee_name: _p, imported_payee: _ip, account: _a, ...outTxn } = out.txn;
    await api.addTransactions(out.actualAccountId, [{ ...outTxn, payee }], { runTransfers: true });
    const [created] = (await api.getTransactions(out.actualAccountId, out.txn.date, out.txn.date)).filter(
      (t) => t.imported_id === out.txn.imported_id,
    );
    if (created?.transfer_id) {
      await api.updateTransaction(created.transfer_id, {
        imported_id: inc.txn.imported_id,
        cleared: inc.txn.cleared,
        notes: inc.txn.notes,
        ...transferCategory(categories, offBudget, inc.actualAccountId, out.actualAccountId),
      });
      const outCategory = transferCategory(categories, offBudget, out.actualAccountId, inc.actualAccountId);
      if (outCategory.category) await api.updateTransaction(created.id, outCategory);
    }
    stats.get(out.actualAccountId).added++;
    stats.get(out.actualAccountId).transfers++;
    stats.get(inc.actualAccountId).added++;
    stats.get(inc.actualAccountId).transfers++;
  }

  for (const item of single) {
    if (!has(item) && settleMs > 0 && now - item.at < settleMs && awaitingCounterpart(item, linkedUpIds)) {
      stats.get(item.actualAccountId).deferred++;
      continue;
    }
    queuePlain(item);
  }

  for (const [actualAccountId, txns] of plain) {
    const res = await api.importTransactions(actualAccountId, txns);
    const s = stats.get(actualAccountId);
    s.added += res.added?.length ?? 0;
    s.updated += res.updated?.length ?? 0;
    s.errors.push(...(res.errors || []).map((e) => e.message));
  }

  return stats;
}

/**
 * Turn transfer pairs that were imported as two ordinary transactions
 * (e.g. by a version without transfer support) into Actual transfers.
 *
 * For each pair where both halves exist, neither is a transfer and neither
 * is split: set the outgoing half's payee to the destination account's
 * transfer payee (Actual then creates the incoming half), delete the old
 * incoming copy, and move its Up id, cleared flag and notes onto the new
 * half. Later syncs therefore see both Up ids exactly as before.
 *
 * @returns {Promise<{pairs, linked, alreadyLinked, skipped}>}
 */
async function linkExistingTransfers(api, entries, { dryRun = false, categories } = {}) {
  const items = entries.flatMap(itemsFor);
  const { pairs } = pairItems(items);
  const result = { pairs: pairs.length, linked: 0, alreadyLinked: 0, skipped: 0 };
  if (!pairs.length) return result;

  const accounts = new Map((await api.getAccounts()).map((a) => [a.id, a]));
  const transferPayee = new Map(
    (await api.getPayees()).filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]),
  );
  const dates = items.map((i) => i.txn.date).sort();
  const index = new Map();
  for (const id of new Set(entries.map((e) => e.actualAccountId))) {
    for (const t of await api.getTransactions(id, dates[0], dates[dates.length - 1])) {
      if (t.imported_id) index.set(`${id}|${t.imported_id}`, t);
    }
  }

  for (const p of pairs) {
    const out = index.get(`${p.out.actualAccountId}|${p.out.txn.imported_id}`);
    const inn = index.get(`${p.in.actualAccountId}|${p.in.txn.imported_id}`);
    if (out?.transfer_id && inn?.transfer_id && out.transfer_id === inn.id) {
      result.alreadyLinked++;
      continue;
    }
    const payee = transferPayee.get(p.in.actualAccountId);
    if (!out || !inn || out.transfer_id || inn.transfer_id || out.is_parent || inn.is_parent || !payee) {
      result.skipped++;
      continue;
    }
    if (dryRun) {
      result.linked++;
      continue;
    }
    await api.updateTransaction(out.id, { payee });
    const [updated] = (await api.getTransactions(out.account, out.date, out.date)).filter((t) => t.id === out.id);
    if (!updated?.transfer_id) {
      result.skipped++;
      continue;
    }
    await api.deleteTransaction(inn.id);
    const fields = { imported_id: inn.imported_id, cleared: inn.cleared, notes: inn.notes };
    // An on-budget half of a transfer from an off-budget account needs a
    // category; keep one the user already chose.
    if (inn.category && !accounts.get(inn.account)?.offbudget && accounts.get(out.account)?.offbudget) {
      fields.category = inn.category;
    }
    const offBudget = new Set([...accounts.values()].filter((a) => a.offbudget).map((a) => a.id));
    if (!fields.category) Object.assign(fields, transferCategory(categories, offBudget, inn.account, out.account));
    await api.updateTransaction(updated.transfer_id, fields);
    if (!updated.category) {
      const outCategory = transferCategory(categories, offBudget, out.account, inn.account);
      if (outCategory.category) await api.updateTransaction(out.id, outCategory);
    }
    result.linked++;
  }
  return result;
}

module.exports = { importAll, linkExistingTransfers, itemsFor, pairItems, roundUpId, PAIR_WINDOW_MS };
