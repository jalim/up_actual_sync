const express = require('express');
const nconf = require('nconf');
const bodyParser = require('body-parser');
const upBank = require('./upBank');
const { validate } = require('node-cron');
const configFile = process.env.configFile || './config.json';



// Initialize nconf to use (in-order):
//   1. Command-line arguments
//   2. Environment variables
//   3. A configuration file
//   4. Default values
nconf.argv().env().file({ file: configFile }).defaults({
  port: 3000,
});


const app = express();

app.use(bodyParser.urlencoded({ extended: true }));

// Get the value of the 'port' key from the configuration data
const port = nconf.get('port');

app.listen(port, () => {
  console.log(`Microservice listening on port ${port}`);
});

app.get('/config', (req, res) => {
    res.json(nconf.get('port'));
  });

app.set('view engine', 'pug')

app.get('/', (req, res) => {
    const token = nconf.get('UP:token')
    const actual = nconf.get('actual')

    res.render('index', { token: token, actual: actual })
  })

app.post('/', async (req, res) => {
    // accessing form fields from req.body
    const token = req.body.token || ''
    const budgetId = req.body.budgetId || ''
    const budgetEncryption = req.body.budgetEncryption
    const serverUrl = req.body.serverUrl || ''
    const serverPassword = req.body.serverPassword || ''
    const sendNotes = req.body.sendNotes || ''
    console.log(budgetEncryption, 'url')
    // verification steps 
    // if (!username || !password) {
    //     return res.status(400).send('Username and password are required.');
    // }
    let validate = false
    try {
      validate = await upBank.validate(token)
    } catch (e) {
      return `Invalid Token: ${token}`
    }
    console.log(validate, 'validate')
    if (validate) {
      nconf.set('UP:token',token);
      nconf.set('actual:budgetId',budgetId);
      nconf.set('actual:budgetEncryption',budgetEncryption);
      nconf.set('actual:serverUrl',serverUrl);
      nconf.set('actual:serverPassword',serverPassword);
      nconf.set('actual:sendNotes',sendNotes);
      nconf.set('actual:serverValidated', 'yes');
  
      nconf.save();
  
      const success = true;
  
      const actual = nconf.get('actual');
      // sending a response
      res.render('index', { token: token, actual: actual, success: success })
    } else {
      const actual = nconf.get('actual');
      res.render('index', { token: token, actual: actual, error: 'UP Token not valid' })
    }
});