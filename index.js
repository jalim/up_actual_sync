const express = require('express');
const nconf = require('nconf');
const bodyParser = require('body-parser');
const upBank = require('./upBank');
const sync = require('./sync')
const fsExtra = require('fs-extra');
const setup = require('./setup');
const api = require('@actual-app/api');
const configFile = process.env.configFile || './config.json';

// Initialize nconf to use (in-order):
//   1. Command-line arguments
//   2. Environment variables
//   3. A configuration file
//   4. Default values
nconf.argv().env().file({ file: configFile }).defaults({
  port: 3000,
});

const port = nconf.get('port');
const cronEnabled = nconf.get('cronEnabled');
let webUI = nconf.get('webUI')


let token = nconf.get('UP:token') || ''
let actual = nconf.get('actual') || {}
let actualInstance
let linkedAccounts = nconf.get('linkedAccounts') || {};

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));

// Get the value of the 'port' key from the configuration data
if(webUI){
  app.listen(port, () => {
    console.log(`Microservice listening on port ${port}`);
  });
}
app.get('/config', (req, res) => {
    res.json(nconf.get('port'));
  });

app.set('view engine', 'pug')

app.get('/', async (req, res) => {
  // const accounts = (await actualInstance.getAccounts()).filter(f => !!reLinkAccounts || !Object.values(linkedAccounts || {}).find(a => a === f.id))
  // console.log('ActualBudget accounts: ', accounts);
  res.render('index')
})

app.get('/setup', async (req, res) => {
    // const accounts = (await actualInstance.getAccounts()).filter(f => !!reLinkAccounts || !Object.values(linkedAccounts || {}).find(a => a === f.id))
    // console.log('ActualBudget accounts: ', accounts);
    res.render('setup', { token: token, actual: actual})
  })
app.get('/link', async (req, res) => {
  const UPAccounts = await upBank.getAccounts(token)
  // console.log('UP Accounts: ', UPAccounts);
  const accountLinkPrompts = UPAccounts.map(s => {
    return {
      id: s.id,
      displayName: s.attributes.displayName
    }
  })

  actualConfig = {
    budgetId: actual.budgetId,
    budgetEncryption: actual.budgetEncryption,
    serverUrl: actual.serverUrl,
    serverPassword: actual.serverPassword
  }

  if (!actualInstance) {
    actualInstance = await setup.initialize(actualConfig);
  }

  //const actualAccounts = await setup.getAccounts(actualInstance);

  const actualAccounts = await actualInstance.getAccounts()

  res.render('link', {  UPAccounts: accountLinkPrompts, actualAccounts: actualAccounts, linkedAccounts: linkedAccounts })
})
app.post('/link', async (req, res) => {
    const upID = req.body.account;
    const accID = req.body.accID;
    console.log("up: ", upID, " actual: ", accID);
    if (accID) {
      const accountLink = { [upID] : accID };
      Object.assign(linkedAccounts, accountLink);
    } else {
      delete linkedAccounts[upID];
    }
    nconf.set('linkedAccounts',linkedAccounts);
    nconf.save();
    res.redirect('/link');
    // res.render('link', {  UPAccounts: accountLinkPrompts, actualAccounts: actualAccounts})
})

app.post('/setup', async (req, res) => {
    // accessing form fields from req.body
    token = req.body.token || ''
    actual.budgetId = req.body.budgetId || ''
    actual.budgetEncryption = req.body.budgetEncryption
    actual.serverUrl = req.body.serverUrl || ''
    actual.serverPassword = req.body.serverPassword || ''
    actual.UPAccountssendNotes = req.body.sendNotes || ''
    console.log(actual)
    let validate = false
    try {
      validate = await upBank.validate(token)
    } catch (e) {
      return `Invalid Token: ${token}`
    }
    //Need to add actual validation...
    console.log(validate, 'validate')
    if (validate) {
      nconf.set('UP:token',token);
      nconf.set('actual', actual);
  
      nconf.save();
  
      const success = true;
      // sending a response
      res.render('setup', { token: token, actual: actual, success: success })
    } else {
      res.render('setup', { token: token, actual: actual, error: 'UP Token not valid' })
    }
});

app.use(express.static('public'));

app.post('/sync', async (req, res) => {
  await _sync();
  res.json({message: "Good"});
})

async function _sync() {
  if(actualInstance) {
    await actualInstance.shutdown()
  }
  startDate = new Date()
  startDate.setDate(startDate.getDate() - 5)

  budgetspath = __dirname+'/budgets'
  fsExtra.emptyDirSync(budgetspath);

  await sync.run(token, actual, linkedAccounts, startDate)

  console.log('Clearing temporary budget files.')
  fsExtra.emptyDirSync(budgetspath);

  console.log('Complete')
  // process.exit()
}

if(cronEnabled) {
  console.log("Starting cron");
  var cron = require('node-cron');

  // set schedule for cron, if not set then default to hourly.
  let cronShedule = nconf.get('cronSchedule') || '0 * * * *';
  let _valid = cron.validate(cronShedule);
  if(_valid) {
    cron.schedule(cronShedule, async () => {
      await _sync();
    });
  } else {
    cronShedule = '0 * * * *';
    cron.schedule(cronShedule, async () => {
      await _sync();
    });
    console.log('Cron format not valid check entered value - defaulting to hourly cron')
  }
}