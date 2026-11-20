'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, combine } = require('../src/ofx');

const { statement } = require('./helpers/ofx');

test('OFX uses stable references instead of export row numbers, and skips zero notices', () => {
  const t = { amount: '-10.25', memo: 'Osko Payment To Up Ref#123 &amp; test' };
  const a = parse(statement({ transactions: [t, { amount: '0.00', memo: 'Rate Change' }] }))[0];
  const b = parse(statement({ transactions: [{ ...t, id: '99' }] }))[0];
  assert.equal(a.transactions.length, 1);
  assert.equal(a.skipped, 1);
  assert.equal(a.transactions[0].amount, -1025);
  assert.equal(a.transactions[0].description, 'Osko Payment To Up Ref#123 & test');
  assert.equal(a.transactions[0].imported_id, b.transactions[0].imported_id);
  assert.equal(combine([a, b])[0].transactions.length, 1);
});

test('identical no-reference payments keep multiplicity and distinct references never collapse', () => {
  const t = { amount: '-5.00', memo: 'Card purchase' };
  const s = parse(statement({ transactions: [t, t, { ...t, memo: 'Card Ref#111' }, { ...t, memo: 'Card Ref#112' }] }))[0];
  assert.equal(new Set(s.transactions.map((t) => t.imported_id)).size, 4);
  assert.equal(combine([s, s])[0].transactions.length, 4);
});

test('loan detection overrides P&N SAVINGS classification and suggests negative debt', () => {
  const s = parse(statement({ balance: '1000.00', transactions: [{ amount: '-10.00', memo: 'Loan Redraw to SAV Ref#123' }] }))[0];
  assert.equal(s.loan, true);
  assert.equal(s.suggestedBalance, -100000);
});

test('rejects invalid dates, amounts, missing data, currencies, truncation and entities', () => {
  const good = statement({ transactions: [{ amount: '-1.00', memo: 'Test' }] });
  for (const bad of [good.replace('20261010', '20260230'), good.replace('-1.00', 'oops'),
    good.replace('<ACCTID>test-savings', ''), good.replace('<CURDEF>AUD', '<CURDEF>USD'),
    good.replace('</STMTTRN>', ''), good.replace('</OFX>', ''), '<!DOCTYPE test>' + good]) {
    assert.throws(() => parse(bad));
  }
});

