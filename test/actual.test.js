'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initOptions, assertConfigured } = require('../src/actual');

const base = { serverUrl: 'https://a.example', budgetId: 'b' };

test('API key is sent as sessionToken and takes precedence over the password', () => {
  assert.deepEqual(initOptions({ ...base, apiKey: 'key', serverPassword: 'pw' }, '/d'), {
    dataDir: '/d',
    serverURL: 'https://a.example',
    sessionToken: 'key',
  });
});

test('password is used when there is no API key', () => {
  assert.deepEqual(initOptions({ ...base, serverPassword: 'pw' }, '/d'), {
    dataDir: '/d',
    serverURL: 'https://a.example',
    password: 'pw',
  });
});

test('either an API key or a password is required', () => {
  assert.doesNotThrow(() => assertConfigured({ ...base, apiKey: 'key' }));
  assert.doesNotThrow(() => assertConfigured({ ...base, serverPassword: 'pw' }));
  assert.throws(() => assertConfigured(base), /apiKey or serverPassword/);
  assert.throws(() => assertConfigured({ apiKey: 'key' }), /serverUrl, budgetId/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const actualApi = require('@actual-app/api');
const { withBudget, cacheDir, newGeneration, hasCachedBudget, shouldRefresh, STALE_MS } = require('../src/actual');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cfg = { serverUrl: 'https://a.example', budgetId: 'sync-1', apiKey: 'k' };
const err = (code, message = code) => Object.assign(new Error(message), { code });

/** Stub the Actual API: downloadBudget writes a fake cached budget, or runs `download`. */
function stubApi(t, download = async () => {}) {
  const calls = { init: [], download: 0, shutdown: 0 };
  t.mock.method(actualApi, 'init', async (opts) => { calls.init.push(opts.dataDir); });
  t.mock.method(actualApi, 'shutdown', async () => { calls.shutdown++; });
  t.mock.method(actualApi, 'downloadBudget', async () => {
    calls.download++;
    const dir = calls.init[calls.init.length - 1];
    await download(dir, calls.download);
    fs.mkdirSync(path.join(dir, 'Budget-abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Budget-abc', 'metadata.json'), '{}');
  });
  t.mock.method(console, 'warn', () => {});
  return calls;
}

test('the budget cache directory is reused across sessions', async (t) => {
  const dataDir = tmp(t);
  const calls = stubApi(t);
  await withBudget(cfg, dataDir, async () => {});
  await withBudget(cfg, dataDir, async () => {});
  assert.equal(calls.init.length, 2);
  assert.equal(calls.init[0], calls.init[1]);
  assert.ok(await hasCachedBudget(calls.init[0]));
  assert.equal(calls.shutdown, 2);
  assert.equal(fs.readFileSync(path.join(dataDir, 'active'), 'utf8'), path.basename(calls.init[0]));
});

test('a cached budget that fails to update is re-downloaded into a new generation', async (t) => {
  const dataDir = tmp(t);
  let fail = false;
  const calls = stubApi(t, async (dir, n) => {
    if (fail && n === 2) throw err('out-of-sync-data');
  });
  await withBudget(cfg, dataDir, async () => {});
  const first = calls.init[0];
  fail = true;
  const result = await withBudget(cfg, dataDir, async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(calls.init.length, 3, 'init cached, then init fresh');
  assert.equal(calls.init[1], first);
  assert.notEqual(calls.init[2], first);
  assert.equal(fs.readFileSync(path.join(dataDir, 'active'), 'utf8'), path.basename(calls.init[2]));
  assert.ok(fs.existsSync(first), 'the old generation is kept until stale (late writes)');
});

test('network, auth and key errors are reported, not re-downloaded', async (t) => {
  const dataDir = tmp(t);
  let code = null;
  const calls = stubApi(t, async () => { if (code) throw err(code); });
  await withBudget(cfg, dataDir, async () => {});
  for (const c of ['network-failure', 'token-expired', 'missing-key']) {
    code = c;
    const before = calls.init.length;
    await assert.rejects(withBudget(cfg, dataDir, async () => {}), new RegExp(c));
    assert.equal(calls.init.length, before + 1, `${c}: no retry`);
  }
  assert.equal(shouldRefresh(new Error('fetch failed')), false);
  assert.equal(shouldRefresh(err('out-of-sync-migrations')), true);
});

test('a first download failure is not retried (there is no cache to blame)', async (t) => {
  const dataDir = tmp(t);
  const calls = stubApi(t, async () => { throw err('invalid-schema'); });
  await assert.rejects(withBudget(cfg, dataDir, async () => {}), /invalid-schema/);
  assert.equal(calls.init.length, 1);
  assert.equal(calls.shutdown, 1);
});

test('stale generations and older folders are cleaned up; the active one never is', async (t) => {
  const dataDir = tmp(t);
  const old = await newGeneration(dataDir, Date.now() - STALE_MS - 5000);
  const legacy = path.join(dataDir, 'session-1-abcd');
  fs.mkdirSync(legacy);
  const past = new Date(Date.now() - STALE_MS - 5000);
  fs.utimesSync(legacy, past, past);
  const recent = await newGeneration(dataDir, Date.now() - 60 * 1000);
  const current = await newGeneration(dataDir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(legacy), false);
  assert.ok(fs.existsSync(recent), 'recent generation kept (may still receive late writes)');
  assert.equal(await cacheDir(dataDir, Date.now() + STALE_MS * 10), current, 'active generation survives any age');
});
