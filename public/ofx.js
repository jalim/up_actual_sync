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
    for (const s of preview.statements) {
      const card = element('section', undefined, 'card card-body mb-4');
      card.append(element('h2', `${s.name} (${s.maskedAccount})`, 'h4'));
      card.append(element('p', `${s.start} to ${s.end} · ${s.transactions.length} transactions · ${s.skipped} informational entries skipped`));
      const savedAccount = preview.accounts.find((a) => a.id === s.saved?.actualAccountId);
      s.target = field(card, 'Actual account', select([['', 'Create a new account'], ...preview.accounts.map((a) => [a.id, a.name])], s.saved?.actualAccountId));
      s.target.disabled = !!s.saved;
      s.nameInput = field(card, 'New account name', input(savedAccount?.name || s.name));
      s.nameInput.maxLength = 100;
      s.budgetInput = field(card, 'New account budget status', select([['on', 'On-budget'], ['off', 'Off-budget (for example, a home loan)']], (savedAccount ? savedAccount.offbudget : s.offbudget) ? 'off' : 'on'));
      s.balanceInput = field(card, `Closing balance at ${s.balanceDate} (negative for debt; used to initialise new accounts)`, input(dollars(s.closingBalance), 'number'));
      s.balanceInput.step = '0.01';
      const updateTarget = () => {
        const existing = !!s.target.value;
        s.nameInput.disabled = existing;
        s.budgetInput.disabled = existing;
        if (existing) {
          const a = preview.accounts.find((a) => a.id === s.target.value);
          s.nameInput.value = a?.name || s.name;
          s.budgetInput.value = a?.offbudget ? 'off' : 'on';
        }
      };
      s.target.addEventListener('change', updateTarget);
      updateTarget();
      s.upInput = field(card, 'Up accounts for transfer matching', select([['', 'Only reuse transfers already linked in Actual'],
        ['__any__', 'Any linked Up account (unique matches only)'],
        ...preview.accounts.filter((a) => preview.upAccountIds.includes(a.id)).map((a) => [a.id, a.name])], s.saved ? s.saved.upAccountId : '__any__'));
      s.categoryInput = field(card, 'Category for transfers crossing the budget boundary (optional)', select([['', 'Categorise later in Actual'], ...preview.categories.map((c) => [c.id, c.name])], s.saved?.transferCategoryId));
      const details = element('details');
      details.append(element('summary', 'View transactions'));
      const table = element('table', undefined, 'table table-sm');
      const head = element('thead');
      const heading = element('tr');
      for (const name of ['Date', 'Description', 'Amount']) heading.append(element('th', name));
      head.append(heading);
      const body = element('tbody');
      for (const t of s.transactions) {
        const row = element('tr');
        for (const v of [t.date, t.description, dollars(t.amount)]) row.append(element('td', v));
        body.append(row);
      }
      table.append(head, body);
      details.append(table);
      card.append(details);
      accountContainer.append(card);
    }
    confirmForm.hidden = false;
    message('Review names, debt balances and transfer settings. No changes have been made in Actual.');
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
      upAccountId: s.upInput.value, transferCategoryId: s.categoryInput.value,
    })) });
    confirmForm.hidden = true;
    resultContainer.replaceChildren(element('h2', 'Import results', 'h4'));
    for (const a of result.accounts) {
      resultContainer.append(element('p', `${a.name}: ${a.added} added, ${a.duplicates} already imported, ${a.attached} matched existing transfers. Balance at ${a.balanceDate}: $${dollars(a.actualBalance)}${a.balanceMatches ? ' (matches statement)' : ` — statement says $${dollars(a.closingBalance)}; reconcile in Actual`}.`));
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
