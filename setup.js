const api = require('@actual-app/api');

let _budgetId
let _budgetEncryption
let _serverUrl
let _serverPassword
let _sendNotes

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

module.exports = { initialize }