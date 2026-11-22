'use strict';

const upBank = require('./upBank');
const { UpApiError } = upBank;
const { withBudget } = require('./actual');
const { mapTransaction } = require('./mapping');
const importer = require('./importer');
const categories = require('./categories');
const { reconcileTransfers } = require('./ofxImport');

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

function sinceDate(days, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

/** Local transaction date (YYYY-MM-DD) as Actual will see it. */
function localDate(upTxn) {
  return upTxn.attributes.createdAt.slice(0, 10);
}

/**
 * Pull recent transactions from every linked Up account and import them
 * into the matching Actual account, creating transfers between linked
 * accounts where Up reports them.
 *
 * @returns {Promise<Array<{upAccountId, actualAccountId, name, added, updated, transfers, deferred, errors}>>}
 */
async function run({
  token,
  actual,
  linkedAccounts,
  ofxAccounts = {},
  importFrom = {},
  categorySettings,
  dataDir,
  syncDays,
  upClient = upBank,
  openBudget = withBudget,
  settleMs,
  now,
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
      const from = importFrom[upAccountId] || '';
      let txns;
      try {
        txns = await upClient.getTransactions(token, upAccountId, since);
      } catch (err) {
        // A deleted Up account (e.g. a closed saver) must not block the rest.
        if (err instanceof UpApiError && err.status === 404) {
          console.warn(`Up account ${upAccountId} no longer exists; skipping. Unlink it on the Accounts page.`);
          fetched.push({ upAccountId, actualAccountId, txns: [], goneFromUp: true });
          continue;
        }
        throw err;
      }
      fetched.push({ upAccountId, actualAccountId, txns: txns.filter((t) => localDate(t) >= from) });
    }

    const upCategories = await categories.fetchUpCategories(upClient, token, categorySettings);

    const results = await openBudget(actual, dataDir, async (api) => {
      const accounts = await api.getAccounts();
      const known = new Map(accounts.map((a) => [a.id, a]));
      const entries = fetched.filter((f) => known.has(f.actualAccountId) && !f.goneFromUp);
      const resolved = await categories.forEntries(api, entries, upCategories, categorySettings);
      const stats = await importer.importAll(api, entries, { settleMs, now, categories: resolved });
      // OFX transfer matching is best-effort: a failure there must not stop the
      // Up import from being pushed to the server.
      let ofxWarning = null;
      try {
        await reconcileTransfers(api, ofxAccounts, links.map(([, id]) => id));
      } catch (err) {
        ofxWarning = `OFX transfer matching failed: ${err.message}`;
        console.error(ofxWarning);
      }
      await api.sync();
      const perAccount = fetched.map((f) => {
        const account = known.get(f.actualAccountId);
        if (f.goneFromUp) {
          return {
            upAccountId: f.upAccountId,
            actualAccountId: f.actualAccountId,
            name: account?.name || '(missing)',
            added: 0,
            updated: 0,
            transfers: 0,
            deferred: 0,
            goneFromUp: true,
            errors: ['Up account no longer exists; unlink it on the Accounts page'],
          };
        }
        if (!account) {
          console.warn(`Linked Actual account ${f.actualAccountId} not found; skipping Up account ${f.upAccountId}`);
          return {
            upAccountId: f.upAccountId,
            actualAccountId: f.actualAccountId,
            name: '(missing)',
            added: 0,
            updated: 0,
            transfers: 0,
            deferred: 0,
            errors: ['Actual account not found'],
          };
        }
        return { upAccountId: f.upAccountId, actualAccountId: f.actualAccountId, name: account.name, ...stats.get(f.actualAccountId) };
      });
      if (ofxWarning) {
        perAccount.push({ name: 'P&N transfer matching', added: 0, updated: 0, transfers: 0, deferred: 0, errors: [ofxWarning] });
      }
      return perAccount;
    });

    for (const r of results) {
      console.log(
        `| ${r.name.padEnd(25)} | added ${String(r.added).padStart(4)} | updated ${String(r.updated).padStart(4)} | transfers ${String(r.transfers).padStart(3)} |` +
          (r.deferred ? ` deferred ${r.deferred}` : '') +
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
