'use strict';

function statement({ account = 'test-savings', start = '20261001', end = '20261031', balance = '200.00', transactions = [] } = {}) {
  return `OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n<OFX><BANKMSGSRSV1><STMTRS><CURDEF>AUD
<BANKACCTFROM><BANKID>test-bank<ACCTID>${account}<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${start}<DTEND>${end}
${transactions.map((t, i) => `<STMTTRN><TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${t.date || '20261010'}<TRNAMT>${t.amount}<FITID>${t.id || i + 1}<MEMO>${t.memo}</STMTTRN>`).join('\n')}
</BANKTRANLIST><LEDGERBAL><BALAMT>${balance}<DTASOF>${end}</LEDGERBAL></STMTRS></BANKMSGSRSV1></OFX>`;
}

module.exports = { statement };
