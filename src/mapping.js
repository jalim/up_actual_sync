'use strict';

/**
 * Map an Up transaction resource to an Actual import transaction.
 * Up timestamps carry the local (+10:00/+11:00) offset, so the first ten
 * characters are the local calendar date.
 */
function mapTransaction(upTxn, actualAccountId) {
  const a = upTxn.attributes;
  return {
    account: actualAccountId,
    date: a.createdAt.slice(0, 10),
    amount: a.amount.valueInBaseUnits,
    payee_name: a.description,
    imported_payee: a.description,
    notes: a.description,
    imported_id: upTxn.id,
    cleared: a.status === 'SETTLED',
  };
}

module.exports = { mapTransaction };
