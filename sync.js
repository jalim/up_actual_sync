const upBank = require('./upBank')
const api = require('@actual-app/api');
const actualInjected = require('@actual-app/api/dist/injected');

let _token
let _linkedAccounts
let _startDate
let _serverUrl
let _serverPassword
let _budgetId
let _budgetEncryption
let _sendNotes

async function sync () {

  const { mkdir } = require('fs').promises;

  budgetspath = __dirname+'/budgets'

  try {
    await mkdir(budgetspath);
  } catch (e) {}


  await api.init({ 
    dataDir: budgetspath,
    serverURL: _serverUrl,
    password: _serverPassword,
  });

  console.log('Downloading budget')
  try {
    await api.downloadBudget(_budgetId,  {password: _budgetEncryption});
  } catch (e) {
    console.log(e.message)
    throw e
  }
  console.log('Budget downloaded')

  console.log('Getting all accounts and transactions from ActualBudget')
  const allAccounts = await api.getAccounts()
  console.log('Getting all transactions from UP')

  console.log('_____________________________________________________')
  console.log('|          Account          |   Added   |  Updated  |')
  console.log('+---------------------------+-----------+-----------+')
  for (const upAccountId in _linkedAccounts) {
    const accountId = _linkedAccounts[upAccountId]
    const allTrans = await upBank.getTransactions(_token, _startDate, upAccountId)
    const transactions = allTrans.map(m => {
        return {
          account: accountId,
          date: m.attributes.createdAt.split('T')[0],
          amount: m.attributes.amount.valueInBaseUnits,
          payee_name: m.attributes.description,
          notes: m.attributes.description,
          imported_payee: m.attributes.description,
          imported_id: m.id,
          cleared: (m.attributes.status === 'SETTLED')
        }
      })
    try {

      const importedTransactions = await api.importTransactions(accountId, transactions)
      const accountName = allAccounts.find(f => f.id === accountId).name
      console.log(`| ${accountName.padEnd(25, ' ')} | ${importedTransactions.added.length.toString().padStart(9, ' ')} | ${importedTransactions.updated.length.toString().padStart(9, ' ')} |`)
      
      if( _sendNotes == 'yes' ) {
      
        const balanceDate = new Date(allTrans.accounts.find(f => f.id == simpleFINAccountId)['balance-date'] * 1000);
        const formatter = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        });

        const balance = allTrans.accounts.find(f => f.id == simpleFINAccountId).balance
        const accountNote = "Transactions synced at " + balanceDate.toLocaleString() + " with balance " + formatter.format(balance);
        const noteId = 'account-' + accountId;
        await actualInjected.send('notes-save', { id: noteId, note: accountNote });
      }
    } catch (ex) {
      console.log(ex)
      throw ex
    }
  }
  console.log('¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯')
  console.log('Re-downloading budget to force sync.')
  try {
    await api.downloadBudget(_budgetId,  {password:_budgetEncryption});
  } catch (e) {
    console.log(e.message)
    throw e
  }
  await api.shutdown()
  
}

async function run (token, budgetId, budgetEncryption, linkedAccounts, startDate, serverUrl, serverPassword, sendNotes) {
  _token = token
  _linkedAccounts = linkedAccounts
  _startDate = startDate
  _serverUrl = serverUrl
  _serverPassword = serverPassword
  _budgetId = budgetId
  _budgetEncryption = budgetEncryption
  _sendNotes = sendNotes

  if(!_serverUrl || !_serverPassword) {
    throw new Error('Server URL or password not set')
  } else {
    console.log('Server information set')
  }
  console.log(`Budget ID: ${budgetId}`)

  await sync()
  
}

module.exports = { run }