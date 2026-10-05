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
