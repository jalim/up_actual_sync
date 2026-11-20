'use strict';

const upload = document.getElementById('ofx-upload');
const confirmForm = document.getElementById('ofx-confirm');
const ofxStatus = document.getElementById('ofx-status');
const accountContainer = document.getElementById('ofx-accounts');
const resultContainer = document.getElementById('ofx-result');
let preview;

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function message(text, kind = 'info') {
  ofxStatus.replaceChildren(element('div', text, `alert alert-${kind}`));
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({ error: 'Upload could not be processed; check file size and server connection' }));
  if (!response.ok) throw new Error(result.error);
  return result;
}

function field(parent, label, control) {
  const wrapper = element('label', undefined, 'd-block mb-3');
  wrapper.append(element('span', label, 'form-label d-block'), control);
  parent.append(wrapper);
  return control;
}

function select(options, value) {
  const el = element('select', undefined, 'form-select');
  for (const [id, name] of options) {
    const option = element('option', name);
    option.value = id;
    el.append(option);
  }
  el.value = value || '';
  return el;
}

function input(value, type = 'text') {
  const el = element('input', undefined, 'form-control');
  el.type = type;
  el.value = value;
  el.required = true;
  return el;
}

const dollars = (amount) => (amount / 100).toFixed(2);

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The date before which statement rows are left out (accounts linked after the fact). */
function importFrom(s) {
  if (s.saved) return s.saved.importFrom || '';
  return s.target.value ? s.fromInput.value : '';
}

function rowStatus(s, t) {
  if (t.imported) return 'Already in Actual';
  const from = importFrom(s);
  return from && t.date < from ? 'Before import start' : 'New';
}

function counts(s) {
  const c = { new: 0, imported: 0, before: 0 };
  for (const t of s.transactions) {
    const st = rowStatus(s, t);
    c[st === 'New' ? 'new' : st === 'Already in Actual' ? 'imported' : 'before']++;
  }
  return c;
}

function refreshButton() {
  // Cards still being built have no target yet; the caller refreshes once all exist.
  document.getElementById('ofx-import').textContent = preview.statements.some((s) => !s.saved && s.target && !s.target.value)
    ? 'Create accounts and import' : 'Import transactions';
}

function statementCard(s) {
  const card = element('section', undefined, 'card card-body mb-4');
  const linked = preview.accounts.find((a) => a.id === s.saved?.actualAccountId);
  card.append(element('h2', linked ? `${s.name} (${s.maskedAccount}) → ${linked.name}` : `${s.name} (${s.maskedAccount})`, 'h4'));
  const summary = element('p');
  card.append(summary);
  if (s.relink) {
    card.append(element('p', 'The Actual account this statement was linked to has been closed or deleted. Choose another account or create a new one.', 'alert alert-warning'));
  }
  // Already-linked statements only need a balance check and transfer settings.
  s.target = select([['', 'Create a new account'], ...preview.accounts.map((a) => [a.id, a.name])], s.saved?.actualAccountId);
  if (!linked) field(card, 'Actual account', s.target);
  s.nameInput = input(linked?.name || s.name);
  s.nameInput.maxLength = 100;
  s.budgetInput = select([['on', 'On-budget'], ['off', 'Off-budget (for example, a home loan)']], (linked ? linked.offbudget : s.offbudget) ? 'off' : 'on');
  s.fromInput = input('', 'date');
  s.fromInput.required = false;
  const nameField = linked ? null : field(card, 'New account name', s.nameInput).parentElement;
  const budgetField = linked ? null : field(card, 'New account budget status', s.budgetInput).parentElement;
  const fromField = linked ? null : field(card, 'Import transactions from (earlier statement entries are assumed to be in Actual already; clear to import everything)', s.fromInput).parentElement;
  s.balanceInput = input(dollars(s.closingBalance), 'number');
  s.balanceInput.step = '0.01';
  const balanceLabel = field(card, '', s.balanceInput).parentElement.firstChild;
  const details = element('details');
  const detailsSummary = element('summary');
  details.append(detailsSummary);
  const table = element('table', undefined, 'table table-sm');
  const head = element('thead');
  const heading = element('tr');
  for (const name of ['Date', 'Description', 'Amount', 'Status']) heading.append(element('th', name));
  head.append(heading);
  const body = element('tbody');
  table.append(head, body);
  details.append(table);

  const refresh = () => {
    const existing = !!s.target.value;
    if (!linked) {
      nameField.classList.toggle('d-none', existing);
      budgetField.classList.toggle('d-none', existing);
      fromField.classList.toggle('d-none', !existing);
    }
    balanceLabel.textContent = existing
      ? `Closing balance at ${s.balanceDate} (negative for debt; checked against Actual after import)`
      : `Closing balance at ${s.balanceDate} (negative for debt; sets the new account's opening balance)`;
    const c = counts(s);
    summary.textContent = [`${s.start} to ${s.end}`, `${c.new} new`, c.imported && `${c.imported} already in Actual`,
      c.before && `${c.before} before import start`, s.skipped && `${s.skipped} informational entries skipped`].filter(Boolean).join(' · ');
    detailsSummary.textContent = `View transactions (${c.new} new)`;
    body.replaceChildren(...s.transactions.map((t) => {
      const row = element('tr', undefined, rowStatus(s, t) === 'New' ? '' : 'text-body-secondary');
      for (const v of [t.date, t.description, dollars(t.amount), rowStatus(s, t)]) row.append(element('td', v));
      return row;
    }));
    refreshButton();
  };
  s.target.addEventListener('change', () => {
    const a = preview.accounts.find((x) => x.id === s.target.value);
    if (a) {
      s.nameInput.value = a.name;
      s.budgetInput.value = a.offbudget ? 'off' : 'on';
      // Default to the day after the account's newest entry to avoid duplicating history.
      s.fromInput.value = a.latest ? addDays(a.latest, 1) : '';
    }
    refresh();
  });
  s.fromInput.addEventListener('input', refresh);

  const transferSettings = linked ? element('details', undefined, 'mb-3') : card;
  if (linked) transferSettings.append(element('summary', 'Transfer settings'));
  s.upInput = field(transferSettings, 'Up accounts for transfer matching', select([['', 'Only reuse transfers already linked in Actual'],
    ['__any__', 'Any linked Up account (unique matches only)'],
    ...preview.accounts.filter((a) => preview.upAccountIds.includes(a.id)).map((a) => [a.id, a.name])], s.saved ? s.saved.upAccountId : '__any__'));
  s.categoryInput = field(transferSettings, 'Category for transfers crossing the budget boundary (optional)', select([['', 'Categorise later in Actual'], ...preview.categories.map((c) => [c.id, c.name])], s.saved?.transferCategoryId));
  if (linked) card.append(transferSettings);
  card.append(details);
  refresh();
  return card;
}

