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
const { describeSchedule } = require('./schedule');

// Choices on the Accounts page for an Up account that isn't linked yet.
const CREATE = 'create';
const CREATE_OFF_BUDGET = 'create-offbudget';

const PAGE_TITLES = { '/': 'Overview', '/link': 'Accounts', '/setup': 'Connection settings', '/ofx': 'Statement imports' };

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

/** Preselect an unused Actual account with the same name; on first setup, otherwise create one. */
function suggestedChoice(upAccount, actualAccounts, used, firstSetup) {
  const name = upAccount.displayName.trim().toLowerCase();
  const match = actualAccounts.find((a) => !used.has(a.id) && a.name.trim().toLowerCase() === name);
  if (match) return match.id;
  if (!firstSetup) return '';
  return upAccount.accountType === 'HOME_LOAN' ? CREATE_OFF_BUDGET : CREATE;
}

function syncState(lastSync) {
  if (!lastSync) return 'idle';
  if (!lastSync.ok) return 'error';
  return lastSync.results.some((r) => r.errors?.length) ? 'warning' : 'ok';
}

/** Overview label for the last sync, including per-account errors. */
function syncLabel(lastSync) {
  if (!lastSync) return 'Not yet synced';
  if (!lastSync.ok) return 'Needs attention';
  return lastSync.results.some((r) => r.errors?.length) ? 'Completed with issues' : 'Completed';
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
  getNextRun = () => null,
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

  app.use((req, res, next) => {
    const accountPage = req.path.startsWith('/transfers') || req.path.startsWith('/accounts');
    const page = accountPage ? '/link' : req.path;
    res.locals.activePath = page;
    res.locals.title = PAGE_TITLES[page];
    // Where an error page's "Back" button goes.
    res.locals.backPath = PAGE_TITLES[page] ? page : '/';
    next();
  });

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
    const lastSync = getLastSync();
    const links = Object.entries(config.getLinkedAccounts(store)).filter(([, actualId]) => actualId);
    // The overview doesn't call Up; the last sync says which links point at deleted Up accounts.
    const gone = new Set((lastSync?.results || []).filter((r) => r.goneFromUp).map((r) => r.upAccountId));
    const staleCount = links.filter(([upId]) => gone.has(upId)).length;
    const configured = isConfigured();
    const linkedCount = links.length - staleCount;
    const results = lastSync?.ok ? lastSync.results : [];
    res.render('index', {
      lastSync,
      syncLabel: syncLabel(lastSync),
      syncState: syncState(lastSync),
      added: results.reduce((n, r) => n + (r.added || 0), 0),
      updated: results.reduce((n, r) => n + (r.updated || 0), 0),
      cronEnabled: settings.cronEnabled,
      cronSchedule: settings.cronSchedule,
      scheduleText: describeSchedule(settings.cronSchedule),
      nextRun: settings.cronEnabled ? getNextRun() : null,
      configured,
      linkedCount,
      staleCount,
      // Getting started checklist, shown until the first sync has run.
      steps: lastSync && configured && linkedCount ? null : [
        { label: 'Connect Up and Actual', href: '/setup', done: configured },
        { label: 'Link your Up accounts', href: '/link', done: configured && linkedCount > 0 },
        { label: 'Run your first sync', done: !!lastSync?.ok },
      ],
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

  function isConfigured() {
    const actual = config.getActual(store);
    return !!(config.getUpToken(store) && actual.serverUrl && actual.budgetId && (actual.apiKey || actual.serverPassword));
  }

  app.get('/setup', (req, res) => {
    res.render('setup', setupView({ needsSetup: req.query.next === 'link' && !isConfigured() }));
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
    res.render('setup', setupView({ success: true, linkedCount: Object.keys(config.getLinkedAccounts(store)).length }));
  });

  app.get('/link', async (req, res) => {
    if (!isConfigured()) return res.redirect('/setup?next=link');
    const token = config.getUpToken(store);
    const actual = config.getActual(store);
    const upAccounts = await upClient.getAccounts(token);
    const actualAccounts = await withBudget(actual, settings.dataDir, (api) => api.getAccounts());
    const linkedAccounts = config.getLinkedAccounts(store);
    const open = actualAccounts.filter((a) => !a.closed).sort((a, b) => a.name.localeCompare(b.name));
    const used = new Set(Object.values(linkedAccounts));
    const accounts = upAccounts.map((a) => ({
      id: a.id,
      displayName: a.attributes.displayName,
      accountType: a.attributes.accountType,
      ownershipType: a.attributes.ownershipType,
      linkedTo: linkedAccounts[a.id] || '',
    }));
    res.render('link', {
      linked: accounts.filter((a) => a.linkedTo),
      // On first setup every Up account defaults to "create"; later, unlinked
      // accounts are usually unlinked on purpose, so only a name match is preselected.
      unlinked: accounts.filter((a) => !a.linkedTo).map((a) => ({ ...a, suggested: suggestedChoice(a, open, used, !used.size) })),
      actualAccounts: open,
      staleLinks: staleLinks(linkedAccounts, upAccounts, actualAccounts),
      saved: /^\d+$/.test(req.query.saved || '') ? req.query.saved : undefined,
      defaultStartDate: initialise.defaultStartDate(),
      CREATE,
      CREATE_OFF_BUDGET,
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

  async function createAndLink(res, upAccountIds, startDate, offBudgetIds, linkedExisting = 0) {
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
    res.render('created', { created, startDate, linkedExisting });
  }

  /** Link (or unlink, with '') Up accounts to existing Actual accounts. */
  function applyLinks(changes) {
    const linked = config.getLinkedAccounts(store);
    const importFrom = config.getImportFrom(store);
    let changed = 0;
    for (const [upId, actualId] of changes) {
      if ((linked[upId] || '') === actualId) continue;
      // A start date only applies to the account this tool created.
      delete importFrom[upId];
      if (actualId) linked[upId] = actualId;
      else delete linked[upId];
      changed++;
    }
    store.set('linkedAccounts', linked);
    store.set('importFrom', importFrom);
    return changed;
  }

  // Add Up accounts: create new Actual accounts and/or link existing ones.
  app.post('/accounts/add', async (req, res) => {
    const body = req.body || {};
    const choices = Object.entries(body)
      .filter(([key, value]) => key.startsWith('choice:') && typeof value === 'string' && value)
      .map(([key, value]) => [key.slice('choice:'.length), value]);
    const create = choices.filter(([, v]) => v === CREATE || v === CREATE_OFF_BUDGET);
    const existing = choices.filter(([, v]) => v !== CREATE && v !== CREATE_OFF_BUDGET);
    if (!choices.length) return res.redirect('/link');
    const linkedExisting = applyLinks(existing);
    await config.save(store);
    if (!create.length) return res.redirect(`/link?saved=${linkedExisting}`);
    const offBudgetIds = create.filter(([, v]) => v === CREATE_OFF_BUDGET).map(([id]) => id);
    return createAndLink(res, create.map(([id]) => id), (body.startDate || '').trim(), offBudgetIds, linkedExisting);
  });

  // Change existing links: one account (account/accID) or the whole list (link:<upId> fields).
  app.post('/link', async (req, res) => {
    const body = req.body || {};
    const changes = body.account !== undefined
      ? [[body.account, body.accID || '']]
      : Object.entries(body).filter(([key]) => key.startsWith('link:')).map(([key, value]) => [key.slice('link:'.length), String(value || '')]);
    if (!changes.length || changes.some(([upId]) => !upId)) return res.status(400).send('Missing account');
    const changed = applyLinks(changes);
    await config.save(store);
    res.redirect(`/link?saved=${changed}`);
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

module.exports = { createApp, basicAuth, sameOrigin, staleLinks, syncLabel, suggestedChoice };
