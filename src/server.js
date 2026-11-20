'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const upBank = require('./upBank');
const { withBudget } = require('./actual');
const { SyncInProgressError } = require('./sync');
const initialise = require('./initialise');
const repair = require('./repair');

// Sentinel values for the link page's "create new Actual account" options.
const CREATE_NEW = '__create__';
const CREATE_NEW_OFF_BUDGET = '__create_off_budget__';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Links whose Up account no longer exists (e.g. a deleted saver). */
function staleLinks(linkedAccounts, upAccounts, actualAccounts) {
  const upIds = new Set(upAccounts.map((a) => a.id));
  return Object.entries(linkedAccounts)
    .filter(([upId, actualId]) => actualId && !upIds.has(upId))
    .map(([upId, actualId]) => {
      const acc = actualAccounts.find((a) => a.id === actualId);
      return { upId, actualName: acc ? `${acc.name}${acc.closed ? ' (closed)' : ''}` : '(not in Actual)' };
    });
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
  linkTransfers = repair.linkExistingTransfers,
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
      staleLinks: staleLinks(config.getLinkedAccounts(store), upAccounts, actualAccounts),
      saved: req.query.saved === '1',
      defaultStartDate: initialise.defaultStartDate(),
      createNew: CREATE_NEW,
      createNewOffBudget: CREATE_NEW_OFF_BUDGET,
    });
  });

  async function transfers(req, res, dryRun) {
    let result;
    try {
      result = await linkTransfers({
        token: config.getUpToken(store),
        actual: config.getActual(store),
        linkedAccounts: config.getLinkedAccounts(store),
        importFrom: config.getImportFrom(store),
        dataDir: settings.dataDir,
        dryRun,
      });
    } catch (err) {
      const status = err instanceof SyncInProgressError ? 409 : 400;
      return res.status(status).render('error', { message: `Could not link transfers: ${err.message}` });
    }
    res.render('transfers', { result, done: !dryRun });
  }

  app.post('/transfers/preview', (req, res) => transfers(req, res, true));
  app.post('/transfers/link', (req, res) => {
    if (req.body?.confirm !== '1') return res.redirect('/link');
    return transfers(req, res, false);
  });

  async function createAndLink(res, upAccountIds, startDate, offBudgetIds) {
    let created;
    try {
      created = await createAccounts({
        token: config.getUpToken(store),
        actual: config.getActual(store),
        dataDir: settings.dataDir,
        upAccountIds,
        offBudgetIds,
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
    const upAccountIds = [].concat(body.upAccountIds || []);
    const offBudgetIds = [].concat(body.offBudgetIds || []).filter((id) => upAccountIds.includes(id));
    await createAndLink(res, upAccountIds, (body.startDate || '').trim(), offBudgetIds);
  });

  app.post('/link', async (req, res) => {
    const linked = config.getLinkedAccounts(store);
    const upId = req.body?.account;
    const actualId = req.body?.accID;
    if (!upId) return res.status(400).send('Missing account');
    if (actualId === CREATE_NEW || actualId === CREATE_NEW_OFF_BUDGET) {
      const upAccount = await upClient.getAccount(config.getUpToken(store), upId);
      const offBudgetIds = actualId === CREATE_NEW_OFF_BUDGET ? [upId] : [];
      return createAndLink(res, [upId], initialise.startDateFor(upAccount), offBudgetIds);
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

module.exports = { createApp, basicAuth, sameOrigin, staleLinks };
