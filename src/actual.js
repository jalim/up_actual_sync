'use strict';

const fs = require('node:fs/promises');
const api = require('@actual-app/api');

/**
 * @actual-app/api is a process-wide singleton, so only one budget session
 * may be open at a time. Every caller goes through this queue.
 */
let queue = Promise.resolve();

function serialize(fn) {
  const run = queue.then(fn, fn);
  // Keep the chain alive regardless of this task's outcome.
  queue = run.catch(() => {});
  return run;
}

function assertConfigured(actual) {
  const missing = ['serverUrl', 'budgetId'].filter((k) => !actual[k]);
  if (!actual.apiKey && !actual.serverPassword) missing.push('apiKey or serverPassword');
  if (missing.length) {
    throw new Error(`Actual Budget is not configured (missing: ${missing.join(', ')})`);
  }
}

async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

/** An API key takes precedence over the password (OpenID servers have none). */
function initOptions(actual, dataDir) {
  const auth = actual.apiKey ? { sessionToken: actual.apiKey } : { password: actual.serverPassword };
  return { dataDir, serverURL: actual.serverUrl, ...auth };
}

/**
 * Open the configured budget, run `fn(api)`, then always shut down and
 * remove the local copy. Calls are serialized.
 */
function withBudget(actual, dataDir, fn) {
  return serialize(async () => {
    assertConfigured(actual);
    await resetDir(dataDir);
    let initialised = false;
    try {
      await api.init(initOptions(actual, dataDir));
      initialised = true;
      await api.downloadBudget(
        actual.budgetId,
        actual.budgetEncryption ? { password: actual.budgetEncryption } : undefined,
      );
      return await fn(api);
    } finally {
      if (initialised) {
        try {
          await api.shutdown();
        } catch (err) {
          console.error('Error shutting down Actual API:', err.message);
        }
      }
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

module.exports = { withBudget, serialize, initOptions, assertConfigured };
