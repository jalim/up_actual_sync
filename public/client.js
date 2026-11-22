'use strict';

// Sync now button, used on the overview, the getting-started checklist, the
// Accounts page and after creating accounts. Elements other than #sync and
// #status are optional.

const button = document.getElementById('sync');
const statusEl = document.getElementById('status');
const formatTime = (date) => date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function show(kind, text) {
  statusEl?.replaceChildren(element('div', `alert alert-${kind}`, text));
}

function renderResults(results) {
  if (!results.length) return show('info', 'Sync complete. No linked accounts.');
  const list = element('div', 'activity-list');
  for (const r of results) {
    const errors = r.errors || [];
    const row = element('div', 'activity-row');
    const state = element('span', `row-state ${errors.length ? 'is-warning' : 'is-ok'}`);
    state.setAttribute('aria-hidden', 'true');
    const detail = element('div');
    detail.append(
      element('strong', '', r.name),
      element('p', '', `${r.added} added · ${r.updated} updated${r.transfers ? ` · ${r.transfers} transfers` : ''}`),
    );
    if (errors.length) detail.append(element('p', 'text-danger', errors.join('; ')));
    row.append(state, detail, element('span', errors.length ? 'pill pill-warning' : 'pill', errors.length ? 'Review' : 'Synced'));
    list.append(row);
  }
  statusEl?.replaceChildren(list);
}

for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.getTime())) time.textContent = formatTime(date);
}

button?.addEventListener('click', async () => {
  const label = button.querySelector('span');
  button.disabled = true;
  button.classList.add('is-loading');
  label.textContent = 'Syncing…';
  statusEl?.setAttribute('aria-busy', 'true');
  show('info', 'Syncing your linked accounts. This can take a moment…');
  try {
    const res = await fetch('/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Another sync (usually the scheduled one) is running; nothing failed.
      show('info', 'A sync is already running. Refresh in a moment to see its results.');
      return;
    }
    if (!res.ok || !body.ok) throw new Error(body.error || `Request failed (${res.status})`);
    // The getting-started checklist is replaced by the full overview.
    if (document.querySelector('[data-reload-after-sync]')) return window.location.reload();
    renderResults(body.results);
    const issues = body.results.some((r) => (r.errors || []).length);
    const sum = (key) => body.results.reduce((n, r) => n + (r[key] || 0), 0);
    setText('last-sync-label', issues ? 'Completed with issues' : 'Completed');
    setText('last-sync-time', formatTime(new Date()));
    setText('stat-added', String(sum('added')));
    setText('stat-detail', `transactions added · ${sum('updated')} updated`);
    setText('activity-trigger', 'Manual sync');
    const dot = document.getElementById('sync-state');
    if (dot) dot.className = `state-dot ${issues ? 'is-warning' : 'is-ok'}`;
  } catch (err) {
    show('danger', `Sync failed: ${err.message}`);
    setText('last-sync-label', 'Needs attention');
    const dot = document.getElementById('sync-state');
    if (dot) dot.className = 'state-dot is-error';
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    label.textContent = 'Sync now';
    statusEl?.setAttribute('aria-busy', 'false');
  }
});
