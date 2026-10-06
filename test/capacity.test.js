import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageShares, channelBudget, channelCapacity, normalizeShares, shareKey, shareOf,
} from '../src/capacity.js';

const span = { starts_on: '2026-08-01', ends_on: '2026-08-31', active: true, paused_at: null };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

/* ---------- normalizeShares ---------- */

test('normalizeShares — מפורשים מעל 100% מוקטנים ל-100%, ואוטומטי מקבל 0', () => {
  const a = { ...span, id: 1, endpoint_id: 1, share_pct: 60 };
  const b = { ...span, id: 2, endpoint_id: 2, share_pct: 90 };
  const c = { ...span, id: 3, endpoint_id: 3, share_pct: null, endpoint_importance: 9 };
  const s = normalizeShares([a, b, c], { from: '2026-08-01', to: '2026-08-31' });
  near(s.get(1), 0.4);
  near(s.get(2), 0.6);
  assert.equal(s.get(3), 0);
});

test('normalizeShares — 60% קבוע + אוטומטי: האוטומטי מקבל את היתרה, לא 50%', () => {
  const fixed = { ...span, id: 1, endpoint_id: 1, share_pct: 60 };
  const a = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 6 };
  const b = { ...span, id: 3, endpoint_id: 3, endpoint_importance: 2 };
  const s = normalizeShares([fixed, a, b], { from: '2026-08-01', to: '2026-08-31' });
  near(s.get(1), 0.6);
  near(s.get(2), 0.4 * 6 / 8);
  near(s.get(3), 0.4 * 2 / 8);
  near([...s.values()].reduce((x, y) => x + y, 0), 1);
});

test('normalizeShares — מושהה, לא פעיל ומחוץ לטווח לא מתחרים', () => {
  const a = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 5 };
  const paused = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 5,
                   paused_at: '2026-08-02T10:00:00Z' };
  const inactive = { ...span, id: 3, endpoint_id: 3, endpoint_importance: 5, active: false };
  const later = { ...span, id: 4, endpoint_id: 4, endpoint_importance: 5,
                  starts_on: '2026-10-01', ends_on: '2026-10-31' };
  const s = normalizeShares([a, paused, inactive, later], { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual([...s.keys()], [1]);
  assert.equal(s.get(1), 1);
});

test('normalizeShares — קמפיינים של אותה נקודה מתחלקים שווה בחלק שלה', () => {
  const a1 = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 6 };
  const a2 = { ...span, id: 2, endpoint_id: 1, endpoint_importance: 6 };
  const b = { ...span, id: 3, endpoint_id: 2, endpoint_importance: 3 };
  const s = normalizeShares([a1, a2, b], { from: '2026-08-01', to: '2026-08-31' });
  // הנקודה נספרת פעם אחת (6 מול 3), לא פעם לכל קמפיין שלה
  near(s.get(1), (6 / 9) / 2);
  near(s.get(2), (6 / 9) / 2);
  near(s.get(3), 3 / 9);
});

test('normalizeShares — תאריכים חסרים = פתוח; טיוטה בלי מזהה נקראת draft', () => {
  const open = { id: 1, endpoint_id: 1, active: true, endpoint_importance: 5 };
  const draft = { ...span, endpoint_id: 2, endpoint_importance: 5 };
  assert.equal(shareKey(draft), 'draft');
  const s = normalizeShares([open, draft], { from: '2026-08-10', to: '2026-08-16' });
  near(s.get(1), 0.5);
  near(s.get('draft'), 0.5);
});

/* ---------- shareOf ---------- */

test('shareOf — הקמפיין נספר גם כשאינו ברשימה, ונמדד על החלון שלו', () => {
  const other = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 5 };
  const outside = { ...span, id: 3, endpoint_id: 3, endpoint_importance: 5,
                    starts_on: '2026-12-01', ends_on: '2026-12-31' };
  const draft = { ...span, endpoint_id: 1, endpoint_importance: 5 };
  near(shareOf(draft, [other, outside]), 0.5);
});

