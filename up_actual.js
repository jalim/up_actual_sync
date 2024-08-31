const sync = require('./sync')
const nconf = require('nconf')
const fsExtra = require('fs-extra');
const configure = require('./configure');
const configFile = process.env.configFile || './config.json';
const USE_NODE_CRON = process.env.USE_NODE_CRON;

console.log("Config File Location: ", configFile)

nconf.argv().env().file({ file: configFile })

let actualInstance

async function main() {
  let token = nconf.get('UP:token')
  let budgetId = nconf.get('actual:budgetId')
  let budgetEncryption = nconf.get('actual:budgetEncryption') || ''
  let serverUrl = nconf.get('actual:serverUrl') || ''
  let serverPassword = nconf.get('actual:serverPassword') || ''
  let sendNotes = nconf.get('actual:sendNotes') || ''
  let serverValidated = nconf.get('actual:serverValidated') || ''
  let linkedAccounts = nconf.get('linkedAccounts') || []
  let webUI = nconf.get('webUI')

  const setupRequired = !!nconf.get('setup')  || !token || !budgetId || !serverUrl || !serverPassword || !serverValidated
  const linkRequired = setupRequired || !!nconf.get('link') || !linkedAccounts
  
  if (webUI) {
    const webUIService = require('./index')
  }

  if (setupRequired) {

    console.log('Setup required. Either provide a config.json file or set webUI=true and complete configuration')
    // const initialSetup = await configure.initialSetup(token, budgetId, budgetEncryption, serverUrl, serverPassword)
    // token = initialSetup.token
    // budgetId = initialSetup.budgetId
    // budgetEncryption = initialSetup.budgetEncryption
    // serverUrl = initialSetup.serverUrl
    // serverPassword = initialSetup.serverPassword
    // sendNotes = initialSetup.sendNotes

    // nconf.set('UP:token', token)
    // nconf.set('actual:budgetId', budgetId)
    // nconf.set('actual:budgetEncryption', budgetEncryption)
    // nconf.set('actual:serverUrl', serverUrl)
    // nconf.set('actual:serverPassword', serverPassword)
    // nconf.set('actual:sendNotes', sendNotes)

    // await nconf.save()



    // nconf.set('actual:serverValidated', 'yes');
  
    // await nconf.save()
   
  }
  if (linkRequired) {
    console.log('Account linking required. Either add these to the config.json file or set webUI=true and complete linking')

    // actualConfig = {
    //   budgetId: budgetId,
    //   budgetEncryption: budgetEncryption,
    //   serverUrl: serverUrl,
    //   serverPassword: serverPassword
    // }

    // if (!actualInstance) {
    //   actualInstance = await configure.initialize(actualConfig);
    // }

    // linkedAccounts = await configure.accountSetup(token, actualInstance, linkedAccounts, linkRequired)
    // nconf.set('linkedAccounts', linkedAccounts)
    // nconf.save()
  }

  
}