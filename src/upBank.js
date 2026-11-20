'use strict';

const BASE_URL = 'https://api.up.com.au/api/v1';
const PAGE_SIZE = 100;
// Hard stop so a misbehaving API can never loop us forever.
const MAX_PAGES = 50;

class UpApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'UpApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(token, url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const detail = body?.errors?.map((e) => e.detail || e.title).join('; ');
    throw new UpApiError(`Up API ${res.status}${detail ? `: ${detail}` : ''}`, res.status, body);
  }
  return res.json();
}

/** Follow `links.next` until exhausted, collecting every `data` item. */
async function paginate(token, firstUrl, fetchImpl = fetch) {
  const items = [];
  let url = firstUrl;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) {
      throw new UpApiError(`Up API pagination exceeded ${MAX_PAGES} pages`);
    }
    const json = await request(token, url, fetchImpl);
    items.push(...(json.data || []));
    url = json.links?.next || null;
  }
  return items;
}

async function getTransactions(token, upAccountId, since, fetchImpl = fetch) {
  const url = new URL(`${BASE_URL}/accounts/${encodeURIComponent(upAccountId)}/transactions`);
  url.searchParams.set('page[size]', String(PAGE_SIZE));
  if (since) url.searchParams.set('filter[since]', new Date(since).toISOString());
  return paginate(token, url.toString(), fetchImpl);
}

async function getAccounts(token, fetchImpl = fetch) {
  const url = new URL(`${BASE_URL}/accounts`);
  url.searchParams.set('page[size]', String(PAGE_SIZE));
  return paginate(token, url.toString(), fetchImpl);
}

async function validate(token, fetchImpl = fetch) {
  if (!token) return false;
  try {
    await request(token, `${BASE_URL}/util/ping`, fetchImpl);
    return true;
  } catch (err) {
    if (err instanceof UpApiError && err.status === 401) return false;
    throw err;
  }
}

module.exports = { BASE_URL, UpApiError, getTransactions, getAccounts, validate };
