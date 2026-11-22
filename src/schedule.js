'use strict';

/**
 * Plain-English description of common interval schedules. Schedules pinned to
 * a clock hour return null: they run in the server's timezone, which may not
 * be the viewer's, so the UI shows the next run time instead.
 */
function describeSchedule(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length === 6) {
    if (fields[0] !== '0') return null;
    fields.shift();
  }
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== '*' || month !== '*' || dow !== '*') return null;
  const step = (f) => /^\*\/(\d+)$/.exec(f)?.[1];
  const fixedMinute = /^\d{1,2}$/.test(minute) && Number(minute) < 60 ? Number(minute) : null;
  const past = fixedMinute ? ` at ${fixedMinute} past` : '';

  if (hour === '*') {
    if (minute === '*') return 'Every minute';
    if (step(minute)) return `Every ${step(minute)} minutes`;
    if (fixedMinute !== null) return `Every hour${past}`;
  }
  if (step(hour) && fixedMinute !== null) return `Every ${step(hour)} hours${past}`;
  return null;
}

module.exports = { describeSchedule };
