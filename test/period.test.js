import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, inferPeriod, parsePeriod, periodEnd, periodLabel,
} from '../public/js/core/period.js';

test('periodEnd — שבועות: הסיום כולל, start + 7N − 1', () => {
  assert.equal(periodEnd('2026-11-01', '1w'), '2026-11-07');
  assert.equal(periodEnd('2026-11-01', '2w'), '2026-11-14');
  assert.equal(periodEnd('2026-11-01', '3w'), '2026-11-21');
  assert.equal(periodEnd('2026-12-28', '1w'), '2027-01-03'); // מעבר שנה
  assert.equal(periodEnd('2026-11-01', '6w'), '2026-12-12');
});

test('periodEnd — שבוע שחוצה מעבר שעון לא זז ביום', () => {
  // שעון חורף בישראל: 25.10.2026
  assert.equal(periodEnd('2026-10-22', '1w'), '2026-10-28');
  // שעון קיץ: 27.3.2026
  assert.equal(periodEnd('2026-03-24', '2w'), '2026-04-06');
});

test('periodEnd — חודשים קלנדריים', () => {
  assert.equal(periodEnd('2026-11-01', '1m'), '2026-11-30');
  assert.equal(periodEnd('2026-01-15', '1m'), '2026-02-14');
  assert.equal(periodEnd('2026-11-12', '1m'), '2026-12-11');
  assert.equal(periodEnd('2026-11-01', '2m'), '2026-12-31');
  assert.equal(periodEnd('2026-11-01', '3m'), '2027-01-31'); // מעבר שנה
  assert.equal(periodEnd('2026-12-15', '2m'), '2027-02-14');
});

test('periodEnd — סוף חודש: יום שלא קיים בחודש היעד → היום האחרון שלו', () => {
  assert.equal(periodEnd('2026-01-31', '1m'), '2026-02-28');
  assert.equal(periodEnd('2028-01-31', '1m'), '2028-02-29'); // שנה מעוברת
  assert.equal(periodEnd('2026-01-30', '1m'), '2026-02-28');
  assert.equal(periodEnd('2026-01-29', '1m'), '2026-02-28');
  assert.equal(periodEnd('2026-01-28', '1m'), '2026-02-27');
  assert.equal(periodEnd('2026-03-31', '1m'), '2026-04-30');
  assert.equal(periodEnd('2026-12-31', '2m'), '2027-02-28');
  assert.equal(periodEnd('2026-08-31', '3m'), '2026-11-30');
});

test('periodEnd — ידני / לא תקין / בלי התחלה → null', () => {
  assert.equal(periodEnd('2026-11-01', 'custom'), null);
  assert.equal(periodEnd('2026-11-01', 'x'), null);
  assert.equal(periodEnd('2026-11-01', '0w'), null);
  assert.equal(periodEnd('2026-11-01', '200w'), null);
  assert.equal(periodEnd(null, '1w'), null);
});

test('parsePeriod', () => {
  assert.deepEqual(parsePeriod('5w'), { n: 5, unit: 'w' });
  assert.deepEqual(parsePeriod('2m'), { n: 2, unit: 'm' });
  assert.deepEqual(parsePeriod('custom'), { unit: 'custom' });
  assert.equal(parsePeriod('w5'), null);
  assert.equal(parsePeriod(''), null);
  assert.equal(parsePeriod(null), null);
});

test('inferPeriod — קמפיין ישן: חודש, שבועות שלמים, אחרת ידני', () => {
  assert.equal(inferPeriod('2026-11-01', '2026-11-30'), '1m');
  assert.equal(inferPeriod('2026-01-31', '2026-02-28'), '1m');
  assert.equal(inferPeriod('2026-11-01', '2026-12-31'), '2m');
  assert.equal(inferPeriod('2026-11-01', '2026-11-07'), '1w');
  assert.equal(inferPeriod('2026-11-01', '2026-12-05'), '5w');
  assert.equal(inferPeriod('2026-11-01', '2026-11-10'), 'custom');
  assert.equal(inferPeriod('2026-11-10', '2026-11-01'), 'custom');
  assert.equal(inferPeriod(null, '2026-11-01'), 'custom');
});

test('inferPeriod ∘ periodEnd — הלוך ושוב חוזר לאותה תקופה', () => {
  for (const p of ['1w', '2w', '3w', '1m', '2m', '3m', '7w']) {
    assert.equal(inferPeriod('2026-11-12', periodEnd('2026-11-12', p)), p);
  }
});

test('addDays / periodLabel', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(periodLabel('1m'), 'חודש');
  assert.equal(periodLabel('5w'), '5 שבועות');
  assert.equal(periodLabel('custom'), 'תאריך סיום ידני');
});
