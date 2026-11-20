'use strict';

const upBank = require('./upBank');
const { withBudget } = require('./actual');
const { mapTransaction } = require('./sync');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_ATTEMPTS = 3;

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** First day of the current month, as YYYY-MM-DD. */
function defaultStartDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Up reports times in Australian local time, which is at most 11h ahead of
 * UTC. Fetching from the previous UTC day and then filtering on the local
 * date (as mapTransaction does) avoids any timezone guesswork.
 */
function fetchSince(startDate) {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/**
 * Read the Up balance and every transaction since `startDate` as one
 * consistent snapshot. The balance is read before and after the transaction
 * fetch; if it moved, a transaction landed mid-read and we try again.
 */
async function snapshot(upClient, token, upAccountId, startDate) {
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    const before = await upClient.getAccount(token, upAccountId);
    const txns = await upClient.getTransactions(token, upAccountId, fetchSince(startDate));
    const after = await upClient.getAccount(token, upAccountId);
    const balance = before.attributes.balance.valueInBaseUnits;
    if (balance === after.attributes.balance.valueInBaseUnits) {
      return { account: after, balance, txns };
    }
    console.log(`Up balance changed while reading ${upAccountId}; retrying (${attempt}/${SNAPSHOT_ATTEMPTS})`);
  }
  throw new Error(`Up account ${upAccountId} kept changing while reading; try again shortly`);
}

/**
 * Work out what to create for one Up account: the transactions from
 * `startDate` onwards and the opening balance that, together with those
 * transactions, reproduces the current Up balance.
 */
function plan(snap, startDate) {
  const transactions = snap.txns
    .map((t) => mapTransaction(t, null))
    .filter((t) => t.date >= startDate);
  const total = transactions.reduce((sum, t) => sum + t.amount, 0);
  return { transactions, openingBalance: snap.balance - total };
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Actual's importer fuzzy-matches an incoming transaction to an existing one
 * with the same amount within ±7 days, which could swallow the opening
 * balance. If any imported transaction would collide, date the opening
 * balance 8 days earlier so it sits outside that window.
 */
function openingBalanceDate(startDate, openingBalance, transactions) {
  const limit = addDays(startDate, 7);
  const collides = transactions.some((t) => t.amount === openingBalance && t.date <= limit);
  return collides ? addDays(startDate, -8) : startDate;
}

function accountName(upAccount, taken) {
  const a = upAccount.attributes;
  let name = a.displayName;
  if (a.ownershipType === 'JOINT') name += ' (2Up)';
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Create an Actual account for each Up account, with an opening balance
 * dated `startDate` and every Up transaction since then imported.
 *
 * @returns {Promise<Array<{upAccountId, actualAccountId, name, openingBalance, imported}>>}
 */
async function createAccounts({
  token,
  actual,
  dataDir,
  upAccountIds,
  startDate,
  upClient = upBank,
  openBudget = withBudget,
  today = new Date().toISOString().slice(0, 10),
}) {
  if (!token) throw new Error('Up API token is not configured');
  if (!isValidDate(startDate)) throw new Error(`Invalid start date: ${startDate}`);
  if (startDate > today) throw new Error('Start date cannot be in the future');
  if (!upAccountIds?.length) throw new Error('No Up accounts selected');

  // All Up reads happen before the budget is opened.
  const work = [];
  for (const upAccountId of upAccountIds) {
    const snap = await snapshot(upClient, token, upAccountId, startDate);
    work.push({ upAccountId, upAccount: snap.account, balance: snap.balance, ...plan(snap, startDate) });
  }

  return openBudget(actual, dataDir, async (api) => {
    const taken = new Set((await api.getAccounts()).map((a) => a.name.toLowerCase()));
    const created = [];
    for (const w of work) {
      const name = accountName(w.upAccount, taken);
      const offbudget = w.upAccount.attributes.accountType === 'HOME_LOAN';
      const id = await api.createAccount({ name, offbudget }, w.openingBalance);

      const openingDate = openingBalanceDate(startDate, w.openingBalance, w.transactions);
      if (w.openingBalance !== 0) {
        // createAccount dates the starting balance today; move it back.
        const [starting] = await api.getTransactions(id, '1970-01-01', today);
        if (starting) await api.updateTransaction(starting.id, { date: openingDate });
      }

      const txns = w.transactions.map((t) => ({ ...t, account: id }));
      const res = txns.length ? await api.importTransactions(id, txns) : { added: [], errors: [] };
      const balance = await api.getAccountBalance(id);
      const warnings = (res.errors || []).map((e) => e.message);
      if (balance !== w.balance) {
        warnings.push(`Actual balance ${(balance / 100).toFixed(2)} does not match Up balance ${(w.balance / 100).toFixed(2)}`);
      }
      created.push({
        upAccountId: w.upAccountId,
        actualAccountId: id,
        name,
        offbudget,
        openingBalance: w.openingBalance,
        openingDate,
        imported: res.added?.length ?? 0,
        warnings,
      });
      console.log(
        `Created "${name}" (opening ${(w.openingBalance / 100).toFixed(2)} on ${openingDate}, ${txns.length} transactions)` +
          (warnings.length ? ` WARNING: ${warnings.join('; ')}` : ''),
      );
    }
    await api.sync();
    return created;
  });
}

module.exports = { createAccounts, defaultStartDate, isValidDate, fetchSince, plan, accountName, openingBalanceDate };
