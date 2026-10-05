import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseView, serializeView } from '../public/js/core/state.js';

test('serializeView — השבוע נשמר רק בלוח, ורק כשנבחר שבוע', () => {
  assert.equal(serializeView({ tab: 'board', week: '2026-10-04' }), '#board;w=2026-10-04');
  assert.equal(serializeView({ tab: 'board', week: null }), '#board');
  assert.equal(serializeView({ tab: 'tasks', week: '2026-10-04' }), '#tasks');
  assert.equal(serializeView({ tab: 'plan', planEndpoint: 3, planCampaign: 7 }), '#plan;e=3;c=7');
});

test('parseView — שבוע, דרילדאון וטאב', () => {
  assert.deepEqual(parseView('#board;w=2026-10-04'),
    { tab: 'board', planEndpoint: null, planCampaign: null, week: '2026-10-04' });
  assert.deepEqual(parseView('#plan;e=3;c=7'),
    { tab: 'plan', planEndpoint: 3, planCampaign: 7, week: null });
  assert.equal(parseView('#board').week, null);
});

test('parseView — hash לא מוכר או שבוע שבור לא נכנסים', () => {
  assert.equal(parseView('#nope;w=2026-10-04'), null);
  assert.equal(parseView(''), null);
  assert.equal(parseView('#board;w=2026-13-45').week, null);
  assert.equal(parseView('#board;w=abc').week, null);
  assert.equal(parseView('#board;w=2026-10-04;x=1').week, '2026-10-04');
});

test('סיבוב מלא — מה שנשמר הוא מה שחוזר', () => {
  const s = { tab: 'board', week: '2026-11-01', planEndpoint: null, planCampaign: null };
  assert.deepEqual(parseView(serializeView(s)), s);
});

test('parseView — תאריך שלא קיים בלוח השנה (30.2) לא נכנס; מזהים רק שלמים חיוביים', () => {
  assert.equal(parseView('#board;w=2026-02-30').week, null);
  assert.equal(parseView('#board;w=2026-02-28').week, '2026-02-28');
  assert.equal(parseView('#board;w=2028-02-29').week, '2028-02-29'); // שנה מעוברת
  assert.equal(parseView('#plan;e=1.5;c=-3').planEndpoint, null);
  assert.equal(parseView('#plan;e=1.5;c=-3').planCampaign, null);
  assert.equal(parseView('#plan;e=0x10').planEndpoint, null);
  assert.equal(parseView('#plan;e=12').planEndpoint, 12);
});
