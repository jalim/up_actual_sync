'use strict';

const crypto = require('node:crypto');
const { isValidDate } = require('./initialise');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    if (entity[0] === '#') {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

// OFX 1.x SGML leaves scalar tags unclosed; OFX 2.x XML closes them.
function value(block, tag, required = true) {
  const match = block.match(new RegExp(`<${tag}\\s*>([^<\\r\\n]*)`, 'i'));
  const result = match ? decode(match[1].trim()) : '';
  if (required && !result) throw new Error(`OFX is missing ${tag}`);
  return result;
}

function date(s) {
  if (!/^\d{8}(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.test(s)) throw new Error('Invalid OFX date');
  const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (!isValidDate(d)) throw new Error('Invalid OFX calendar date');
  return d;
}

function money(s) {
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('Invalid amount (expected dollars and cents)');
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = s.replace(/^[+-]/, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('Amount is too large');
  return negative ? -cents : cents;
}

function parse(input) {
  let text;
  if (Buffer.isBuffer(input)) {
    const header = input.subarray(0, 300).toString('ascii');
    text = new TextDecoder(/UTF-?8|ENCODING:UNICODE|CHARSET:65001/i.test(header) ? 'utf-8' : 'windows-1252').decode(input);
  } else text = String(input);
  if (!/<OFX[\s>]/i.test(text) || !/<\/OFX>/i.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error('Upload a complete OFX file (external entities are not supported)');
  }
  for (const status of text.matchAll(/<STATUS>([\s\S]*?)<\/STATUS>/gi)) {
    if (value(status[1], 'CODE') !== '0') throw new Error('The OFX file reports a bank error');
  }
  const statements = [...text.matchAll(/<(STMTRS|CCSTMTRS)>([\s\S]*?)<\/\1>/gi)];
  if (!statements.length) throw new Error('No bank statements found in OFX');
  return statements.map(([, , block]) => {
    const accountId = value(block, 'ACCTID');
    const bankId = value(block, 'BANKID', false);
    const accountType = value(block, 'ACCTTYPE', false) || 'CREDITCARD';
    const currency = value(block, 'CURDEF');
    if (currency !== 'AUD') throw new Error('Only AUD statements are supported');
    const key = hash(JSON.stringify([bankId, accountId, currency]));
    const start = date(value(block, 'DTSTART'));
    const end = date(value(block, 'DTEND'));
    if (start > end) throw new Error('Statement dates are reversed');
    const ledger = block.match(/<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i)?.[1];
    if (!ledger) throw new Error('A closing ledger balance is required');
    const balance = money(value(ledger, 'BALAMT'));
    const balanceDate = date(value(ledger, 'DTASOF'));
    const blocks = [...block.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
    if (blocks.length !== (block.match(/<STMTTRN>/gi) || []).length) throw new Error('Incomplete OFX transaction');
    const occurrences = new Map();
    let skipped = 0;
    const transactions = blocks.map(([, b]) => {
      if (/<CORRECTFITID>/i.test(b)) throw new Error('OFX corrections require manual review');
      const posted = date(value(b, 'DTPOSTED'));
      if (posted < start || posted > end) throw new Error('Transaction outside statement dates');
      const amount = money(value(b, 'TRNAMT'));
      const memo = value(b, 'MEMO', false);
      const name = value(b, 'NAME', false);
      const description = [name, memo].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!description) throw new Error('Transaction has no description');
      const reference = description.match(/\bRef#\s*(\d+)/i)?.[1] || null;
      // P&N's FITID is just the row number. Never use it for identity.
      const base = hash(JSON.stringify([key, posted, amount, reference || description]));
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);
      if (!amount) skipped++;
      return { date: posted, amount, description, reference, imported_id: `ofx:${base}:${occurrence}` };
    }).filter((t) => t.amount !== 0);
    const loan = /LOAN|MORTGAGE/i.test(accountType) || transactions.some((t) => /Loan Redraw|Loan Repayment|Loan Interest/i.test(t.description));
    const last = transactions.reduce((d, t) => t.date > d ? t.date : d, start);
    if (balanceDate < last || balanceDate > end) throw new Error('Closing balance date does not cover this statement');
    return { key, accountId, bankId, accountType, currency, start, end, balanceDate, balance,
      suggestedBalance: loan ? -Math.abs(balance) : balance, loan, transactions, skipped };
  });
}

/** Combine overlapping exports without dropping genuinely repeated identical entries. */
function combine(statements) {
  const groups = new Map();
  for (const s of statements) {
    let g = groups.get(s.key);
    if (!g) {
      g = { ...s, transactions: [], files: 0, skipped: 0, byId: new Map() };
      groups.set(s.key, g);
    }
    g.files++;
    g.loan ||= s.loan;
    g.skipped += s.skipped;
    if (s.start < g.start) g.start = s.start;
    if (s.end > g.end) g.end = s.end;
    if (s.balanceDate === g.balanceDate && s.balance !== g.balance) throw new Error('Conflicting closing balances for the same account and date');
    if (s.balanceDate > g.balanceDate) {
      g.balanceDate = s.balanceDate;
      g.balance = s.balance;
      g.suggestedBalance = s.suggestedBalance;
    }
    for (const t of s.transactions) g.byId.set(t.imported_id, t);
  }
  return [...groups.values()].map(({ byId, ...s }) => ({ ...s,
    suggestedBalance: s.loan ? -Math.abs(s.balance) : s.balance,
    transactions: [...byId.values()].sort((a, b) => a.date.localeCompare(b.date)) }));
}

module.exports = { parse, combine, money, hash };
