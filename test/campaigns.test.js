import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveShare, angleCount, channelNeeds } from '../src/campaigns.js';

const span = { starts_on: '2026-08-01', ends_on: '2026-08-31', active: true };

test('effectiveShare — share_pct מפורש מנצח את המשקל', () => {
  assert.equal(effectiveShare({ ...span, share_pct: 25, importance: 9 }, []), 0.25);
});

test('effectiveShare — נגזר מהמשקל מול הקמפיינים החופפים', () => {
  const a = { ...span, importance: 6 };
  const b = { ...span, importance: 3 };
  assert.equal(effectiveShare(a, [a, b]), 6 / 9);
});

test('effectiveShare — בלי חופפים מחזיר 1', () => {
  assert.equal(effectiveShare({ ...span, importance: 6 }, []), 1);
});

test('effectiveShare — חופף לא פעיל לא נספר', () => {
  const a = { ...span, importance: 5 };
  const inactive = { ...span, importance: 5, active: false };
  assert.equal(effectiveShare(a, [a, inactive]), 1); // רק a נספר: 5/5
});

test('angleCount — target_posts מפורש מנצח', () => {
  assert.equal(angleCount({ target_posts: 7 }, new Map([[1, 3]])), 7);
});

test('angleCount — אחרת המדיה התובענית ביותר', () => {
  assert.equal(angleCount({}, new Map([[1, 3], [2, 5]])), 5);
});

test('angleCount — בלי צרכים מחזיר null', () => {
  assert.equal(angleCount({}, new Map()), null);
});

test('channelNeeds — קצב × שבועות × נתח, מינימום 1', () => {
  const camp = { starts_on: '2026-08-01', ends_on: '2026-08-07', active: true, importance: 5 };
  const needs = channelNeeds(camp, [{ id: 1, target_per_week: 3 }], [camp]);
  assert.equal(needs.get(1), 3); // שבוע אחד, נתח 1, קצב 3
});

test('channelNeeds — בלי תאריכים מחזיר מפה ריקה', () => {
  assert.equal(channelNeeds({ active: true }, [{ id: 1, target_per_week: 3 }], []).size, 0);
});
