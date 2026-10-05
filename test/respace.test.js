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

import { readFileSync } from 'node:fs';
import { windowAllows } from '../src/respace.js';

// קמפיין מוכן בנובמבר, 6 פוסטים: השני מתוכנן ל-6.11
const completePost = (scheduledAt) => ({
  scheduled_at: scheduledAt, campaign_id: 7,
  campaign_starts_on: '2026-11-01', campaign_ends_on: '2026-11-30',
  campaign_complete_at: '2026-10-05T10:00:00Z', campaign_slot_rank: 2, campaign_slot_count: 6,
});

test('windowAllows — פוסט של קמפיין מוכן לא זז לפני התאריך המתוכנן שלו', () => {
  const p = completePost('2026-11-09T10:00:00');
  assert.equal(windowAllows(p, '2026-11-05'), false);   // לפני 6.11
  assert.equal(windowAllows(p, '2026-11-06'), true);
  assert.equal(windowAllows(p, '2026-11-12'), true);
  assert.equal(windowAllows(p, '2026-12-01'), false);   // אחרי סוף הקמפיין
  // קמפיין רגיל — רק החלון
  const normal = { ...p, campaign_complete_at: null };
  assert.equal(windowAllows(normal, '2026-11-02'), true);
});

test('planRespace שולף את עמודות "קמפיין מוכן" — אחרת הכלל לא חל בהזזה', () => {
  const src = readFileSync(new URL('../src/respace.js', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('export async function planRespace'), src.indexOf('const byId'));
  assert.match(q, /\$\{COMPLETE_SPREAD_COLUMNS\}/);
});