upload.addEventListener('submit', async (event) => {
  event.preventDefault();
  confirmForm.hidden = true;
  resultContainer.replaceChildren();
  const button = upload.querySelector('button');
  button.disabled = true;
  message('Reading statements…');
  try {
    const files = [...document.getElementById('ofx-files').files];
    if (files.length > 10 || files.reduce((sum, f) => sum + f.size, 0) > 8 * 1024 * 1024 || files.some((f) => f.size > 5 * 1024 * 1024)) {
      throw new Error('Select up to 10 files, 5 MB each and 8 MB total');
    }
    const encoded = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ content: reader.result.split(',')[1] });
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    })));
    preview = await post('/ofx/preview', { files: encoded });
    accountContainer.replaceChildren();
    for (const s of preview.statements) accountContainer.append(statementCard(s));
    refreshButton();
    confirmForm.hidden = false;
    const fresh = preview.statements.reduce((n, s) => n + counts(s).new, 0);
    message(preview.statements.every((s) => s.saved)
      ? `${fresh} new transaction${fresh === 1 ? '' : 's'} to import. Check the closing balances, then import. No changes have been made in Actual.`
      : 'Choose an Actual account for each new statement and check balances and transfer settings. No changes have been made in Actual.');
  } catch (err) {
    message(err.message, 'danger');
  } finally {
    button.disabled = false;
  }
});

confirmForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('ofx-import');
  button.disabled = true;
  upload.querySelector('button').disabled = true;
  message('Importing into Actual…');
  try {
    const result = await post('/ofx/import', { token: preview.token, choices: preview.statements.map((s) => ({
      key: s.key, actualAccountId: s.target.value, name: s.nameInput.value,
      offbudget: s.budgetInput.value === 'off', closingBalance: s.balanceInput.value,
      upAccountId: s.upInput.value, transferCategoryId: s.categoryInput.value, importFrom: importFrom(s),
    })) });
    confirmForm.hidden = true;
    resultContainer.replaceChildren(element('h2', 'Import results', 'h4'));
    for (const a of result.accounts) {
      const before = a.beforeImportFrom ? `, ${a.beforeImportFrom} before ${a.importFrom} left out` : '';
      resultContainer.append(element('p', `${a.name}: ${a.added} added, ${a.duplicates} already imported${before}, ${a.attached} matched existing transfers. Balance at ${a.balanceDate}: $${dollars(a.actualBalance)}${a.balanceMatches ? ' (matches statement)' : ` — statement says $${dollars(a.closingBalance)}; reconcile in Actual`}.`));
    }
    for (const warning of result.warnings) resultContainer.append(element('p', warning, 'alert alert-warning'));
    if (result.review.length) {
      resultContainer.append(element('h3', 'Transfers to review or await a later import', 'h5'));
      const list = element('ul');
      for (const r of result.review) list.append(element('li', `${r.account} · ${r.date} · $${dollars(r.amount)} · ${r.description}: ${r.reason}`));
      resultContainer.append(list);
    }
    message(`Import complete. ${result.linked} transfer pairs linked.`, 'success');
  } catch (err) {
    message(err.message, 'danger');
  } finally {
    button.disabled = false;
    upload.querySelector('button').disabled = false;
  }
});
