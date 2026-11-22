'use strict';

const path = require('node:path');
const cron = require('node-cron');
const config = require('./src/config');
const sync = require('./src/sync');
const lastSyncFile = require('./src/lastSync');
const { createApp } = require('./src/server');

const store = config.load();
const settings = config.settings(store);
const stateFile = path.join(path.dirname(path.resolve(store.stores.file.file)), 'last-sync.json');

let lastSync = lastSyncFile.load(stateFile);
let scheduledTask = null;

function record(result) {
  lastSync = result;
  lastSyncFile.save(stateFile, result);
}

async function runSync(trigger = 'manual') {
  const at = new Date().toISOString();
  try {
    const results = await sync.run({
      token: config.getUpToken(store),
      actual: config.getActual(store),
      linkedAccounts: config.getLinkedAccounts(store),
      importFrom: config.getImportFrom(store),
      categorySettings: config.getCategorySettings(store),
      ofxAccounts: config.getOfxAccounts(store),
      dataDir: settings.dataDir,
      syncDays: settings.syncDays,
    });
    record({ at, ok: true, trigger, results });
    return results;
  } catch (err) {
    if (!(err instanceof sync.SyncInProgressError)) {
      record({ at, ok: false, trigger, error: err.message });
    }
    throw err;
  }
}

if (!settings.webUI && !settings.cronEnabled) {
  console.warn('Neither webUI nor cronEnabled is set; nothing to do. Set webUI=true and/or cronEnabled=true.');
}

if (settings.cronEnabled) {
  if (!cron.validate(settings.cronSchedule)) {
    console.warn(`Invalid cronSchedule "${settings.cronSchedule}"; defaulting to hourly (${config.DEFAULT_CRON})`);
    settings.cronSchedule = config.DEFAULT_CRON;
  }
  console.log(`Scheduled sync: ${settings.cronSchedule}`);
  scheduledTask = cron.schedule(settings.cronSchedule, async () => {
    if (sync.isRunning()) {
      console.log('Skipping scheduled sync; previous sync still running.');
      return;
    }
    try {
      await runSync('schedule');
    } catch (err) {
      console.error('Scheduled sync failed:', err.message);
    }
  }, { noOverlap: true });
}

if (settings.webUI) {
  const app = createApp({
    store,
    settings,
    runSync: () => runSync('manual'),
    getLastSync: () => lastSync,
    getNextRun: () => scheduledTask?.getNextRun()?.toISOString() || null,
  });
  app.listen(settings.port, () => {
    console.log(`Web UI listening on port ${settings.port}`);
  });
}

// Last line of defence for stray background failures (e.g. a late write
// inside @actual-app/api): log them instead of taking the web server down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled background error (continuing):', reason);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`Received ${signal}, exiting.`);
    process.exit(0);
  });
}
