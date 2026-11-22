'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lastSync = require('../src/lastSync');

test('last sync round-trips names and counts only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uas-last-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'last-sync.json');
  assert.equal(lastSync.load(file), null, 'missing file');
  lastSync.save(file, { at: '2026-11-22T00:00:00Z', ok: true, trigger: 'schedule', results: [
    { upAccountId: 'u1', actualAccountId: 'a1', name: 'Spending', added: 2, updated: 1, transfers: 0, deferred: 3, errors: [] },
    { upAccountId: 'u2', name: 'Old', added: 0, updated: 0, transfers: 0, goneFromUp: true, errors: ['gone'] },
  ] });
  assert.deepEqual(lastSync.load(file), { at: '2026-11-22T00:00:00Z', ok: true, trigger: 'schedule', results: [
    { upAccountId: 'u1', name: 'Spending', added: 2, updated: 1, transfers: 0, errors: [] },
    { upAccountId: 'u2', name: 'Old', added: 0, updated: 0, transfers: 0, goneFromUp: true, errors: ['gone'] },
  ] });
  lastSync.save(file, { at: '2026-11-22T01:00:00Z', ok: false, trigger: 'manual', error: 'boom' });
  assert.deepEqual(lastSync.load(file), { at: '2026-11-22T01:00:00Z', ok: false, trigger: 'manual', error: 'boom' });
  fs.writeFileSync(file, '{"at": 1}');
  assert.equal(lastSync.load(file), null, 'invalid shape');
});