test('shareOf — מושהה עדיין רואה כמה יקבל; החשיבות נלקחת מהרשימה לפי מזהה', () => {
  const listed = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 8 };
  const other = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 2 };
  near(shareOf({ ...span, id: 1, endpoint_id: 1 }, [listed, other]), 0.8);
  near(shareOf({ ...listed, paused_at: '2026-08-03T00:00:00Z' }, [listed, other]), 0.8);
});

test('shareOf — share_pct מפורש מנצח; בלי מתחרים = 1', () => {
  assert.equal(shareOf({ ...span, id: 1, endpoint_id: 1, share_pct: 25 }, []), 0.25);
  assert.equal(shareOf({ ...span, id: 1, endpoint_id: 1, endpoint_importance: 6 }, []), 1);
});

/* ---------- averageShares: ממוצע הנתח היומי ---------- */

// אוטומטי לאורך אוק׳–דצמ׳, 60% קבוע באוקטובר, 50% קבוע בדצמבר. שני הקבועים
// לא נפגשים — נרמול אחד על כל הטווח סכם אותם ל-110% ונתן לאוטומטי 0.
const autoQ4 = { id: 1, endpoint_id: 1, endpoint_importance: 5, active: true,
                 starts_on: '2026-10-01', ends_on: '2026-12-31' };
const fixedOct = { id: 2, endpoint_id: 2, share_pct: 60, active: true,
                   starts_on: '2026-10-01', ends_on: '2026-10-31' };
const fixedDec = { id: 3, endpoint_id: 3, share_pct: 50, active: true,
                   starts_on: '2026-12-01', ends_on: '2026-12-31' };

test('averageShares — קבועים שלא נפגשים לא נסכמים: האוטומטי מקבל את הממוצע היומי', () => {
  const s = averageShares([autoQ4, fixedOct, fixedDec], { from: '2026-10-01', to: '2026-12-31' });
  // 31 יום × 40% + 30 × 100% + 31 × 50%, חלקי 92
  near(s.get(1), (31 * 0.4 + 30 * 1 + 31 * 0.5) / 92);
  near(s.get(2), (31 * 0.6) / 92);
  near(s.get(3), (31 * 0.5) / 92);
  near(shareOf(autoQ4, [autoQ4, fixedOct, fixedDec]), s.get(1));
  // הנרמול הישן על כל הטווח — 0
  assert.equal(normalizeShares([autoQ4, fixedOct, fixedDec],
    { from: '2026-10-01', to: '2026-12-31' }).get(1), 0);
});

test('averageShares — יום בודד = normalizeShares; טווח פתוח נופל לנרמול אחד', () => {
  const list = [autoQ4, fixedOct, fixedDec];
  const day = { from: '2026-10-15', to: '2026-10-15' };
  assert.deepEqual(averageShares(list, day), normalizeShares(list, day));
  assert.deepEqual(averageShares(list, { from: '2026-10-15', to: null }),
    normalizeShares(list, { from: '2026-10-15', to: null }));
});

test('averageShares — קמפיין שרץ חצי מהטווח נספר בחצי', () => {
  const half = { id: 9, endpoint_id: 9, endpoint_importance: 5, active: true,
                 starts_on: '2026-11-16', ends_on: '2026-11-30' };
  const s = averageShares([half], { from: '2026-11-01', to: '2026-11-30' });
  near(s.get(9), 15 / 30);
});

test('shareOf — קבועים שמכסים 100% כל הזמן: לאוטומטי באמת אין מקום', () => {
  const full = { ...fixedOct, share_pct: 100, ends_on: '2026-12-31' };
  assert.equal(shareOf(autoQ4, [autoQ4, full]), 0);
});

/* ---------- channelBudget / channelCapacity ---------- */

