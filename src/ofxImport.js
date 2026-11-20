'use strict';

const crypto = require('node:crypto');
const { money } = require('./ofx');
const { isValidDate } = require('./initialise');

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const description = (t) => t.imported_payee || t.notes || '';
const reference = (t) => description(t).match(/\bRef#\s*(\d+)/i)?.[1];
const transferLike = (t) => /\btransfer\b|\bOsko Payment (?:To|From)\b|\bLoan Redraw\b|\bLoan Repayment\b/i.test(description(t));
const eligible = (t) => !t.transfer_id && !t.is_parent && !t.is_child && !t.reconciled && t.amount !== 0;
const nearby = (a, b) => Math.abs(Date.parse(a.date) - Date.parse(b.date)) <= 3 * 86400000;

/**
 * Up (or an Actual rule) may already have created the P&N half of a transfer.
 * That half has no OFX identity yet. Match it before adding any bank rows.
 */
async function existingTransferMatches(api, accountId, items, existing, upAccountIds) {
  const placeholders = existing.filter((t) => t.transfer_id && !t.imported_id && !t.is_parent && !t.is_child);
  if (!placeholders.length || !items.length || !upAccountIds.length) return new Map();
  const upRows = (await Promise.all(upAccountIds.map((id) => api.getTransactions(id, '0001-01-01', '9999-12-31')))).flat();
  const upById = new Map(upRows.map((t) => [t.id, t]));
  const candidates = new Map();
  for (const item of items) {
    if (!transferLike(item)) continue;
    const matches = placeholders.filter((p) => {
      const up = upById.get(p.transfer_id);
      return p.account === accountId && p.amount === item.amount && nearby(p, item) &&
        up?.transfer_id === p.id && up.amount === -item.amount;
    });
    if (matches.length) candidates.set(item.imported_id, matches);
  }
  const result = new Map();
  for (const [id, matches] of candidates) {
    const match = matches[0];
    const unique = matches.length === 1 && [...candidates.values()].filter((xs) => xs.some((t) => t.id === match.id)).length === 1;
    result.set(id, { match: unique ? match : null });
  }
  return result;
}

/** Use Actual's transfer machinery, then merge its generated half into the existing bank entry. */
async function linkPair(api, a, b, payees, category) {
  const payee = payees.get(b.account);
  if (!payee) throw new Error('Missing Actual transfer payee');
  // A user rule can assign a transfer payee even when addTransactions was
  // told not to generate transfer halves. Force a change so Actual links it.
  if (a.payee === payee && !a.transfer_id) await api.updateTransaction(a.id, { payee: null });
  await api.updateTransaction(a.id, { payee, ...(category ? { category } : {}) });
  const changed = (await api.getTransactions(a.account, a.date, a.date)).find((t) => t.id === a.id);
  if (!changed?.transfer_id) throw new Error('Actual did not create the transfer counterpart');
  await api.mergeTransactions([b.id, changed.transfer_id]);
  // Preserve each bank's dates, IDs and raw descriptions after the merge.
  const linked = (await api.getTransactions(a.account, a.date, a.date)).find((t) => t.id === a.id);
  if (!linked?.transfer_id) throw new Error('Actual did not preserve the transfer link');
  await api.updateTransaction(a.id, { imported_id: a.imported_id, imported_payee: a.imported_payee,
    date: a.date, cleared: a.cleared });
  await api.updateTransaction(linked.transfer_id, { imported_id: b.imported_id, imported_payee: b.imported_payee,
    date: b.date, cleared: b.cleared });
  return [a.id, linked.transfer_id];
}

/** Revisit all managed accounts so uploads and Up sync can arrive in either order. */
async function reconcileTransfers(api, mappings, upAccountIds = []) {
  const accounts = new Map((await api.getAccounts()).map((a) => [a.id, a]));
  const managed = Object.values(mappings).filter((m) => accounts.has(m.actualAccountId));
  if (!managed.length) return { linked: 0, review: [], warnings: [] };
  const start = managed.map((m) => m.start).sort()[0];
  const ids = new Set([...managed.map((m) => m.actualAccountId), ...upAccountIds]);
  let rows = (await Promise.all([...ids].map((id) => api.getTransactions(id, addDays(start, -7), '9999-12-31')))).flat();
  const ofxAccounts = new Map(managed.map((m) => [m.actualAccountId, m]));
  const payees = new Map((await api.getPayees()).filter((p) => p.transfer_acct).map((p) => [p.transfer_acct, p.id]));
  const result = { linked: 0, review: [], warnings: [] };
  const blocked = new Set();
  // Recover a previous interrupted link after Actual generated an Up half
  // but before it was merged with the existing synced Up transaction.
  const recovery = new Map();
  for (const bank of rows.filter((t) => ofxAccounts.has(t.account) && t.imported_id?.startsWith('ofx:') && t.transfer_id)) {
    const generated = rows.find((t) => t.id === bank.transfer_id && upAccountIds.includes(t.account) && !t.imported_id);
    if (!generated) continue;
    recovery.set(bank.id, { generated, matches: rows.filter((t) => t.account === generated.account && t.imported_id &&
      eligible(t) && t.amount === generated.amount && nearby(t, generated)) });
  }
  for (const { generated, matches } of recovery.values()) {
    const bank = matches[0];
    if (matches.length !== 1 || [...recovery.values()].filter((r) => r.matches.some((t) => t.id === bank.id)).length !== 1) continue;
    const id = await api.mergeTransactions([bank.id, generated.id]);
    await api.updateTransaction(id, { date: bank.date, imported_id: bank.imported_id, imported_payee: bank.imported_payee, cleared: bank.cleared });
    result.linked++;
  }
  if (result.linked) rows = (await Promise.all([...ids].map((id) => api.getTransactions(id, addDays(start, -7), '9999-12-31')))).flat();
  // Handle the reverse arrival order too: OFX was imported first, then Up's
  // rules created a second P&N half. Merge it into the bank entry.
  for (const m of managed) {
    const ownRows = rows.filter((t) => t.account === m.actualAccountId);
    const bankRows = ownRows.filter((t) => eligible(t) && t.imported_id?.startsWith('ofx:'));
    const matches = await existingTransferMatches(api, m.actualAccountId, bankRows, ownRows, upAccountIds);
    for (const t of bankRows) {
      const candidate = matches.get(t.imported_id);
      if (!candidate) continue;
      if (!candidate.match) {
        blocked.add(t.id);
        result.review.push({ account: accounts.get(t.account).name, date: t.date, amount: t.amount,
          description: description(t), reason: 'Several existing transfer halves; review in Actual' });
        continue;
      }
      const id = await api.mergeTransactions([t.id, candidate.match.id]);
      await api.updateTransaction(id, { date: t.date, imported_id: t.imported_id, imported_payee: t.imported_payee, cleared: t.cleared });
      result.linked++;
    }
  }
  if (result.linked) rows = (await Promise.all([...ids].map((id) => api.getTransactions(id, addDays(start, -7), '9999-12-31')))).flat();
  const candidates = new Map();
  const sourceRows = rows.filter((t) => !blocked.has(t.id) && ofxAccounts.has(t.account) && t.imported_id?.startsWith('ofx:') && eligible(t) && transferLike(t));
  for (const a of sourceRows) {
    const matches = rows.filter((b) => {
      if (!eligible(b) || a.account === b.account || a.amount !== -b.amount) return false;
      if (!nearby(a, b)) return false;
      if (ofxAccounts.has(b.account)) {
        return b.imported_id?.startsWith('ofx:') && transferLike(b) && reference(a) && reference(a) === reference(b);
      }
      // Never match arbitrary equal purchases/refunds. The user selects the Up
      // account, and at least one bank must identify the other bank explicitly.
      const selectedUp = ofxAccounts.get(a.account).upAccountId;
      return (selectedUp === '__any__' || b.account === selectedUp) && upAccountIds.includes(b.account) &&
        (/\bUp\b/i.test(description(a)) || /\bP\s*&\s*N\b|\bPN Bank\b/i.test(description(b)));
    });
    candidates.set(a.id, matches);
  }
  const used = new Set();
  for (const a of sourceRows) {
    if (used.has(a.id)) continue;
    const matches = candidates.get(a.id);
    const b = matches[0];
    // Require a unique match in both directions, including collisions across
    // several OFX accounts sharing the same configured Up account.
    const reverseCount = b ? [...candidates.values()].filter((xs) => xs.some((t) => t.id === b.id)).length : 0;
    if (matches.length !== 1 || reverseCount !== 1 || used.has(b.id)) {
      result.review.push({ account: accounts.get(a.account).name, date: a.date, amount: a.amount,
        description: description(a), reason: matches.length ? 'Several possible matches; link manually in Actual' : 'Other side not found yet' });
      continue;
    }
    let first = a;
    let second = b;
    const crossBudget = !!accounts.get(a.account).offbudget !== !!accounts.get(b.account).offbudget;
    if (crossBudget && accounts.get(first.account).offbudget) [first, second] = [second, first];
    const category = crossBudget && (ofxAccounts.get(a.account)?.transferCategoryId || ofxAccounts.get(b.account)?.transferCategoryId);
    await linkPair(api, first, second, payees, category);
    used.add(a.id).add(b.id);
    result.linked++;
    if (crossBudget && !category) result.warnings.push('A transfer between on-budget and off-budget accounts needs a category in Actual.');
  }
  result.review = result.review.filter((r) => !sourceRows.some((t) => used.has(t.id) && t.date === r.date &&
    t.amount === r.amount && description(t) === r.description && accounts.get(t.account).name === r.account));
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/** A saved link is only usable while its Actual account exists and is open. */
function activeMapping(mappings, key, accounts) {
  const m = mappings[key];
  return m && accounts.some((a) => a.id === m.actualAccountId && !a.closed) ? m : null;
}

function validateChoices(statements, choices, accounts, categories, upIds, mappings) {
  if (!Array.isArray(choices) || choices.length !== statements.length) throw new Error('Choose settings for every account');
  const selected = new Map(choices.map((c) => [c.key, c]));
  if (selected.size !== statements.length) throw new Error('Duplicate account choices');
  const targets = new Set();
  const newNames = new Set(accounts.map((a) => a.name.toLowerCase()));
  return statements.map((s) => {
    const c = selected.get(s.key);
    if (!c || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100) throw new Error('Enter an account name (up to 100 characters)');
    if (typeof c.offbudget !== 'boolean') throw new Error('Choose whether the account is off-budget');
    // A stale link (deleted/closed account) is replaced rather than blocking imports.
    const saved = activeMapping(mappings, s.key, accounts);
    const id = saved?.actualAccountId || c.actualAccountId;
    if (id && !accounts.some((a) => a.id === id && !a.closed)) throw new Error('Selected Actual account is missing or closed');
    if (id && (targets.has(id) || Object.entries(mappings).some(([key, m]) => key !== s.key && m.actualAccountId === id))) {
      throw new Error('Each bank account must have its own Actual account');
    }
    if (id) targets.add(id);
    if (c.upAccountId && c.upAccountId !== '__any__' && !upIds.includes(c.upAccountId)) throw new Error('Choose a linked Up account');
    if (c.transferCategoryId && !categories.some((cat) => cat.id === c.transferCategoryId)) throw new Error('Unknown transfer category');
    const closingBalance = money(String(c.closingBalance));
    if (!saved && !id && newNames.has(c.name.trim().toLowerCase())) {
      throw new Error('An account with that name already exists; select it instead');
    }
    if (!id) newNames.add(c.name.trim().toLowerCase());
    // Linking an account that already has history from elsewhere: only take
    // statement rows from this date on. Saved with the link so later, overlapping
    // exports never re-add the older rows.
    let importFrom = saved ? saved.importFrom || '' : '';
    if (!saved && id && c.importFrom) {
      if (typeof c.importFrom !== 'string' || !isValidDate(c.importFrom)) throw new Error('Enter a valid import start date');
      importFrom = c.importFrom;
    }
    return { statement: s, choice: c, saved, id, closingBalance, importFrom };
  });
}

async function importStatements(api, { statements, choices, mappings, upAccountIds = [], saveMappings }) {
  const accounts = await api.getAccounts();
  const categories = await api.getCategories();
  const work = validateChoices(statements, choices, accounts, categories, upAccountIds, mappings);
  const results = [];
  // Create/map every account before importing so internal transfers can link.
  for (const w of work) {
    const { statement: s, choice: c } = w;
    if (!w.id) {
      // The opening balance belongs before the export period. It must not be
      // fuzzy-matched to a real transaction with the same amount.
      const openingBalance = w.closingBalance - s.transactions.reduce((sum, t) => sum + t.amount, 0);
      w.id = await api.createAccount({ name: c.name.trim(), offbudget: c.offbudget }, 0);
      const openingId = crypto.randomUUID();
      const startingCategory = categories.find((cat) => cat.is_income && cat.name.toLowerCase() === 'starting balances') || categories.find((cat) => cat.is_income);
      await api.addTransactions(w.id, [{ id: openingId, date: addDays(s.start, -1), amount: openingBalance,
        payee_name: 'Starting Balance', notes: 'Opening balance calculated from first OFX statement',
        category: c.offbudget ? null : startingCategory?.id,
        imported_id: `ofx-opening:${s.key}`, cleared: true }], { runTransfers: false });
      w.openingId = openingId;
      w.openingBase = openingBalance;
    }
    const effectiveStart = w.importFrom > s.start ? w.importFrom : s.start;
    mappings[s.key] = { ...(w.saved || {}), actualAccountId: w.id,
      start: w.saved?.start || effectiveStart, ...(w.importFrom ? { importFrom: w.importFrom } : {}), openingId: w.saved?.openingId || w.openingId,
      initialStart: w.saved?.initialStart || s.start, openingBase: w.saved?.openingBase ?? w.openingBase,
      balanceSign: s.balance === 0 ? (w.saved?.balanceSign || 1) : (Math.sign(w.closingBalance) === Math.sign(s.balance) ? 1 : -1),
      upAccountId: c.upAccountId || '', transferCategoryId: c.transferCategoryId || '' };
    // Checkpoint account creation before processing history. Retrying a failed
    // upload reuses the account and exact IDs instead of creating another one.
    await api.sync();
    await saveMappings(mappings);
  }
  for (const w of work) {
    const { statement: s } = w;
    const m = mappings[s.key];
    const existing = await api.getTransactions(w.id, '0001-01-01', '9999-12-31');
    const seen = new Set(existing.map((t) => t.imported_id));
    const inRange = s.transactions.filter((t) => !m.importFrom || t.date >= m.importFrom);
    const unseen = inRange.filter((t) => !seen.has(t.imported_id));
    const transferMatches = await existingTransferMatches(api, w.id,
      unseen.map((t) => ({ ...t, imported_payee: t.description })), existing, upAccountIds);
    const deferred = [];
    const fresh = [];
    let attached = 0;
    for (const t of unseen) {
      const candidate = transferMatches.get(t.imported_id);
      if (!candidate) fresh.push(t);
      else if (candidate.match) {
        await api.updateTransaction(candidate.match.id, { imported_id: t.imported_id, imported_payee: t.description,
          ...(candidate.match.reconciled ? {} : { date: t.date }), cleared: true });
        attached++;
      } else deferred.push({ date: t.date, amount: t.amount, description: t.description,
        reason: 'Several existing transfer halves; not added to avoid a duplicate' });
    }
    if (s.start < m.initialStart && m.openingId) {
      const opening = existing.find((t) => t.id === m.openingId);
      if (!opening) throw new Error('Opening balance was removed; review the account before adding earlier history');
      const accepted = unseen.filter((t) => !transferMatches.has(t.imported_id) || transferMatches.get(t.imported_id).match);
      const earlierTotal = [...existing.filter((t) => t.imported_id?.startsWith('ofx:')), ...accepted]
        .filter((t) => t.date < m.initialStart).reduce((sum, t) => sum + t.amount, 0);
      await api.updateTransaction(opening.id, { amount: m.openingBase - earlierTotal, date: addDays(s.start < m.start ? s.start : m.start, -1) });
    }
    const statementStart = m.importFrom > s.start ? m.importFrom : s.start;
    if (statementStart < m.start) m.start = statementStart;
    // Exact identity checks intentionally avoid Actual's fuzzy import matching:
    // distinct P&N payments can have the same amount on the same day.
    await api.addTransactions(w.id, fresh.map((t) => ({ date: t.date, amount: t.amount,
      imported_id: t.imported_id, imported_payee: t.description, payee_name: t.description,
      notes: t.description, cleared: true })), { runTransfers: false, learnCategories: true });
    results.push({ actualAccountId: w.id, name: accounts.find((a) => a.id === w.id)?.name || w.choice.name.trim(), added: fresh.length,
      duplicates: inRange.length - unseen.length, beforeImportFrom: s.transactions.length - inRange.length,
      importFrom: m.importFrom || null, attached, deferred, skipped: s.skipped,
      balanceDate: s.balanceDate, closingBalance: w.closingBalance });
    await api.sync();
    await saveMappings(mappings);
  }
  const transfers = await reconcileTransfers(api, mappings, upAccountIds);
  for (const a of results) {
    transfers.linked += a.attached;
    transfers.review.push(...a.deferred.map((r) => ({ ...r, account: a.name })));
    a.actualBalance = await api.getAccountBalance(a.actualAccountId, new Date(`${a.balanceDate}T12:00:00`));
    a.balanceMatches = a.actualBalance === a.closingBalance;
  }
  await api.sync();
  return { accounts: results, ...transfers };
}

module.exports = { importStatements, reconcileTransfers, linkPair, validateChoices, activeMapping };
