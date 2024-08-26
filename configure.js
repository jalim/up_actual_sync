const inquirer = require('inquirer')
const upBank = require('./upBank')
const api = require('@actual-app/api');
const { validate } = require('node-cron');

let _token
let _budgetId
let _budgetEncryption
let _serverUrl
let _serverPassword
let _sendNotes

console.log('Inquirer, upBank and API modules loaded.');

const prompts = [
  {
    type: 'input',
    name: 'token',
    default: () => getToken(),
    message: 'Enter your UP API Token:',
    validate: async (i, a) => {
      if (i !== getToken()) {
        try {
          a.validate = await upBank.validate(i)
        } catch (e) {
          return `Invalid Token: ${i}`
        }
      } else {
        return true
      }
      return true
    }
  },
  {
    type: 'input',
    name: 'serverUrl',
    default: () => getServerUrl(),
    message: 'Enter your ActualBudget Server URL:',
  },
  {
    type: 'input',
    name: 'serverPassword',
    default: () => getServerPassword(),
    message: 'Enter your ActualBudget Server Password:',

  },
  {
    type: 'input',
    name: 'budgetId',
    default: () => getBudgetId(),
    message: 'Enter your ActualBudget Sync ID:'
  },
  {
    type: 'input',
    name: 'budgetEncryption',
    default: () => getBudgetEncryption(),
    message: 'Enter your ActualBudget Budget Encryption Password (leave blank if not encrypted):'
  },
  {
    type: 'input',
    name: 'sendNotes',
    default: () => getSendNotes(),
    message: 'Overwrite mapped account notes with date and balance from SimpleFin each run? (enter "yes" without quotes, to enable):'
  }
]

function getChoices (answers, accounts) {
  const ret = accounts.filter(f => !Object.values(answers).find(a => a === f.id)).map(a => {
    return {
      name: `${a.name} (${a.type})`,
      value: a.id,
      short: a.name
    }
  }).sort((a, b) => {
    const au = a.name.toUpperCase()
    const bu = b.name.toUpperCase()
    if (au > bu) return 1
    else if (au < bu) return -1
    return 0
  })
  ret.push({
    name: 'Skip',
    value: null,
    short: 'Skipped'
  })
  return ret
}

function getToken () {
  return _token
}

function getAccessKey () {
  return _accessKey
}

function getServerPassword () {
  return _serverPassword
}

function getServerUrl () {
  return _serverUrl
}

function getBudgetId () {
  return _budgetId
}

function getBudgetEncryption () {
  return _budgetEncryption
}

function getSendNotes () {
  return _sendNotes
}

async function initialSetup(token, budgetId, budgetEncryption, serverUrl, serverPassword, sendNotes) {
  console.log('Initiating setup...');
  _token = token;
  _budgetId = budgetId;
  _budgetEncryption = budgetEncryption;
  _serverUrl = serverUrl;
  _serverPassword = serverPassword;
  _sendNotes = sendNotes;
  console.log('Prompting user for input...');
  const initialSetup = await inquirer.prompt(prompts);
  console.log('User input received: ', initialSetup);
  return initialSetup;
}

async function accountSetup(token, actualInstance, linkedAccounts, reLinkAccounts) {
  console.log('Starting account setup...');
  const UPAccounts = await upBank.getAccounts(token)
  console.log('UP Accounts: ', UPAccounts);
  const accounts = (await actualInstance.getAccounts()).filter(f => !!reLinkAccounts || !Object.values(linkedAccounts || {}).find(a => a === f.id))
  console.log('ActualBudget accounts: ', accounts);
  const accountLinkPrompts = UPAccounts.filter(f => !!reLinkAccounts || !linkedAccounts[f.id]).map(s => {
    return {
      type: 'list',
      name: s.id,
      message: `Link ${s.attributes.displayName} - ${s.attributes.ownershipType} ($${s.attributes.balance.value}) with ActualBudget account:`,
      default: linkedAccounts[s.id],
      choices: (a) => { return getChoices(a, accounts) },
      when: (a) => { return getChoices(a, accounts).length > 1 }
    }
  })
  const accountLinks = await inquirer.prompt(accountLinkPrompts)
  
  await actualInstance.shutdown()
  
  Object.assign(linkedAccounts, accountLinks)
  const nullsRemoved = Object.fromEntries(Object.entries(linkedAccounts).filter(([_, v]) => v != null))
  return nullsRemoved
}

async function initialize(config = [], overwriteExistingConfig = true) {
  if (!_serverUrl || overwriteExistingConfig) {
    if(config.serverUrl) {
      _serverUrl = config.serverUrl;
      console.log('Updated Actual Config: serverUrl')
    } else {
      throw new Error('Actual Budget Error: serverUrl is required');
    }
  }
  if (!_serverPassword || overwriteExistingConfig) {
    if(config.serverPassword) {
      _serverPassword = config.serverPassword;
      console.log('Updated Actual Config: serverPassword')
    } else {
      throw new Error('Actual Budget Error: serverPassword is required');
    }
  }
  if (!_budgetId || overwriteExistingConfig) {
    if(config.budgetId) {
      _budgetId = config.budgetId;
      console.log('Updated Actual Config: budgetId')
    } else {
      throw new Error('Actual Budget Error: budgetId is required');
    }
  }
  if (!_budgetEncryption || overwriteExistingConfig) {
    _budgetEncryption = config.budgetEncryption
    console.log('Updated Actual Config: budgetEncryption')
  }

  if (!_sendNotes || overwriteExistingConfig) {
    _sendNotes = config.sendNotes
    console.log('Updated Actual Config: sendNotes')
  }

  console.log('Initializing Actual Budget...');

  const { mkdir } = require('fs').promises;

  budgetspath = __dirname+'/budgets'

  try {
    await mkdir(budgetspath);
  } catch (e) {}

  try {
    await api.init({
      dataDir: budgetspath,
      serverURL: actualConfig.serverUrl || _serverUrl,
      password: actualConfig.serverPassword || _serverPassword,
    });

    let id = actualConfig.budgetId || _budgetId;
    let budgetEncryption = actualConfig.budgetEncryption || _budgetEncryption;

    await api.downloadBudget(id,  {password: budgetEncryption});
  } catch (e) {
    throw new Error(`Actual Budget Error: ${e.message}`);
  }
  console.log('Actual Budget initialized.');
  return api;
}

console.log('Setup module loaded.');

module.exports = { initialSetup, accountSetup, initialize }