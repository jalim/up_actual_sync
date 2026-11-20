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
const ofx = require('./ofx');
const ofxImport = require('./ofxImport');

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
  openBudget = withBudget,
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
  app.use(express.json({ limit: '12mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Parsed uploads stay in memory for 30 minutes, never in the config or on disk.
  const previews = new Map();
  let importingOfx = false;
  app.get('/ofx', (req, res) => res.render('ofx'));
  app.post('/ofx/preview', async (req, res) => {
    try {
      const files = req.body?.files;
      if (!Array.isArray(files) || !files.length || files.length > 10) throw new Error('Select between 1 and 10 OFX files');
      let totalBytes = 0;
      const statements = ofx.combine(files.flatMap((f) => {
        if (typeof f.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)) throw new Error('Invalid file upload');
        const data = Buffer.from(f.content, 'base64');
        if (data.length > 5 * 1024 * 1024) throw new Error('Each OFX file must be smaller than 5 MB');
        totalBytes += data.length;
        if (totalBytes > 8 * 1024 * 1024) throw new Error('OFX files must be smaller than 8 MB in total');
        return ofx.parse(data);
      }));
      const mappings = config.getOfxAccounts(store);
      // Read-only: work out what is already in Actual so the preview can show
      // only what an import would add.
      const details = await openBudget(config.getActual(store), settings.dataDir, async (api) => {
        const accounts = (await api.getAccounts()).filter((a) => !a.closed);
        const latest = {};
        const importedIds = {};
        const notes = {};
        const balances = {};
        const balanceDates = [...new Set(statements.map((s) => s.balanceDate))];
        for (const a of accounts) {
          // Balances on each statement date let the preview check the closing
          // balance (and its sign) before anything is imported.
          balances[a.id] = {};
          for (const d of balanceDates) balances[a.id][d] = await api.getAccountBalance(a.id, new Date(`${d}T12:00:00`));
          notes[a.id] = (await api.getNote(a.id))?.note || '';
          const rows = await api.getTransactions(a.id, '0001-01-01', '9999-12-31');
          latest[a.id] = rows.reduce((d, t) => (t.date > d ? t.date : d), '') || null;
          if (Object.values(mappings).some((m) => m.actualAccountId === a.id)) {
            importedIds[a.id] = new Set(rows.map((t) => t.imported_id).filter(Boolean));
          }
        }
        return { accounts, latest, importedIds, notes, balances, categories: await api.getCategories() };
      });
      const upAccountIds = Object.values(config.getLinkedAccounts(store));
      const taken = new Set([...upAccountIds, ...Object.keys(mappings)
        .map((key) => ofxImport.activeMapping(mappings, key, details.accounts)?.actualAccountId).filter(Boolean)]);
      const suggestions = ofxImport.suggestAccounts(
        statements.filter((s) => !ofxImport.activeMapping(mappings, s.key, details.accounts)), details.accounts, details.notes, taken);
      const token = crypto.randomBytes(24).toString('hex');
      const discard = (key) => {
        clearTimeout(previews.get(key)?.timer);
        previews.delete(key);
      };
      for (const [key, p] of previews) if (p.expires < Date.now()) discard(key);
      while (previews.size >= 10) discard(previews.keys().next().value);
      const timer = setTimeout(() => previews.delete(token), 30 * 60000);
      timer.unref();
      previews.set(token, { statements, expires: Date.now() + 30 * 60000, scope: config.ofxScope(store), timer });
      res.json({ token, accounts: details.accounts.map((a) => ({ ...a, latest: details.latest[a.id], balances: details.balances[a.id] })),
        categories: details.categories.filter((c) => !c.hidden),
        upAccountIds,
        statements: statements.map((s) => {
          const saved = ofxImport.activeMapping(mappings, s.key, details.accounts);
          const seen = saved ? details.importedIds[saved.actualAccountId] : new Set();
          return { key: s.key, maskedAccount: `…${s.accountId.slice(-4)}`,
            start: s.start, end: s.end, balanceDate: s.balanceDate, balance: s.balance,
            closingBalance: mappings[s.key]?.balanceSign ? s.balance * mappings[s.key].balanceSign : s.suggestedBalance,
            name: `P&N ${s.loan ? 'Home Loan' : 'Account'} ${s.accountId.slice(-4)}`, offbudget: s.loan,
            skipped: s.skipped, saved, relink: !saved && !!mappings[s.key], suggestion: suggestions.get(s.key) || null,
            transactions: s.transactions.map((t) => ({ ...t, imported: seen.has(t.imported_id) })) };
        }),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.post('/ofx/import', async (req, res) => {
    if (importingOfx) return res.status(409).json({ error: 'An OFX import is already running' });
    const preview = previews.get(req.body?.token);
    if (!preview || preview.expires < Date.now() || preview.scope !== config.ofxScope(store)) {
      return res.status(400).json({ error: 'Preview expired or budget changed; upload the files again' });
    }
    importingOfx = true;
    try {
      const result = await openBudget(config.getActual(store), settings.dataDir, (api) => ofxImport.importStatements(api, {
        statements: preview.statements, choices: req.body.choices,
        mappings: config.getOfxAccounts(store), upAccountIds: Object.values(config.getLinkedAccounts(store)),
        saveMappings: (m) => config.setOfxAccounts(store, m),
      }));
      clearTimeout(preview.timer);
      previews.delete(req.body.token);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: `${err.message}. Any completed accounts/imports are saved; retry the upload to continue.` });
    } finally {
      importingOfx = false;
    }
  });

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
        categorySettings: config.getCategorySettings(store),
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
        categorySettings: config.getCategorySettings(store),
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
    if (req.path.startsWith('/ofx/')) {
      // Body-parser errors include the uploaded body; do not log bank data.
      return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? 'Upload is too large (8 MB total file limit)' : 'Could not read this upload request' });
    }
    console.error(err);
    res.status(500).render('error', { message: err.message });
  });

  return app;
}

module.exports = { createApp, basicAuth, sameOrigin, staleLinks };
