'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const upBank = require('./upBank');
const { withBudget } = require('./actual');
const { SyncInProgressError } = require('./sync');
const initialise = require('./initialise');

// Sentinel value for the link page's "create new Actual account" option.
const CREATE_NEW = '__create__';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function basicAuth(username, password) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      // Evaluate both comparisons to avoid leaking which one failed.
      const ok = safeEqual(u, username) & safeEqual(p, password);
      if (idx !== -1 && ok) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="up-actual-sync", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

/** Reject cross-site form posts (browsers send Origin on POST). */
function sameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch {
    // fall through
  }
  res.status(403).send('Cross-origin request blocked');
}

/**
 * @param {object} deps
 * @param {import('nconf').Provider} deps.store
 * @param {ReturnType<typeof config.settings>} deps.settings
 * @param {() => Promise<any>} deps.runSync
 * @param {() => object|null} deps.getLastSync
 * @param {typeof upBank} [deps.upClient]
 * @param {typeof initialise.createAccounts} [deps.createAccounts]
 */
function createApp({
  store,
  settings,
  runSync,
  getLastSync,
  upClient = upBank,
  createAccounts = initialise.createAccounts,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, '..', 'views'));

  if (settings.webUIUsername && settings.webUIPassword) {
    app.use(basicAuth(settings.webUIUsername, settings.webUIPassword));
  } else {
    console.warn('Web UI has no authentication. Set webUIUsername and webUIPassword to enable basic auth.');
  }

  app.use(express.urlencoded({ extended: false }));
  app.use(sameOrigin);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/', (req, res) => {
    res.render('index', {
      lastSync: getLastSync(),
      linkedCount: Object.keys(config.getLinkedAccounts(store)).length,
    });
  });

  function setupView(extra = {}) {
    const actual = config.getActual(store);
    return {
      hasToken: !!config.getUpToken(store),
      hasServerPassword: !!actual.serverPassword,
      hasApiKey: !!actual.apiKey,
      hasEncryption: !!actual.budgetEncryption,
      serverUrl: actual.serverUrl,
      budgetId: actual.budgetId,
      ...extra,
    };
  }

  app.get('/setup', (req, res) => {
    res.render('setup', setupView());
  });

  app.post('/setup', async (req, res) => {
    const body = req.body || {};
    const current = config.getActual(store);
    // Blank secret fields mean "keep the saved value".
    const token = (body.token || '').trim() || config.getUpToken(store);
    const actual = {
      serverUrl: (body.serverUrl || '').trim(),
      budgetId: (body.budgetId || '').trim(),
      serverPassword: body.clearServerPassword ? '' : body.serverPassword || current.serverPassword,
      apiKey: body.clearApiKey ? '' : (body.apiKey || '').trim() || current.apiKey,
      budgetEncryption: body.clearEncryption ? '' : body.budgetEncryption || current.budgetEncryption,
    };
    const form = { serverUrl: actual.serverUrl, budgetId: actual.budgetId };
    if (!actual.apiKey && !actual.serverPassword) {
      return res
        .status(400)
        .render('setup', setupView({ ...form, error: 'Enter an Actual API key or server password.' }));
    }

    try {
      if (!(await upClient.validate(token))) {
        return res.status(400).render('setup', setupView({ ...form, error: 'Up API token is not valid.' }));
      }
    } catch (err) {
      return res.status(502).render('setup', setupView({ ...form, error: `Could not reach Up: ${err.message}` }));
    }

    try {
      await withBudget(actual, settings.dataDir, (api) => api.getAccounts());
    } catch (err) {
      return res
        .status(400)
        .render('setup', setupView({ ...form, error: `Could not open Actual budget: ${err.message}` }));
    }

    store.set('UP:token', token);
    store.set('actual', actual);
    await config.save(store);
    res.render('setup', setupView({ success: true }));
  });

  app.get('/link', async (req, res) => {
    const token = config.getUpToken(store);
    const actual = config.getActual(store);
    const upAccounts = await upClient.getAccounts(token);
    const actualAccounts = await withBudget(actual, settings.dataDir, (api) => api.getAccounts());
    res.render('link', {
      upAccounts: upAccounts.map((a) => ({
        id: a.id,
        displayName: a.attributes.displayName,
        accountType: a.attributes.accountType,
        ownershipType: a.attributes.ownershipType,
      })),
      actualAccounts: actualAccounts
        .filter((a) => !a.closed)
        .sort((a, b) => a.name.localeCompare(b.name)),
      linkedAccounts: config.getLinkedAccounts(store),
      saved: req.query.saved === '1',
      defaultStartDate: initialise.defaultStartDate(),
      createNew: CREATE_NEW,
    });
  });

  async function createAndLink(res, upAccountIds, startDate) {
    let created;
    try {
      created = await createAccounts({
        token: config.getUpToken(store),
        actual: config.getActual(store),
        dataDir: settings.dataDir,
        upAccountIds,
        startDate,
      });
    } catch (err) {
      return res.status(400).render('error', { message: `Could not create accounts: ${err.message}` });
    }
    const linked = config.getLinkedAccounts(store);
    const importFrom = config.getImportFrom(store);
    for (const c of created) {
      linked[c.upAccountId] = c.actualAccountId;
      importFrom[c.upAccountId] = startDate;
    }
    store.set('linkedAccounts', linked);
    store.set('importFrom', importFrom);
    await config.save(store);
    res.render('created', { created, startDate });
  }

  app.post('/accounts/create', async (req, res) => {
    const body = req.body || {};
    await createAndLink(res, [].concat(body.upAccountIds || []), (body.startDate || '').trim());
  });

  app.post('/link', async (req, res) => {
    const linked = config.getLinkedAccounts(store);
    const upId = req.body?.account;
    const actualId = req.body?.accID;
    if (!upId) return res.status(400).send('Missing account');
    if (actualId === CREATE_NEW) {
      const upAccount = await upClient.getAccount(config.getUpToken(store), upId);
      return createAndLink(res, [upId], initialise.startDateFor(upAccount));
    }
    if (linked[upId] !== actualId) {
      // A start date only applies to the account this tool created.
      const importFrom = config.getImportFrom(store);
      delete importFrom[upId];
      store.set('importFrom', importFrom);
    }
    if (actualId) linked[upId] = actualId;
    else delete linked[upId];
    store.set('linkedAccounts', linked);
    await config.save(store);
    res.redirect('/link?saved=1');
  });

  app.post('/sync', async (req, res) => {
    try {
      const results = await runSync();
      res.json({ ok: true, results });
    } catch (err) {
      if (err instanceof SyncInProgressError) {
        return res.status(409).json({ ok: false, error: err.message });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Express 5 forwards rejected promises from async handlers here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { message: err.message });
  });

  return app;
}

module.exports = { createApp, basicAuth, sameOrigin };
