'use strict';

const upBank = require('./upBank');
const { UpApiError } = upBank;
const { withBudget } = require('./actual');
const importer = require('./importer');
const sync = require('./sync');
const categories = require('./categories');

const DEFAULT_LOOKBACK_DAYS = 90;

/**
 * Up transactions for every linked account, from each account's start date
 * (or the last 90 days for accounts without one). Deleted Up accounts are
 * skipped.
 */
async function fetchEntries({ token, linkedAccounts, importFrom = {}, upClient = upBank, now = new Date() }) {
  const links = Object.entries(linkedAccounts || {}).filter(([, a]) => a);
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() - DEFAULT_LOOKBACK_DAYS);
  const entries = [];
  for (const [upAccountId, actualAccountId] of links) {
    const from = importFrom[upAccountId];
    const since = from ? new Date(`${from}T00:00:00Z`) : fallback;
    if (from) since.setUTCDate(since.getUTCDate() - 1);
    let txns;
    try {
      txns = await upClient.getTransactions(token, upAccountId, since);
    } catch (err) {
      if (err instanceof UpApiError && err.status === 404) continue;
      throw err;
    }
    entries.push({
      upAccountId,
      actualAccountId,
      txns: txns.filter((t) => t.attributes.createdAt.slice(0, 10) >= (from || '')),
    });
  }
  return entries;
}

/** Find (dryRun) or link transfer pairs that were imported as plain transactions. */
async function linkExistingTransfers({
  token,
  actual,
  linkedAccounts,
  importFrom,
  dataDir,
  dryRun,
  categorySettings,
  upClient = upBank,
  openBudget = withBudget,
}) {
  if (!token) throw new Error('Up API token is not configured');
  if (sync.isRunning()) throw new sync.SyncInProgressError();
  const entries = await fetchEntries({ token, linkedAccounts, importFrom, upClient });
  return openBudget(actual, dataDir, async (api) => {
    const known = new Set((await api.getAccounts()).map((a) => a.id));
    const mine = entries.filter((e) => known.has(e.actualAccountId));
    // Transfer categories only; purchases are untouched here.
    const resolved = await categories.forEntries(api, [], [], { transfers: categorySettings?.transfers });
    const result = await importer.linkExistingTransfers(api, mine, { dryRun, categories: resolved });
    if (!dryRun) await api.sync();
    return result;
  });
}

module.exports = { fetchEntries, linkExistingTransfers };
