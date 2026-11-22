'use strict';

// Accounts page: show what will change before either form is submitted.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const linksForm = document.getElementById('links-form');
if (linksForm) {
  const selects = [...linksForm.querySelectorAll('select[data-initial]')];
  const submit = document.getElementById('links-submit');
  const note = document.getElementById('links-dirty');
  let dirty = 0;
  const update = () => {
    dirty = 0;
    for (const select of selects) {
      const changed = select.value !== select.dataset.initial;
      select.closest('tr').classList.toggle('is-changed', changed);
      dirty += changed;
    }
    submit.disabled = !dirty;
    submit.textContent = dirty ? `Save ${plural(dirty, 'change')}` : 'Save changes';
    note.textContent = dirty ? 'Unsaved changes' : '';
  };
  linksForm.addEventListener('change', update);
  linksForm.addEventListener('submit', () => { dirty = 0; });
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });
  update();
}

const addForm = document.getElementById('add-form');
if (addForm) {
  const selects = [...addForm.querySelectorAll('select')];
  const submit = document.getElementById('add-submit');
  const createOptions = document.getElementById('create-options');
  const startDate = document.getElementById('startDate');
  const update = () => {
    const chosen = selects.filter((s) => s.value);
    const creating = chosen.filter((s) => s.value.startsWith('create')).length;
    createOptions.hidden = !creating;
    startDate.required = creating > 0;
    submit.disabled = !chosen.length;
    if (!chosen.length) submit.textContent = 'Add accounts';
    else if (creating === chosen.length) submit.textContent = `Create ${plural(creating, 'account')}`;
    else if (!creating) submit.textContent = `Link ${plural(chosen.length, 'account')}`;
    else submit.textContent = `Create ${creating}, link ${chosen.length - creating}`;
  };
  addForm.addEventListener('change', update);
  update();
}
