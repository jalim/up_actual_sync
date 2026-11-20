'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('@actual-app/api');

/**
 * Local budget cache.
 *
 * The budget is kept on disk between sessions: downloadBudget() then opens
 * the local copy and pulls only the changes since last time (about 3s
 * instead of a 12s full download for a typical budget).
 *
 * Layout under dataDir (budgets/):
 *   active          name of the cache directory currently in use
 *   cache-<ms>-<id> a cache "generation" holding Actual's budget folder
 *
 * A directory is never deleted while it may still be in use:
 * @actual-app/api keeps writing metadata (with retries) for several seconds
 * after shutdown() resolves, and deleting the directory under it fails with
 * ENOENT as an unhandled rejection. If the cache can't be brought up to date
 * (e.g. the budget was reset on the server), a new generation is downloaded
 * and the old one is removed by a later session once it is stale.
 */

const ACTIVE_FILE = 'active';
const GENERATION_PREFIX = 'cache-';
const STALE_MS = 10 * 60 * 1000;

// Errors a fresh download can't fix: report them instead of re-downloading.
const NO_REFRESH_CODES = new Set([
  'network-failure',
  'unauthorized',
  'token-expired',
  'invalid-password',
  'budget-not-found',
  'clock-drift',
  'missing-key',
  'decrypt-failure',
]);

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

/** An API key takes precedence over the password (OpenID servers have none). */
function initOptions(actual, dataDir) {
  const auth = actual.apiKey ? { sessionToken: actual.apiKey } : { password: actual.serverPassword };
  return { dataDir, serverURL: actual.serverUrl, ...auth };
}

/** Age of a dataDir entry: from a generation's name, else its mtime. */
async function entryAge(dataDir, name, now) {
  const m = /^cache-(\d+)-/.exec(name);
  if (m) return now - Number(m[1]);
  return now - (await fs.stat(path.join(dataDir, name))).mtimeMs;
}

/**
 * Remove stale entries: old cache generations, per-session folders from
 * 1.0.1 and budget folders from older versions. Never touches `keep`.
 */
async function cleanup(dataDir, keep, now) {
  for (const name of await fs.readdir(dataDir)) {
    if (name === ACTIVE_FILE || name === keep || name.startsWith(`${ACTIVE_FILE}.`)) continue;
    try {
      if ((await entryAge(dataDir, name, now)) > STALE_MS) {
        await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
      }
    } catch {
      // Best effort.
    }
  }
}

async function readActive(dataDir) {
  try {
    const name = (await fs.readFile(path.join(dataDir, ACTIVE_FILE), 'utf8')).trim();
    if (!/^cache-\d+-[0-9a-f]+$/.test(name)) return null;
    return (await fs.stat(path.join(dataDir, name))).isDirectory() ? name : null;
  } catch {
    return null;
  }
}

/** Start a new, empty cache generation and make it the active one. */
async function newGeneration(dataDir, now = Date.now()) {
  await fs.mkdir(dataDir, { recursive: true });
  const name = `${GENERATION_PREFIX}${now}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.mkdir(path.join(dataDir, name));
  const tmp = path.join(dataDir, `${ACTIVE_FILE}.${process.pid}.tmp`);
  await fs.writeFile(tmp, name);
  await fs.rename(tmp, path.join(dataDir, ACTIVE_FILE));
  await cleanup(dataDir, name, now);
  return path.join(dataDir, name);
}

/** The active cache directory, creating the first generation if needed. */
async function cacheDir(dataDir, now = Date.now()) {
  await fs.mkdir(dataDir, { recursive: true });
  const active = await readActive(dataDir);
  if (!active) return newGeneration(dataDir, now);
  await cleanup(dataDir, active, now);
  return path.join(dataDir, active);
}

/** Does this cache directory already hold a downloaded budget? */
async function hasCachedBudget(dir) {
  try {
    for (const name of await fs.readdir(dir)) {
      if (await fs.stat(path.join(dir, name, 'metadata.json')).then(() => true, () => false)) return true;
    }
  } catch {
    // Missing directory: no cache.
  }
  return false;
}

function shouldRefresh(err) {
  if (NO_REFRESH_CODES.has(err?.code)) return false;
  return !/network|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|unauthori[sz]ed|token/i.test(String(err?.message));
}

async function safeShutdown() {
  try {
    await api.shutdown();
  } catch (err) {
    console.error('Error shutting down Actual API:', err.message);
  }
}

/**
 * Open the configured budget (from the local cache when possible), run
 * `fn(api)`, then always shut down. Calls are serialized.
 */
function withBudget(actual, dataDir, fn) {
  return serialize(async () => {
    assertConfigured(actual);
    let dir = await cacheDir(dataDir);
    let initialised = false;
    const open = async (d) => {
      await api.init(initOptions(actual, d));
      initialised = true;
      await api.downloadBudget(
        actual.budgetId,
        actual.budgetEncryption ? { password: actual.budgetEncryption } : undefined,
      );
    };
    try {
      try {
        await open(dir);
      } catch (err) {
        if (!initialised || !shouldRefresh(err) || !(await hasCachedBudget(dir))) throw err;
        console.warn(`Cached budget could not be brought up to date (${err.code || err.message}); downloading a fresh copy.`);
        await safeShutdown();
        initialised = false;
        dir = await newGeneration(dataDir);
        await open(dir);
      }
      return await fn(api);
    } finally {
      if (initialised) await safeShutdown();
    }
  });
}

module.exports = {
  withBudget,
  serialize,
  initOptions,
  assertConfigured,
  cacheDir,
  newGeneration,
  hasCachedBudget,
  shouldRefresh,
  STALE_MS,
};
