import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onBlockedDay } from '../src/respace.js';

// 2026-08-14 = שישי (5), 2026-08-15 = שבת (6)
const friday = { scheduled_at: '2026-08-14T10:00:00' };
const saturday = { scheduled_at: '2026-08-15T10:00:00' };

test('onBlockedDay — יום שהערוץ חסם', () => {
  assert.equal(onBlockedDay(friday, { blocked_days: [5, 6] }), true);
  assert.equal(onBlockedDay(saturday, { blocked_days: [6] }), true);
});

test('onBlockedDay — יום פתוח', () => {
  assert.equal(onBlockedDay(friday, { blocked_days: [6] }), false);
  assert.equal(onBlockedDay(saturday, { blocked_days: [] }), false);
});

test('onBlockedDay — ערוץ בלי הגדרה בכלל לא חוסם', () => {
  assert.equal(onBlockedDay(saturday, {}), false);
  assert.equal(onBlockedDay(saturday, null), false);
});
