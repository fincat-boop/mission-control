import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCadenceDays } from '../src/board.js';

test('effectiveCadenceDays — חשיבות גבוהה = קצב תכוף', () => {
  assert.equal(effectiveCadenceDays({ importance: 10 }), 6);  // round(60/10)
  assert.equal(effectiveCadenceDays({ importance: 5 }), 12);  // round(60/5)
});

test('effectiveCadenceDays — נחסם בין 2 ל-30', () => {
  assert.equal(effectiveCadenceDays({ importance: 1 }), 30);   // 60 → תקרה 30
  assert.equal(effectiveCadenceDays({ importance: 40 }), 2);   // 1.5 → רצפה 2
});

test('effectiveCadenceDays — min_days_between הוא override מפורש', () => {
  assert.equal(effectiveCadenceDays({ importance: 10, min_days_between: 14 }), 14);
});
