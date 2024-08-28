const axios = require('axios');

// Replace 'YOUR_PERSONAL_ACCESS_TOKEN' with your actual UP Bank API token
const BASE_URL = 'https://api.up.com.au/api/v1';
// Function to get settled transactions
async function getTransactions(API_TOKEN, startDate, upAccountId) {
  try {
    const response = await axios.get(`${BASE_URL}/accounts/${upAccountId}/transactions`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`
      },
      params: {
        //'filter[status]' : 'SETTLED',
        'page[size]' : '100',
        'filter[since]' : startDate
      }
    });

    return response.data.data;
  } catch (error) {
    console.error('Error fetching transactions:', error.response ? error.response.data : error.message);
    throw error;
  }
}

async function getAccounts(API_TOKEN) {
  try {
    const response = await axios.get(`${BASE_URL}/accounts`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`
      },
      params: {
      }
    });

    return response.data.data;
  } catch (error) {
    console.error('Error fetching accounts:', error.response ? error.response.data : error.message);
    throw error;
  }
}

async function validate(API_TOKEN) {
  try {
    const response = await axios.get(`${BASE_URL}/util/ping`, {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`
      }
    });

    return true;
  } catch (error) {
    console.error('Token Invalid Try Again');
    return false;
  }
}

// Export the function for use in other modules
module.exports = {
  getTransactions,
  getAccounts,
  validate
};