test('channelBudget — תקרה פחות השמורה לדחופים (ברירת מחדל 20%)', () => {
  assert.equal(channelBudget({ max_per_week: 5, urgent_reserve_pct: 20 }), 4);
  assert.equal(channelBudget({ max_per_week: 5 }), 4);
  assert.equal(channelBudget({ max_per_week: 3, urgent_reserve_pct: 20 }), 3); // floor(0.6) = 0
  assert.equal(channelBudget({ max_per_week: 7, urgent_reserve_pct: 0 }), 7);
});

test('channelCapacity — 13 יום, 7 בשבוע, מרווח 7 → 2, המרווח מגביל', () => {
  const r = channelCapacity({ from: '2026-11-20', to: '2026-12-02',
    channel: { max_per_week: 7, urgent_reserve_pct: 0 }, share: 1, gapDays: 7 });
  assert.equal(r.availableDays, 13);
  assert.equal(r.wanted, 13);
  assert.equal(r.rateCap, 13);
  assert.equal(r.gapCap, 2);
  assert.equal(r.capacity, 2);
  assert.equal(r.limitedBy, 'gap');
});

test('channelCapacity — ימים חסומים מורידים ימים פנויים; הכול חסום = 0', () => {
  // 2026-11-01 הוא יום ראשון. חוסמים שישי-שבת (5, 6) — כמו getDay במנוע
  const r = channelCapacity({ from: '2026-11-01', to: '2026-11-14',
    channel: { max_per_week: 7, urgent_reserve_pct: 0, blocked_days: [5, 6] },
    share: 1, gapDays: 1 });
  assert.equal(r.availableDays, 10);
  assert.equal(r.gapCap, 10);
  assert.equal(r.capacity, 10);
  assert.equal(r.limitedBy, 'gap');   // 10 ימים פנויים מול קצב של 14

  const none = channelCapacity({ from: '2026-11-01', to: '2026-11-07',
    channel: { max_per_week: 3, blocked_days: [0, 1, 2, 3, 4, 5, 6] }, share: 1 });
  assert.equal(none.availableDays, 0);
  assert.equal(none.capacity, 0);
  assert.equal(none.limitedBy, 'blocked');
});

test('channelCapacity — השמורה לדחופים מקטינה את rateCap', () => {
  const r = channelCapacity({ from: '2026-11-01', to: '2026-11-28',
    channel: { max_per_week: 5, urgent_reserve_pct: 20 }, share: 0.5, gapDays: 1 });
  assert.equal(r.wanted, 10);   // 5 × 4 × 0.5
  assert.equal(r.rateCap, 8);   // (5 − 1) × 4 × 0.5
  assert.equal(r.capacity, 8);
  assert.equal(r.limitedBy, 'rate');
});

test('channelCapacity — מרווח 1: הקצב הוא המגביל', () => {
  const r = channelCapacity({ from: '2026-11-01', to: '2026-11-14',
    channel: { max_per_week: 3, urgent_reserve_pct: 0 }, share: 1, gapDays: 1 });
  assert.equal(r.gapCap, 14);
  assert.equal(r.capacity, 6);
  assert.equal(r.limitedBy, 'rate');
});

test('channelCapacity — נתח קטן: לפחות 1 כשיש יום פנוי; נתח 0 = 0', () => {
  const ch = { max_per_week: 1, urgent_reserve_pct: 0 };
  const tiny = channelCapacity({ from: '2026-11-01', to: '2026-11-07', channel: ch, share: 0.1 });
  assert.equal(tiny.rateCap, 0);
  assert.equal(tiny.capacity, 1);
  const zero = channelCapacity({ from: '2026-11-01', to: '2026-11-07', channel: ch, share: 0 });
  assert.equal(zero.capacity, 0);
});

test('channelCapacity — תקציב 0 (תקרה 0 או 100% לדחופים): 0, לא דורשים פוסט', () => {
  for (const channel of [{ max_per_week: 0 }, { max_per_week: 3, urgent_reserve_pct: 100 }]) {
    const r = channelCapacity({ from: '2026-11-01', to: '2026-11-14', channel, share: 1 });
    assert.equal(r.capacity, 0);
    assert.equal(r.limitedBy, 'budget');
  }
});
