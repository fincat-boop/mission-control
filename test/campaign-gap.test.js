import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapDaysError } from '../src/routes/campaigns.js';

/* ========================= מרווח לקמפיין — אימות הקלט ========================= */

test('gapDaysError — לא נשלח: אין שגיאה ולא נוגעים בגוף', () => {
  const b = { name: 'x' };
  assert.equal(gapDaysError(b), null);
  assert.equal('min_gap_days' in b, false);
});

test('gapDaysError — null או ריק = ברירת המחדל הכללית (null)', () => {
  for (const v of [null, '']) {
    const b = { min_gap_days: v };
    assert.equal(gapDaysError(b), null);
    assert.equal(b.min_gap_days, null);
  }
});

test('gapDaysError — מספר שלם 1..30 עובר, ומחרוזת מהטופס הופכת למספר', () => {
  for (const [v, n] of [[1, 1], ['7', 7], [30, 30]]) {
    const b = { min_gap_days: v };
    assert.equal(gapDaysError(b), null);
    assert.equal(b.min_gap_days, n);
  }
});

test('gapDaysError — 0, 31, שבר וטקסט נדחים בעברית', () => {
  for (const v of [0, 31, 2.5, 'abc', -3]) {
    assert.match(gapDaysError({ min_gap_days: v }), /בין 1 ל-30/);
  }
});
