'use strict';

const button = document.getElementById('sync');
const statusEl = document.getElementById('status');

function show(kind, text) {
  const div = document.createElement('div');
  div.className = `alert alert-${kind}`;
  div.textContent = text;
  statusEl.replaceChildren(div);
}

function renderResults(results) {
  const list = document.createElement('div');
  list.className = 'activity-list';
  for (const result of results) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const symbol = document.createElement('span');
    symbol.className = 'account-symbol';
    symbol.textContent = '↗';
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = result.name;
    const counts = document.createElement('p');
    counts.textContent = `${result.added} added · ${result.updated} updated${result.transfers ? ` · ${result.transfers} transfers` : ''}`;
    detail.append(name, counts);
    const errors = result.errors || [];
    if (errors.length) {
      const warning = document.createElement('p');
      warning.className = 'text-danger';
      warning.textContent = errors.join('; ');
      detail.append(warning);
    }
    const badge = document.createElement('span');
    badge.className = 'pill';
    badge.textContent = errors.length ? 'Review' : 'Synced';
    row.append(symbol, detail, badge);
    list.append(row);
  }
  if (results.length) statusEl.replaceChildren(list);
  else show('info', 'Sync complete. No linked accounts.');
}

function updateTime(value) {
  for (const time of document.querySelectorAll('time[datetime]')) {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.getTime())) {
      time.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
  }
  if (value) document.getElementById('last-sync-time').textContent = value;
}
updateTime();

button?.addEventListener('click', async () => {
  button.disabled = true;
  button.classList.add('is-loading');
  button.querySelector('span').textContent = 'Syncing…';
  statusEl.setAttribute('aria-busy', 'true');
  show('info', 'Syncing your linked accounts. This can take a moment…');
  try {
    const res = await fetch('/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `Request failed (${res.status})`);
    renderResults(body.results);
    document.getElementById('last-sync-label').textContent = 'Completed';
    updateTime(new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  } catch (err) {
    show('danger', `Sync failed: ${err.message}`);
    document.getElementById('last-sync-label').textContent = 'Needs attention';
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.querySelector('span').textContent = 'Sync now';
    statusEl.setAttribute('aria-busy', 'false');
  }
});
