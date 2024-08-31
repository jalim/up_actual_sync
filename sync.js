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

async function run (token, actual, linkedAccounts, startDate) {
  _token = token
  _linkedAccounts = linkedAccounts
  _startDate = startDate
  _serverUrl = actual.serverUrl
  _serverPassword = actual.serverPassword
  _budgetId = actual.budgetId
  _budgetEncryption = actual.budgetEncryption
  _sendNotes = actual.sendNotes

  if(!_serverUrl || !_serverPassword) {
    throw new Error('Server URL or password not set')
  } else {
    console.log('Server information set')
  }
  console.log(`Budget ID: ${_budgetId}`)

  await sync()
  
}

module.exports = { run }