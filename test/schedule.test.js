'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeSchedule } = require('../src/schedule');

test('describeSchedule names common intervals', () => {
  assert.equal(describeSchedule('0 * * * *'), 'Every hour');
  assert.equal(describeSchedule('15 * * * *'), 'Every hour at 15 past');
  assert.equal(describeSchedule('*/30 * * * *'), 'Every 30 minutes');
  assert.equal(describeSchedule('0 */4 * * *'), 'Every 4 hours');
  assert.equal(describeSchedule('0 0 */6 * * *'), 'Every 6 hours');
  assert.equal(describeSchedule('* * * * *'), 'Every minute');
});

test('describeSchedule leaves clock-time and unusual schedules to the next-run time', () => {
  for (const expr of ['0 6 * * *', '0 9 * * 1-5', '0 */4 1 * *', '30 0 */4 * * *', 'nonsense', '', undefined]) {
    assert.equal(describeSchedule(expr), null, String(expr));
  }
});
