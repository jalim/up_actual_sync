'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const up = require('../src/upBank');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const route = routes.find((r) => String(url).startsWith(r.prefix));
    if (!route) throw new Error(`unexpected url ${url}`);
    const { status = 200, body } = typeof route.respond === 'function' ? route.respond(calls.length) : route.respond;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('getTransactions follows links.next across pages', async () => {
  const next = `${up.BASE_URL}/accounts/acc1/transactions?page[after]=abc`;
  const f = fakeFetch([
    { prefix: next, respond: { body: { data: [{ id: 't3' }], links: { next: null } } } },
    {
      prefix: `${up.BASE_URL}/accounts/acc1/transactions`,
      respond: { body: { data: [{ id: 't1' }, { id: 't2' }], links: { next } } },
    },
  ]);
  const since = new Date('2026-11-01T00:00:00Z');
  const txns = await up.getTransactions('tok', 'acc1', since, { fetchImpl: f });
  assert.deepEqual(txns.map((t) => t.id), ['t1', 't2', 't3']);
  assert.equal(f.calls.length, 2);
  const first = new URL(f.calls[0].url);
  assert.equal(first.searchParams.get('filter[since]'), '2026-11-01T00:00:00.000Z');
  assert.equal(first.searchParams.get('page[size]'), '100');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer tok');
});

test('API errors surface status and detail', async () => {
  const f = fakeFetch([
    { prefix: up.BASE_URL, respond: { status: 500, body: { errors: [{ detail: 'boom' }] } } },
  ]);
  await assert.rejects(up.getAccounts('tok', { fetchImpl: f }), (err) => {
    assert.ok(err instanceof up.UpApiError);
    assert.equal(err.status, 500);
    assert.match(err.message, /boom/);
    return true;
  });
});

test('validate returns false on 401 and for empty token', async () => {
  const f = fakeFetch([{ prefix: up.BASE_URL, respond: { status: 401, body: {} } }]);
  assert.equal(await up.validate('bad', { fetchImpl: f }), false);
  assert.equal(await up.validate('', { fetchImpl: f }), false);
});

test('validate rethrows non-auth failures', async () => {
  const f = fakeFetch([{ prefix: up.BASE_URL, respond: { status: 503, body: {} } }]);
  await assert.rejects(up.validate('tok', { fetchImpl: f }), /503/);
});

test('pagination has a hard page limit', async () => {
  const f = fakeFetch([
    { prefix: up.BASE_URL, respond: { body: { data: [{}], links: { next: `${up.BASE_URL}/accounts?again` } } } },
  ]);
  await assert.rejects(up.getAccounts('tok', { fetchImpl: f, maxPages: 3 }), /exceeded 3 pages/);
  assert.equal(f.calls.length, 3);
});
