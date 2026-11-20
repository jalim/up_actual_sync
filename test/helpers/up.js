'use strict';

/** Builders for Up API resources used across tests. */

let seq = 0;

function upTxn({
  id = `t${++seq}`,
  account,
  at = '2026-11-10T12:00:00+11:00',
  amount,
  description = `txn ${id}`,
  status = 'SETTLED',
  transferAccount = null,
  type = 'Purchase',
  roundUp = null,
} = {}) {
  return {
    id,
    attributes: {
      createdAt: at,
      amount: { valueInBaseUnits: amount },
      description,
      status,
      transactionType: type,
      roundUp: roundUp == null ? null : { amount: { valueInBaseUnits: roundUp }, boostPortion: null },
    },
    relationships: {
      account: { data: account ? { id: account } : null },
      transferAccount: { data: transferAccount ? { type: 'accounts', id: transferAccount } : null },
    },
  };
}

/** Both halves of an Up transfer of `amount` cents from `from` to `to`. */
function upTransfer(from, to, amount, at = '2026-11-10T12:00:00+11:00', laterAt = at) {
  return [
    upTxn({ account: from, at, amount: -amount, transferAccount: to, type: 'Transfer', description: `Transfer to ${to}` }),
    upTxn({ account: to, at: laterAt, amount, transferAccount: from, type: 'Transfer', description: `Transfer from ${from}` }),
  ];
}

function upAccount(id, balance, attrs = {}) {
  return {
    id,
    attributes: {
      displayName: id,
      accountType: 'TRANSACTIONAL',
      ownershipType: 'INDIVIDUAL',
      createdAt: '2020-01-01T00:00:00+11:00',
      balance: { valueInBaseUnits: balance },
      ...attrs,
    },
  };
}

module.exports = { upTxn, upTransfer, upAccount };
