'use strict';

const upBank = require('./upBank');
const { withBudget } = require('./actual');

class SyncInProgressError extends Error {
  constructor() {
    super('A sync is already running');
    this.name = 'SyncInProgressError';
  }
}

let running = false;

function isRunning() {
  return running;
}

/**
 * Map an Up transaction resource to an Actual import transaction.
 * Up timestamps carry the local (+10:00/+11:00) offset, so the first ten
 * characters are the local calendar date.
 */
function mapTransaction(upTxn, actualAccountId) {
  const a = upTxn.attributes;
  return {
    account: actualAccountId,
    date: a.createdAt.slice(0, 10),
    amount: a.amount.valueInBaseUnits,
    payee_name: a.description,
    imported_payee: a.description,
    notes: a.description,
    imported_id: upTxn.id,
    cleared: a.status === 'SETTLED',
  };
}

function sinceDate(days, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Pull recent transactions from every linked Up account and import them
 * into the matching Actual account.
 *
 * @returns {Promise<Array<{upAccountId, actualAccountId, name, added, updated, errors}>>}
 */
async function run({
  token,
  actual,
  linkedAccounts,
  importFrom = {},
  dataDir,
  syncDays,
  upClient = upBank,
  openBudget = withBudget,
}) {
  if (running) throw new SyncInProgressError();
  running = true;
  const started = Date.now();
  try {
    if (!token) throw new Error('Up API token is not configured');
    const links = Object.entries(linkedAccounts || {}).filter(([, actualId]) => actualId);
    if (!links.length) {
      console.log('No linked accounts; nothing to sync.');
      return [];
    }

    const since = sinceDate(syncDays);
    console.log(`Fetching Up transactions since ${since.toISOString()}`);

    // Fetch from Up first so an Up outage doesn't touch the budget at all.
    const fetched = [];
    for (const [upAccountId, actualAccountId] of links) {
      const txns = await upClient.getTransactions(token, upAccountId, since);
      const from = importFrom[upAccountId] || '';
      fetched.push({
        upAccountId,
        actualAccountId,
        transactions: txns.map((t) => mapTransaction(t, actualAccountId)).filter((t) => t.date >= from),
      });
    }

    const results = await openBudget(actual, dataDir, async (api) => {
      const accounts = await api.getAccounts();
      const out = [];
      for (const { upAccountId, actualAccountId, transactions } of fetched) {
        const account = accounts.find((acc) => acc.id === actualAccountId);
        if (!account) {
          console.warn(`Linked Actual account ${actualAccountId} not found; skipping Up account ${upAccountId}`);
          out.push({ upAccountId, actualAccountId, name: '(missing)', added: 0, updated: 0, errors: ['Actual account not found'] });
          continue;
        }
        const res = await api.importTransactions(actualAccountId, transactions);
        out.push({
          upAccountId,
          actualAccountId,
          name: account.name,
          added: res.added?.length ?? 0,
          updated: res.updated?.length ?? 0,
          errors: (res.errors || []).map((e) => e.message),
        });
      }
      await api.sync();
      return out;
    });

    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(25)} | added ${String(r.added).padStart(4)} | updated ${String(r.updated).padStart(4)} |` +
          (r.errors.length ? ` errors: ${r.errors.join('; ')}` : ''),
      );
    }
    console.log(`Sync complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return results;
  } finally {
    running = false;
  }
}

module.exports = { run, mapTransaction, sinceDate, isRunning, SyncInProgressError };
