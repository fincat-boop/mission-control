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

test('open — בלי תאריך סיום: תקין, בלי סוף מחושב, עם שם', () => {
  assert.deepEqual(parsePeriod('open'), { unit: 'open' });
  assert.equal(periodEnd('2026-11-01', 'open'), null);
  assert.equal(periodLabel('open'), 'בלי תאריך סיום');
});

test('periodLabel — חודשים שאינם בין המוכנים', () => {
  assert.equal(periodLabel('4m'), '4 חודשים');
  assert.equal(periodLabel('12m'), '12 חודשים');
  assert.equal(inferPeriod('2026-11-01', periodEnd('2026-11-01', '5m')), '5m');
});

import { spreadDate } from '../public/js/core/period.js';

test('spreadDate — הראשון ביום ההתחלה, האחרון מקטע לפני הסוף, אחיד ביניהם', () => {
  // חודש של 30 יום, 6 פריטים → מקטעים של 5 ימים
  const six = [0, 1, 2, 3, 4, 5].map((i) => spreadDate('2026-11-01', '2026-11-30', i, 6));
  assert.deepEqual(six, ['2026-11-01', '2026-11-06', '2026-11-11', '2026-11-16',
                         '2026-11-21', '2026-11-26']);
  assert.ok(six[5] < '2026-11-30');           // נשאר מרווח אם המשבצת האחרונה התפספסה
  assert.equal(spreadDate('2026-11-01', '2026-11-30', 0, 1), '2026-11-01');
  assert.equal(spreadDate('2026-11-01', null, 3, 6), '2026-11-01');
  assert.equal(spreadDate(null, '2026-11-30', 0, 2), null);
  // יותר פריטים מימים — כמה באותו יום, אף אחד לא אחרי הסוף
  assert.equal(spreadDate('2026-11-01', '2026-11-03', 3, 4), '2026-11-03');
  // מעבר שעון (סוף אוקטובר) לא מזיז יום: 15 יום, 2 פריטים → 0 ו-7
  assert.equal(spreadDate('2026-10-20', '2026-11-03', 1, 2), '2026-10-27');
});

/* ---------- קמפיין מחזורי: התקופה והשם של הרצה חדשה ---------- */

import { rerunPeriod, runName, spanDays } from '../public/js/core/period.js';

test('rerunPeriod — תקופה קבועה נשמרת, והסיום מחושב מההתחלה החדשה (קצוות סוף חודש)', () => {
  const tpl = { period: '1m', starts_on: '2026-01-31', ends_on: '2026-02-28' };
  assert.deepEqual(rerunPeriod(tpl, '2026-03-31'), { period: '1m' });
  // הסיום עצמו נגזר בשרת מ-periodEnd: חודש מ-31.3 → 30.4, מ-31.1 בשנה מעוברת → 29.2
  assert.equal(periodEnd('2026-03-31', '1m'), '2026-04-30');
  assert.equal(periodEnd('2028-01-31', '1m'), '2028-02-29');
  assert.equal(periodEnd('2026-12-15', '2m'), '2027-02-14');
  assert.deepEqual(rerunPeriod({ period: '3w' }, '2026-11-01'), { period: '3w' });
});

test('rerunPeriod — סיום ידני: אותו מספר ימים; בלי תקופה: מוסקת מהתאריכים', () => {
  // 10 ימים כולל (1–10 בנובמבר) → 10 ימים מההתחלה החדשה, גם דרך סוף חודש
  const custom = { period: 'custom', starts_on: '2026-11-01', ends_on: '2026-11-10' };
  assert.deepEqual(rerunPeriod(custom, '2026-12-27'), { period: 'custom', ends_on: '2027-01-05' });
  assert.equal(spanDays('2026-12-27', '2027-01-05'), 10);
  // ידני שבמקרה הוא חודש שלם נשאר ידני — מה שהמשתמש בחר
  assert.deepEqual(rerunPeriod({ period: 'custom', starts_on: '2026-11-01', ends_on: '2026-11-30' },
    '2027-02-01'), { period: 'custom', ends_on: '2027-03-02' });
  // קמפיין מלפני השדה: 1.11–30.11 = חודש, 14 ימים = שבועיים, 10 ימים = ידני
  assert.deepEqual(rerunPeriod({ period: null, starts_on: '2026-11-01', ends_on: '2026-11-30' },
    '2027-02-01'), { period: '1m' });
  assert.deepEqual(rerunPeriod({ period: null, starts_on: '2026-11-01', ends_on: '2026-11-14' },
    '2027-02-01'), { period: '2w' });
  assert.deepEqual(rerunPeriod({ period: null, starts_on: '2026-11-01', ends_on: '2026-11-10' },
    '2027-02-01'), { period: 'custom', ends_on: '2027-02-10' });
});

test('rerunPeriod — בלי תאריך סיום (open / בלי תאריכים) אין מה להעתיק: null', () => {
  assert.equal(rerunPeriod({ period: 'open', starts_on: '2026-11-01', ends_on: null }, '2027-01-01'), null);
  assert.equal(rerunPeriod({ period: null, starts_on: null, ends_on: null }, '2027-01-01'), null);
});

test('runName — שם ההרצה לפי חודש הפוסט הראשון', () => {
  assert.equal(runName('השקה', '2026-11-03'), 'השקה · נובמבר 2026');
  assert.equal(runName('השקה', '2027-01-31'), 'השקה · ינואר 2027');
  assert.equal(runName('השקה', null), 'השקה');
});
