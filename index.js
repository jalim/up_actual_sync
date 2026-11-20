'use strict';

const cron = require('node-cron');
const config = require('./src/config');
const sync = require('./src/sync');
const { createApp } = require('./src/server');

const store = config.load();
const settings = config.settings(store);

let lastSync = null;

async function runSync() {
  const at = new Date().toISOString();
  try {
    const results = await sync.run({
      token: config.getUpToken(store),
      actual: config.getActual(store),
      linkedAccounts: config.getLinkedAccounts(store),
      importFrom: config.getImportFrom(store),
      dataDir: settings.dataDir,
      syncDays: settings.syncDays,
    });
    lastSync = { at, ok: true, results };
    return results;
  } catch (err) {
    if (!(err instanceof sync.SyncInProgressError)) {
      lastSync = { at, ok: false, error: err.message };
    }
    throw err;
  }
}

if (!settings.webUI && !settings.cronEnabled) {
  console.warn('Neither webUI nor cronEnabled is set; nothing to do. Set webUI=true and/or cronEnabled=true.');
}

if (settings.webUI) {
  const app = createApp({ store, settings, runSync, getLastSync: () => lastSync });
  app.listen(settings.port, () => {
    console.log(`Web UI listening on port ${settings.port}`);
  });
}

if (settings.cronEnabled) {
  let schedule = settings.cronSchedule;
  if (!cron.validate(schedule)) {
    console.warn(`Invalid cronSchedule "${schedule}"; defaulting to hourly (${config.DEFAULT_CRON})`);
    schedule = config.DEFAULT_CRON;
  }
  console.log(`Scheduled sync: ${schedule}`);
  cron.schedule(schedule, async () => {
    if (sync.isRunning()) {
      console.log('Skipping scheduled sync; previous sync still running.');
      return;
    }
    try {
      await runSync();
    } catch (err) {
      console.error('Scheduled sync failed:', err.message);
    }
  }, { noOverlap: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`Received ${signal}, exiting.`);
    process.exit(0);
  });
}
