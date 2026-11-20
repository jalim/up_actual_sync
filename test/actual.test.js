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
