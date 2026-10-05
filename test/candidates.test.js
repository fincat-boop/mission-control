import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFits, hintFor } from '../src/candidates.js';
import { plannedDate } from '../src/engine.js';

// קמפיין מוכן 1–30.11, הפריט השלישי מתוך שישה: התאריך המתוכנן 11.11
const complete = (over = {}) => ({
  id: 5, campaign_id: 9, slot_channel_id: null,
  campaign_starts_on: '2026-11-01', campaign_ends_on: '2026-11-30',
  campaign_complete_at: '2026-10-01T00:00:00Z', campaign_slot_rank: 3, campaign_slot_count: 6,
  ...over,
});

test('candidateFits — קמפיין מוכן: לא לפני התאריך המתוכנן, כן ממנו והלאה', () => {
  assert.equal(plannedDate(complete()), '2026-11-11');
  assert.equal(candidateFits(complete(), 1, '2026-11-10'), false);
  assert.equal(candidateFits(complete(), 1, '2026-11-11'), true);
  assert.equal(candidateFits(complete(), 1, '2026-11-20'), true);
  // אותו פריט בקמפיין רגיל (לא מוכן) — כל החלון פתוח
  assert.equal(candidateFits(complete({ campaign_complete_at: null }), 1, '2026-11-02'), true);
});

test('candidateFits — משבצת-מדיה רק בערוץ שלה; בלי תאריך נבדק רק הערוץ', () => {
  const slot = complete({ slot_channel_id: 2 });
  assert.equal(candidateFits(slot, 1, '2026-11-20'), false);
  assert.equal(candidateFits(slot, 2, '2026-11-20'), true);
  assert.equal(candidateFits(slot, 2), true);
});

test('hintFor — הרמז בלוח לא מבטיח פריט של קמפיין מוכן לפני התאריך המתוכנן', () => {
  const post = { endpoint_id: 7, channel_id: 1 };
  const rows = [
    { ...complete(), endpoint_id: 7, channel_id: 1, status: 'ready' },
    { id: 6, campaign_id: null, endpoint_id: 7, channel_id: 1, status: 'draft' },
  ];
  assert.equal(hintFor(rows, post, '2026-11-11'), 'ready');
  assert.equal(hintFor(rows, post, '2026-11-05'), 'draft');     // המוכן מחכה ל-11.11
  assert.equal(hintFor(rows.slice(0, 1), post, '2026-11-05'), null);
  assert.equal(hintFor(rows, { endpoint_id: 8, channel_id: 1 }, '2026-11-11'), null);
});
