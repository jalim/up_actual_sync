'use strict';

const button = document.getElementById('sync');
const statusEl = document.getElementById('status');

function show(kind, text) {
  statusEl.replaceChildren();
  const div = document.createElement('div');
  div.className = `alert alert-${kind}`;
  div.textContent = text;
  statusEl.append(div);
}

button?.addEventListener('click', async () => {
  button.disabled = true;
  show('info', 'Syncing…');
  try {
    const res = await fetch('/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `Request failed (${res.status})`);
    const lines = body.results.map((r) => `${r.name}: ${r.added} added, ${r.updated} updated${r.transfers ? `, ${r.transfers} transfers` : ''}`);
    show('success', lines.length ? `Sync complete. ${lines.join(' · ')}` : 'Sync complete. No linked accounts.');
  } catch (err) {
    show('danger', `Sync failed: ${err.message}`);
  } finally {
    button.disabled = false;
  }
});
