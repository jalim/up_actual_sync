'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');

test('parseBool treats "false" and "0" as false', () => {
  for (const v of ['false', 'FALSE', '0', 'no', 'off', 'nonsense']) assert.equal(config.parseBool(v), false, v);
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', true]) assert.equal(config.parseBool(v), true, String(v));
  assert.equal(config.parseBool(undefined, true), true);
  assert.equal(config.parseBool('', true), true);
});

test('parsePositiveInt falls back on junk', () => {
  assert.equal(config.parsePositiveInt('7', 5), 7);
  assert.equal(config.parsePositiveInt('-1', 5), 5);
  assert.equal(config.parsePositiveInt('abc', 5), 5);
});

test('legacy budgetEncryption "true" checkbox value is ignored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ actual: { budgetId: 'b', budgetEncryption: 'true' } }));
  t.mock.method(console, 'warn', () => {});
  const store = config.load(file);
  assert.equal(config.getActual(store).budgetEncryption, '');
  assert.equal(config.getActual(store).budgetId, 'b');
});

test('settings parses string env-style values', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ webUI: 'false', cronEnabled: 'true', syncDays: '14', port: '8080' }));
  const s = config.settings(config.load(file));
  assert.equal(s.webUI, false);
  assert.equal(s.cronEnabled, true);
  assert.equal(s.syncDays, 14);
  assert.equal(s.port, 8080);
});
