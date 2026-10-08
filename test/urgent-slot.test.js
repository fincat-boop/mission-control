import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, urgentSlotTime } from '../src/urgent.js';

const at = (s) => new Date(s);
const iso = (d) => d?.toISOString() ?? null;
const day = (s) => { const d = new Date(s); d.setHours(0, 0, 0, 0); return d; };

test('parseTime — HH:MM תקין בלבד', () => {
  assert.deepEqual(parseTime('10:00'), [10, 0]);
  assert.deepEqual(parseTime('9:30'), [9, 30]);
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseTime('10:75'), null);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime(''), null);
});

test('urgentSlotTime — יום עתידי: בדיוק בשעה שנבחרה', () => {
  const now = at('2026-10-05T15:20:00');
  assert.equal(iso(urgentSlotTime(day('2026-10-06T12:00:00'), [10, 0], now)),
    iso(at('2026-10-06T10:00:00')));
});

test('urgentSlotTime — היום, השעה עוד לא עברה: השעה שנבחרה', () => {
  const now = at('2026-10-05T08:20:00');
  assert.equal(iso(urgentSlotTime(day('2026-10-05T12:00:00'), [10, 0], now)),
    iso(at('2026-10-05T10:00:00')));
});

test('urgentSlotTime — היום, השעה עברה: השעה העגולה הבאה (לא משבצת שעברה)', () => {
  const now = at('2026-10-05T15:20:00');
  assert.equal(iso(urgentSlotTime(day('2026-10-05T12:00:00'), [10, 0], now)),
    iso(at('2026-10-05T16:00:00')));
  // 15:50 → לפחות רבע שעה קדימה → 17:00
  assert.equal(iso(urgentSlotTime(day('2026-10-05T12:00:00'), [10, 0], at('2026-10-05T15:50:00'))),
    iso(at('2026-10-05T17:00:00')));
});

test('urgentSlotTime — היום מאוחר מדי: אין מועד היום (עוברים למחר)', () => {
  const now = at('2026-10-05T21:30:00');
  assert.equal(urgentSlotTime(day('2026-10-05T12:00:00'), [10, 0], now), null);
});

/* ========================= סעיף 7 — למה דחוף לא נכנס ========================= */

test('סעיף 7 — urgentFullReason: השמורה בשימוש, עם המספר ואיפה מגדילים', async () => {
  const { urgentFullReason } = await import('../src/urgent.js');
  const ch = { name: 'וואטסאפ', max_per_week: 3, urgent_reserve_pct: 20, max_promo_per_week: 1 };
  const full = urgentFullReason(ch, '2026-10-14', new Map([['full', 7]]));
  assert.match(full, /הערוץ מלא, והשמורה לדחופים \(פוסט אחד בשבוע\) כבר בשימוש השבוע/);
  assert.match(full, /תחת "מתקדם"/);
  // שמורה 0 — לא "בשימוש", אלא שאין
  assert.match(urgentFullReason({ ...ch, max_per_week: 2 }, '2026-10-14', new Map()),
    /אין בו שטח שמור לדחופים/);
  // הסיבה ששללה הכי הרבה ימים
  assert.match(urgentFullReason(ch, '2026-10-14', new Map([['full', 1], ['promo_week', 5]])),
    /עד 1 מכירתיים בשבוע/);
  assert.match(urgentFullReason(ch, '2026-10-14', new Map([['promo_day', 3]]), 1),
    /בכל יום כבר יש מכירתי/);
});
