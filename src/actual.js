'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('@actual-app/api');

const SESSION_PREFIX = 'session-';
// @actual-app/api keeps writing budget metadata (with retries) for several
// seconds after shutdown() resolves. Deleting a session's directory before
// those writes finish makes them fail with ENOENT as an unhandled rejection,
// which crashes the process. So each session gets its own directory, and a
// directory is only removed once it is long stale.
const STALE_SESSION_MS = 10 * 60 * 1000;

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

/** Creation time of a session directory, from its name; falls back to mtime. */
async function entryAge(dir, name, now) {
  const m = name.startsWith(SESSION_PREFIX) && /^session-(\d+)-/.exec(name);
  if (m) return now - Number(m[1]);
  return now - (await fs.stat(path.join(dir, name))).mtimeMs;
}

/**
 * Create a fresh directory for one budget session under `dataDir`, removing
 * stale ones (including budget folders left by older versions) first.
 */
async function newSessionDir(dataDir, now = Date.now()) {
  await fs.mkdir(dataDir, { recursive: true });
  for (const name of await fs.readdir(dataDir)) {
    try {
      if ((await entryAge(dataDir, name, now)) > STALE_SESSION_MS) {
        await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
      }
    } catch {
      // Best effort: another session may be cleaning up concurrently.
    }
  }
  const dir = path.join(dataDir, `${SESSION_PREFIX}${now}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir);
  return dir;
}

/** An API key takes precedence over the password (OpenID servers have none). */
function initOptions(actual, dataDir) {
  const auth = actual.apiKey ? { sessionToken: actual.apiKey } : { password: actual.serverPassword };
  return { dataDir, serverURL: actual.serverUrl, ...auth };
}

/**
 * Open the configured budget in a fresh session directory, run `fn(api)`,
 * then always shut down. The local copy is left for Actual's late writes
 * and cleaned up by a later session. Calls are serialized.
 */
function withBudget(actual, dataDir, fn) {
  return serialize(async () => {
    assertConfigured(actual);
    const sessionDir = await newSessionDir(dataDir);
    let initialised = false;
    try {
      await api.init(initOptions(actual, sessionDir));
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
    }
  });
}

module.exports = { withBudget, serialize, initOptions, assertConfigured, newSessionDir, STALE_SESSION_MS };
