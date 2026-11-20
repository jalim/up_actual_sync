'use strict';

const nconf = require('nconf');

const DEFAULT_CRON = '0 * * * *';
const DEFAULT_SYNC_DAYS = 5;

/**
 * Environment variables always arrive as strings, so "false" must not be
 * treated as truthy.
 */
function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load configuration in priority order:
 *   1. Command-line arguments
 *   2. Environment variables (nested keys use "__", e.g. UP__token)
 *   3. The JSON config file
 *   4. Defaults
 */
function load(configFile = process.env.configFile || './config.json') {
  const store = new nconf.Provider();
  store
    .argv()
    .env({ separator: '__' })
    .file({ file: configFile })
    .defaults({ port: 3000 });

  // Older versions stored a checkbox value ("true") in budgetEncryption
  // instead of the actual encryption password. Treat that as unset.
  const enc = store.get('actual:budgetEncryption');
  if (enc === true || enc === 'true') {
    console.warn(
      'Config: actual.budgetEncryption is set to "true" rather than a password. ' +
        'Ignoring it; set the budget encryption password in the setup page if your budget is encrypted.',
    );
    store.set('actual:budgetEncryption', '');
  }

  return store;
}

function settings(store) {
  return {
    port: parsePositiveInt(store.get('port'), 3000),
    webUI: parseBool(store.get('webUI')),
    cronEnabled: parseBool(store.get('cronEnabled')),
    cronSchedule: store.get('cronSchedule') || DEFAULT_CRON,
    syncDays: parsePositiveInt(store.get('syncDays'), DEFAULT_SYNC_DAYS),
    webUIUsername: store.get('webUIUsername') || '',
    webUIPassword: store.get('webUIPassword') || '',
    // Scratch space for the downloaded budget; wiped before and after each
    // session, so deliberately not user-configurable.
    dataDir: require('node:path').join(__dirname, '..', 'budgets'),
  };
}

function getUpToken(store) {
  return store.get('UP:token') || '';
}

function getActual(store) {
  const a = store.get('actual') || {};
  return {
    serverUrl: a.serverUrl || '',
    serverPassword: a.serverPassword || '',
    // Budget-scoped API key (Settings → General → Security → API keys).
    // Required when the server uses OpenID, where there is no password.
    apiKey: a.apiKey || '',
    budgetId: a.budgetId || '',
    budgetEncryption: a.budgetEncryption || '',
  };
}

function getLinkedAccounts(store) {
  return { ...(store.get('linkedAccounts') || {}) };
}

function save(store) {
  return new Promise((resolve, reject) => {
    store.save((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DEFAULT_CRON,
  parseBool,
  parsePositiveInt,
  load,
  settings,
  getUpToken,
  getActual,
  getLinkedAccounts,
  save,
};
