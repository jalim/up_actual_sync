'use strict';

/**
 * A real, in-process Actual budget (no server) shared by the tests in one
 * file. Tests isolate themselves by creating their own accounts.
 * `api.sync()` is stubbed because there is nothing to sync to.
 *
 *   const budget = useLocalBudget(test);
 *   test('x', async () => { const api = budget.api; ... budget.openBudget ... });
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('@actual-app/api');

function quiet() {
  const restore = ['log', 'info', 'warn', 'error', 'debug'].map((k) => {
    const orig = console[k];
    console[k] = () => {};
    return () => (console[k] = orig);
  });
  return () => restore.forEach((r) => r());
}

function useLocalBudget(test) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-actual-'));
  // Actual flushes metadata asynchronously after shutdown; clean up at exit.
  process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

  const local = new Proxy(api, { get: (o, k) => (k === 'sync' ? async () => {} : o[k]) });
  const handle = {
    api: local,
    openBudget: (actual, dir, fn) => fn(local),
  };
  let finish;
  let session;
  let unquiet;

  test.before(async () => {
    unquiet = quiet();
    await api.init({ dataDir });
    await new Promise((ready, fail) => {
      session = api
        .runImport('Test', () => {
          ready();
          return new Promise((r) => (finish = r));
        })
        .catch(fail);
    });
    unquiet();
  });

  test.after(async () => {
    unquiet = quiet();
    finish?.();
    await session?.catch(() => {});
    await api.shutdown().catch(() => {});
    unquiet();
  });

  return handle;
}

/** All transactions in an account, oldest first. */
async function txnsIn(a, accountId) {
  const t = await a.getTransactions(accountId, '1970-01-01', '2100-01-01');
  return t.sort((x, y) => x.date.localeCompare(y.date) || x.amount - y.amount);
}

module.exports = { useLocalBudget, txnsIn, quiet };
