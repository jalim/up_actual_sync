'use strict';

const fs = require('node:fs');

// The overview's "last sync" survives restarts in a small file next to the
// config. It holds only account names and counts, never transactions.

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data?.at !== 'string' || typeof data.ok !== 'boolean') return null;
    if (data.ok && !Array.isArray(data.results)) return null;
    return data;
  } catch {
    return null;
  }
}

function save(file, lastSync) {
  const data = {
    at: lastSync.at,
    ok: lastSync.ok,
    trigger: lastSync.trigger,
    ...(lastSync.ok
      ? { results: lastSync.results.map((r) => ({
          upAccountId: r.upAccountId, name: r.name, added: r.added, updated: r.updated,
          transfers: r.transfers, ...(r.goneFromUp && { goneFromUp: true }), errors: r.errors || [],
        })) }
      : { error: lastSync.error }),
  };
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`Could not save the last sync result: ${err.message}`);
  }
}

module.exports = { load, save };
