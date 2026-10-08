import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageShares, channelBudget, channelCapacity, effectiveGap, normalizeShares, shareKey, shareOf,
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

test('channelBudget — תקרה פחות השמורה לדחופים (ברירת מחדל 20%, מעוגלת לקרוב — סעיף 7)', () => {
  assert.equal(channelBudget({ max_per_week: 5, urgent_reserve_pct: 20 }), 4);
  assert.equal(channelBudget({ max_per_week: 5 }), 4);
  // קודם floor(0.6) = 0 — ובערוץ של 3 לא נשאר מקום לדחוף
  assert.equal(channelBudget({ max_per_week: 3, urgent_reserve_pct: 20 }), 2);
  assert.equal(channelBudget({ max_per_week: 7, urgent_reserve_pct: 0 }), 7);
});

test('סעיף 7 — urgentReserve: עיגול לקרוב, האחוז נשאר ההגדרה', async () => {
  const { urgentReserve } = await import('../public/js/core/reserve.js');
  const table = [[3, 1], [4, 1], [2, 0], [5, 1], [10, 2], [1, 0], [7, 1], [0, 0]];
  for (const [max, want] of table) assert.equal(urgentReserve(max, 20), want, `${max}`);
  assert.equal(urgentReserve(4, null), 1);      // ריק = 20%
  assert.equal(urgentReserve(5, 0), 0);
  assert.equal(urgentReserve(3, 100), 3);
  assert.equal(urgentReserve(3, 150), 3);       // לא יותר מהתקרה
  // 3 נקודות בערוץ של 4 עם השמורה (תקציב 3) → floor(21/3) = 7 (סעיף 5)
  assert.equal(derivedGap({ max_per_week: 4 }, 3), 7);
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

test('channelCapacity — איזה יום חסום: 0 = ראשון, כמו getDay במנוע', () => {
  // 1.11–8.11.2026: ראשון עד ראשון (8 ימים). מרווח 7 → ראשון וראשון = 2
  const at = (blocked) => channelCapacity({ from: '2026-11-01', to: '2026-11-08',
    channel: { max_per_week: 7, urgent_reserve_pct: 0, blocked_days: blocked },
    share: 1, gapDays: 7 });
  assert.equal(at([]).gapCap, 2);
  // ראשון חסום: שני הקצוות נופלים, נשארים שני–שבת (6 ימים) → אחד בלבד
  assert.equal(at([0]).availableDays, 6);
  assert.equal(at([0]).gapCap, 1);
  // שני חסום: שני הראשונים נשארים → עדיין 2. היסט של יום במיפוי היה הופך את שתי התוצאות
  assert.equal(at([1]).availableDays, 7);
  assert.equal(at([1]).gapCap, 2);
  // שבת חסומה: גם אז 2 (ראשון–ראשון), ו-7 ימים פנויים
  assert.equal(at([6]).gapCap, 2);
});

/* ========================= המרווח לפי קמפיין ========================= */

test('effectiveGap — של הקמפיין קודם, אחריו הכללי, ובלי שניהם 7', () => {
  assert.equal(effectiveGap({ min_gap_days: 3 }, { min_gap_days: 7 }), 3);
  assert.equal(effectiveGap({ min_gap_days: null }, { min_gap_days: 5 }), 5);
  assert.equal(effectiveGap({}, { min_gap_days: 5 }), 5);
  assert.equal(effectiveGap(null, { min_gap_days: 4 }), 4);
  assert.equal(effectiveGap(null, null), 7);
  assert.equal(effectiveGap(undefined, {}), 7);
  // 0 בהגדרה הכללית = בלי מרווח, לא "חסר" — לא נופלים ל-7
  assert.equal(effectiveGap(null, { min_gap_days: 0 }), 0);
  // מחרוזת מהמסד/מהטופס → מספר
  assert.equal(effectiveGap({ min_gap_days: '2' }, null), 2);
});

/* ========================= התאמה: לדחוס / להאריך ========================= */

import { endToFit, gapToFit } from '../src/capacity.js';

test('gapToFit — המרווח הגדול ביותר שבו הקיבולת מגיעה ליעד', () => {
  // 16 יום (20.11–5.12), קצב 4 בשבוע אחרי שמורה, נתח 40% → rateCap 4
  const params = { from: '2026-11-20', to: '2026-12-05',
                   channel: { max_per_week: 5, urgent_reserve_pct: 20 }, share: 0.4, siblings: 1 };
  assert.equal(channelCapacity({ ...params, gapDays: 7 }).capacity, 3);
  // 4 פוסטים ב-16 יום: מרווח 5 (20, 25, 30.11, 5.12) — 6 כבר נותן 3
  assert.equal(gapToFit(params, 4), 5);
  assert.equal(channelCapacity({ ...params, gapDays: 5 }).capacity, 4);
  assert.equal(channelCapacity({ ...params, gapDays: 6 }).capacity, 3);
  // יעד שהקצב לא מגיע אליו בשום מרווח
  assert.equal(gapToFit(params, 9), null);
  // gapOnly — רק הימים: 9 ב-16 יום במרווח 1
  assert.equal(gapToFit(params, 9, { gapOnly: true }), 1);
  assert.equal(gapToFit(params, 5, { gapOnly: true }), 3);
  assert.equal(gapToFit(params, 17, { gapOnly: true }), null);
  // יעד קטן — המרווח המקסימלי
  assert.equal(gapToFit(params, 1), 30);
});

test('gapToFit — אחים חולקים את הימים, ולכן צריך מרווח קצר יותר', () => {
  const params = { from: '2026-11-01', to: '2026-11-28',
                   channel: { max_per_week: 7, urgent_reserve_pct: 0 }, share: 1, siblings: 2 };
  // 28 יום, שני אחים. מרווח 4 נותן 7 ימים: הראשון (rank 0) מקבל 4, השני 3
  assert.equal(gapToFit(params, 4), 4);
  assert.equal(gapToFit({ ...params, siblingRank: 1 }, 4), 3);   // 8 ימים במרווח 3
  // לבד: 1, 10, 19, 28.11 — מרווח 9
  assert.equal(gapToFit({ ...params, siblings: 1 }, 4), 9);
});

test('endToFit — תאריך הסיום המוקדם ביותר שבו נכנס היעד', () => {
  const channel = { max_per_week: 7, urgent_reserve_pct: 0 };
  const at = (to) => channelCapacity({ from: '2026-11-01', to, channel, share: 1, gapDays: 7 })
    .capacity;
  // 3 פוסטים במרווח 7: 1, 8, 15.11
  assert.equal(endToFit('2026-11-01', at, 3), '2026-11-15');
  assert.equal(endToFit('2026-11-01', at, 1), '2026-11-01');
  // מעבר לטווח — null
  assert.equal(endToFit('2026-11-01', at, 60, 365), null);
  assert.equal(endToFit(null, at, 1), null);
});

test('channelCapacity — חלוקה בין 3 אחים כשיש רק 2 ימים: 1, 1, 0 — הסכום לא עובר', () => {
  // שבוע אחד במרווח 7 עם 8 ימים → 2 ימים (1.11, 8.11)
  const base = { from: '2026-11-01', to: '2026-11-08',
                 channel: { max_per_week: 7, urgent_reserve_pct: 0 }, share: 1, gapDays: 7,
                 siblings: 3 };
  const parts = [0, 1, 2].map((siblingRank) => channelCapacity({ ...base, siblingRank }));
  assert.deepEqual(parts.map((p) => p.gapCap), [1, 1, 0]);
  assert.deepEqual(parts.map((p) => p.capacity), [1, 1, 0]);
  assert.equal(parts[2].limitedBy, 'gap');
  assert.equal(parts.reduce((s, p) => s + p.gapCap, 0), 2);
});

test('siblingsOf — מספר האחים והמקום לפי מזהה; טיוטה אחרונה', async () => {
  const { siblingsOf } = await import('../src/capacity.js');
  const a = { id: 5, endpoint_id: 1, active: true, channel_ids: [6],
              starts_on: '2026-11-01', ends_on: '2026-11-30' };
  const list = [a, { ...a, id: 2 }, { ...a, id: 9 }];
  assert.deepEqual(siblingsOf(a, list, 6), { count: 3, rank: 1 });
  assert.deepEqual(siblingsOf({ ...a, id: undefined }, list, 6), { count: 4, rank: 3 });
  assert.deepEqual(siblingsOf(a, list, 7), { count: 1, rank: 0 });
});

/* ========================= סעיף 4 — נתחים לכל ערוץ ========================= */

import {
  averageSharesByChannel, blendByChannel, blendShares, channelSharesOf, normalizeSharesByChannel,
} from '../src/capacity.js';
import { channelCapacities } from '../src/campaigns.js';

// נקודה A בפייסבוק (1) בלבד, נקודה B בוואטסאפ (2) בלבד, אותה חשיבות
const onFb = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 5, channel_ids: [1] };
const onWa = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 5, channel_ids: [2] };

test('סעיף 4 — כל קמפיין לבד בערוץ שלו מקבל את כל הערוץ, לא 50%', () => {
  const s = normalizeSharesByChannel([onFb, onWa], { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual([...s.keys()].sort(), [1, 2]);
  assert.equal(s.get(1).get(1), 1);
  assert.equal(s.get(2).get(2), 1);
  assert.equal(s.get(1).has(2), false);
  // הנרמול הישן (בלי ערוצים) נתן לכל אחד 50% בכל ערוץ
  near(normalizeShares([onFb, onWa], { from: '2026-08-01', to: '2026-08-31' }).get(2), 0.5);
});

test('סעיף 4 — share_pct 100 בוואטסאפ לא מאפס את האוטומטי בפייסבוק', () => {
  const waFull = { ...onWa, share_pct: 100 };
  const fbAuto2 = { ...onFb, id: 3, endpoint_id: 3, channel_ids: [1, 2] };
  const s = normalizeSharesByChannel([onFb, waFull, fbAuto2],
    { from: '2026-08-01', to: '2026-08-31' });
  // פייסבוק: שני אוטומטיים, 50/50 — הקבוע של וואטסאפ לא שם
  near(s.get(1).get(1), 0.5);
  near(s.get(1).get(3), 0.5);
  // וואטסאפ: הקבוע לוקח 100%, האוטומטי שיושב גם שם — 0 רק שם
  assert.equal(s.get(2).get(2), 1);
  assert.equal(s.get(2).get(3), 0);
});

test('סעיף 4 — חשיבות מחלקת רק בין הנקודות שיש להן קמפיין בערוץ', () => {
  const a = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 6, channel_ids: [1, 2] };
  const b = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 2, channel_ids: [1] };
  const s = normalizeSharesByChannel([a, b], { from: '2026-08-01', to: '2026-08-31' });
  near(s.get(1).get(1), 0.75);
  near(s.get(1).get(2), 0.25);
  assert.equal(s.get(2).get(1), 1);
});

test('סעיף 4 — ממוצע בזמן לכל ערוץ: קבוע בוואטסאפ חצי מהזמן', () => {
  const fixed = { ...onWa, id: 9, endpoint_id: 9, share_pct: 100,
                  starts_on: '2026-08-01', ends_on: '2026-08-15' };
  const auto = { ...onWa, id: 2 };
  const s = averageSharesByChannel([auto, fixed, onFb], { from: '2026-08-01', to: '2026-08-31' });
  near(s.get(2).get(2), 16 / 31);
  near(s.get(1).get(1), 1);
  near(channelSharesOf(auto, [fixed, onFb]).get(2), 16 / 31);
});

test('סעיף 4 — נתח אחד לתצוגה: משוקלל בתקציב הערוצים', () => {
  const fb = { id: 1, max_per_week: 10, urgent_reserve_pct: 0 };
  const wa = { id: 2, max_per_week: 5, urgent_reserve_pct: 0 };
  near(blendShares(new Map([[1, 0.5], [2, 1]]), [fb, wa]), (5 + 5) / 15);
  assert.equal(blendShares(new Map(), []), 0);
  const both = { ...span, id: 3, endpoint_id: 3, endpoint_importance: 5, channel_ids: [1, 2] };
  // פייסבוק: A ו-C (50/50); וואטסאפ: C לבד
  near(shareOf(both, [onFb], [fb, wa]), (10 * 0.5 + 5 * 1) / 15);
  const all = blendByChannel(normalizeSharesByChannel([onFb, both],
    { from: '2026-08-10', to: '2026-08-10', channelIds: [1, 2] }), new Map([[1, fb], [2, wa]]));
  near(all.get(1), (10 * 0.5) / 15);
  near(all.get(3), (10 * 0.5 + 5) / 15);
});

test('סעיף 4 — channelCapacities: קמפיין לבד בוואטסאפ מקבל את כל התקציב שם', () => {
  const fb = { id: 1, name: 'פייסבוק', max_per_week: 8, urgent_reserve_pct: 0 };
  const wa = { id: 2, name: 'וואטסאפ', max_per_week: 4, urgent_reserve_pct: 0 };
  const week = { starts_on: '2026-08-02', ends_on: '2026-08-08' };
  const b = { ...onWa, ...week };
  const caps = channelCapacities(b, [wa], [{ ...onFb, ...week }], { gapDays: 1 });
  assert.equal(caps.get(2).share, 1);
  assert.equal(caps.get(2).capacity, 4);
  // הנרמול הישן היה נותן 50% → 2
  void fb;
});

/* ========================= סעיף 5 — מרווח שנגזר מהערוץ ========================= */

import { channelEndpoints, derivedGap, gapOn, weekGapLimit } from '../src/capacity.js';

test('סעיף 5 — טבלת המרווח הנגזר: floor(7 × נקודות / תקציב), בין 1 ל-7', () => {
  // נקודה אחת × 5 בשבוע (תקציב 4 אחרי שמורה של 1) → 1
  assert.equal(derivedGap({ max_per_week: 5 }, 1), 1);
  // 3 נקודות × 4 בשבוע בלי שמורה → floor(21/4) = 5
  assert.equal(derivedGap({ max_per_week: 4, urgent_reserve_pct: 0 }, 3), 5);
  // הרבה נקודות — לא יותר מ-7; ערוץ גדול — לא פחות מ-1
  assert.equal(derivedGap({ max_per_week: 2, urgent_reserve_pct: 0 }, 10), 7);
  assert.equal(derivedGap({ max_per_week: 30, urgent_reserve_pct: 0 }, 1), 1);
  // תקציב 0 — 7; בלי מספר נקודות — 1
  assert.equal(derivedGap({ max_per_week: 0 }, 1), 7);
  assert.equal(derivedGap({ max_per_week: 7, urgent_reserve_pct: 0 }), 1);
});

test('סעיף 5 — effectiveGap: של הקמפיין גובר; הכללי הקטן גובר; בלי ערוץ — הכללי', () => {
  const ch5 = { max_per_week: 5 };
  // ברירת מחדל = min(כללי 7, נגזר 1)
  assert.equal(effectiveGap(null, { min_gap_days: 7 }, { channel: ch5, endpoints: 1 }), 1);
  // מרווח של הקמפיין גובר גם כשהנגזר קטן ממנו
  assert.equal(effectiveGap({ min_gap_days: 4 }, { min_gap_days: 7 },
    { channel: ch5, endpoints: 1 }), 4);
  // הכללי קטן מהנגזר — הכללי
  const ch4 = { max_per_week: 4, urgent_reserve_pct: 0 };
  assert.equal(effectiveGap(null, { min_gap_days: 2 }, { channel: ch4, endpoints: 3 }), 2);
  assert.equal(effectiveGap(null, { min_gap_days: 7 }, { channel: ch4, endpoints: 3 }), 5);
  // 0 בכללי = בלי מרווח, גם בערוץ
  assert.equal(effectiveGap(null, { min_gap_days: 0 }, { channel: ch5, endpoints: 1 }), 0);
  // בלי ערוץ — כמו קודם
  assert.equal(effectiveGap(null, { min_gap_days: 7 }), 7);
  assert.equal(effectiveGap(null, { min_gap_days: 7 }, {}), 7);
});

test('סעיף 5 — channelEndpoints / gapOn: קמפיינים חיים ותוכן שוטף, לפחות 1', () => {
  const live = { active: true, starts_on: '2026-08-01', ends_on: '2026-08-31' };
  const list = [
    { ...live, id: 1, endpoint_id: 1, channel_ids: [1, 2], min_gap_days: null },
    { ...live, id: 2, endpoint_id: 2, channel_ids: [1], min_gap_days: 3 },
    { ...live, id: 3, endpoint_id: 3, channel_ids: [1], paused_at: '2026-08-02' },
    { ...live, id: 4, endpoint_id: 4, channel_ids: [1], endpoint_active: false },
    { ...live, id: 5, endpoint_id: 5, channel_ids: [1], starts_on: '2026-10-01', ends_on: null },
  ];
  const standalone = new Map([[2, new Set([9])], [3, new Set([1])]]);
  const eps = channelEndpoints(list, standalone, { from: '2026-08-02', to: '2026-08-08' });
  assert.deepEqual([...eps.get(1).keys()].sort(), [1, 2]);
  assert.deepEqual(eps.get(1).get(2), [3]);
  assert.deepEqual([...eps.get(2).keys()].sort(), [1, 9]);
  const channels = new Map([[1, { id: 1, max_per_week: 5 }], [3, { id: 3, max_per_week: 5 }]]);
  assert.equal(gapOn({ channels, endpoints: eps }, 1).endpoints, 2);
  assert.equal(gapOn({ channels, endpoints: eps }, 3).endpoints, 1);
  // ערוץ לא ידוע / בלי הקשר — {} (הכללי)
  assert.deepEqual(gapOn({ channels, endpoints: eps }, 7), {});
  assert.deepEqual(gapOn(null, 1), {});
});

test('סעיף 5 — weekGapLimit: מרווח של קמפיין שמגביל את הערוץ מתחת למספר שלו', () => {
  const ch = { max_per_week: 5 };   // תקציב 4
  const week = { from: '2026-08-02', to: '2026-08-08' };
  // נקודה אחת, ברירת המחדל (נגזר 1) — 7 ימים, לא מגביל
  assert.equal(weekGapLimit({ ...week, channel: ch, endpoints: new Map([[1, [null]]]),
                              settings: { min_gap_days: 7 } }), 7);
  // נקודה אחת בקמפיין עם מרווח 7 — פוסט אחד בשבוע: מגביל (1 < 4)
  assert.equal(weekGapLimit({ ...week, channel: ch, endpoints: new Map([[1, [7]]]),
                              settings: { min_gap_days: 7 } }), 1);
  // אותה נקודה עם תוכן שוטף — המרווח המקל שלה
  assert.equal(weekGapLimit({ ...week, channel: ch, endpoints: new Map([[1, [7, null]]]),
                              settings: { min_gap_days: 7 } }), 7);
  assert.equal(weekGapLimit({ ...week, channel: ch, endpoints: new Map(), settings: null }), null);
});

/* ========================= סעיף 6 — מכירתי בתוך הקיבולת ========================= */

import { kindMix } from '../src/campaigns.js';
import { ratioAllowsPromo, ratioPromoCap, windowRatio } from '../src/capacity.js';

const RULES = { min_value_per_promo: 3, max_promo_per_day: 1, hybrid_weight: 0.5 };

test('סעיף 6 — יחס על 28 יום: ערוץ של 3 בשבוע ביחס 3 → מכירתי אחד לכל 4 פוסטים', () => {
  // תקציב 3 → 12 פוסטים ב-28 יום → 3 מכירתיים (קודם: floor(3 / 4) = 0 בכל שבוע)
  assert.equal(ratioPromoCap(3, 28, 3), 3);
  assert.equal(ratioPromoCap(3, 7, 3), 3);        // טווח קצר נמדד כחלון שלם
  assert.equal(ratioPromoCap(3, 56, 3), 6);
  assert.equal(ratioPromoCap(3, 28, 0), Infinity); // השער כבוי
  // ערוץ קטן מהיחס: פוסט אחד בשבוע ביחס 5 → היחס בפועל 3 (4 בחלון) ולא חסימה לתמיד
  assert.equal(windowRatio(5, 1), 3);
  assert.equal(ratioPromoCap(1, 28, 5), 1);
  assert.equal(windowRatio(3, 4), 3);
  // השער: ערך ≥ יחס × (מכירתי + 1)
  assert.equal(ratioAllowsPromo({ value: 3, promo: 0 }, 3, 3), true);
  assert.equal(ratioAllowsPromo({ value: 5, promo: 1 }, 3, 3), false);
  assert.equal(ratioAllowsPromo({ value: 0, promo: 0 }, 0, 3), true);
});

test('סעיף 6 — קיבולת לפי סוג: קמפיין מכירתי בערוץ של 3 מקבל רק את מה שהיחס מאפשר', () => {
  const ch = { max_per_week: 3, urgent_reserve_pct: 0 };
  const base = { from: '2026-11-01', to: '2026-12-26', channel: ch, share: 1, gapDays: 1,
                 settings: RULES };
  // בלי לדעת מה התוכן — כמו קודם
  assert.equal(channelCapacity(base).capacity, 24);
  const promo = channelCapacity({ ...base, mix: { promo: 5 } });
  assert.equal(promo.capacity, 6);                 // 24 / 4
  assert.equal(promo.limitedBy, 'ratio');
  assert.deepEqual(promo.kinds, { promo: 6, hybrid: 0, value: 0 });
  // חצי ערך: 12 ערך + 6 מכירתי (התקרה) = 18
  const half = channelCapacity({ ...base, mix: { promo: 2, value: 2 } });
  assert.equal(half.capacity, 18);
  // ערך בלבד — בלי מגבלה
  assert.equal(channelCapacity({ ...base, mix: { value: 3 } }).capacity, 24);
  // יחס כבוי — הכול נכנס
  assert.equal(channelCapacity({ ...base, mix: { promo: 1 },
    settings: { ...RULES, min_value_per_promo: 0 } }).capacity, 24);
});

test('סעיף 6 — תקרת מכירתיים לשבוע בערוץ', () => {
  const ch = { max_per_week: 7, urgent_reserve_pct: 0, max_promo_per_week: 1 };
  // 1.11 (ראשון) עד 28.11 — 4 שבועות בלוח
  const r = channelCapacity({ from: '2026-11-01', to: '2026-11-28', channel: ch, share: 1,
    gapDays: 1, mix: { promo: 1 }, settings: { ...RULES, min_value_per_promo: 0 } });
  assert.equal(r.capacity, 4);
  assert.equal(r.limitedBy, 'promo_week');
  assert.equal(r.kindLimits.promo_week, 4);
  // מכירתי ליום בערוץ אחד לא מגביל מעבר למרווח (פוסט אחד ליום לנקודה ממילא) —
  // הוא חוצה ערוצים (הבדיקה הבאה)
  assert.equal(r.kindLimits.promo_day, 28);
});

test('סעיף 6 — channelCapacities: מכירתי ליום מתחלק בין הערוצים של הקמפיין', () => {
  const a = { id: 1, name: 'א', max_per_week: 7, urgent_reserve_pct: 0 };
  const b = { id: 2, name: 'ב', max_per_week: 7, urgent_reserve_pct: 0 };
  const camp = { id: 5, endpoint_id: 1, active: true, endpoint_importance: 5, min_gap_days: 1,
                 starts_on: '2026-11-01', ends_on: '2026-11-07' };
  const mix = new Map([[1, { promo: 3 }], [2, { promo: 3 }]]);
  const caps = channelCapacities(camp, [a, b], [],
    { gapDays: 1, settings: { ...RULES, min_value_per_promo: 0 }, mix });
  // 7 ימים × מכירתי אחד ליום — 7 בשני הערוצים יחד, לא 7 בכל אחד
  assert.ok(caps.get(1).capacity + caps.get(2).capacity <= 7,
    `${caps.get(1).capacity} + ${caps.get(2).capacity}`);
  assert.equal(caps.get(1).limitedBy, 'promo_day');
});

test('סעיף 6 — kindMix: לפי הגרסאות בכל ערוץ, ובלי תוכן — null', () => {
  const items = [
    { kind: 'promo', variants: [{ channel_id: 1, status: 'ready' }, { channel_id: 2, status: 'not_relevant' }] },
    { kind: 'value', variants: [{ channel_id: 2, status: 'draft' }] },
    { kind: 'promo', slot_channel_id: 3, variants: [] },
  ];
  const m = kindMix(items, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.deepEqual(m.get(1), { promo: 1, value: 0, hybrid: 0 });
  assert.deepEqual(m.get(2), { promo: 0, value: 1, hybrid: 0 });
  assert.deepEqual(m.get(3), { promo: 1, value: 0, hybrid: 0 });
  // ערוץ בלי אף פריט — כל התוכן של הקמפיין
  assert.deepEqual(m.get(4), { promo: 2, value: 1, hybrid: 0 });
  assert.equal(kindMix([], [{ id: 1 }]), null);
});

test('סעיף 6 — כשגם בלי המרווח המכירתיים לא נותנים יותר, הם המגביל (לא "לדחוס")', () => {
  // בלאק פריידי 20.11–5.12 (3 שבועות בלוח), עד מכירתי אחד בשבוע: במרווח 7 נכנסים
  // 3, ודחיסה לא תוסיף — הקצב מבקש 4 אבל התקרה 3
  const r = channelCapacity({ from: '2026-11-20', to: '2026-12-05',
    channel: { max_per_week: 5, urgent_reserve_pct: 20, max_promo_per_week: 1 }, share: 0.4,
    gapDays: 7, mix: { promo: 1 }, settings: RULES });
  assert.equal(r.capacity, 3);
  assert.equal(r.limitedBy, 'promo_week');
  assert.equal(gapToFit({ from: '2026-11-20', to: '2026-12-05',
    channel: { max_per_week: 5, urgent_reserve_pct: 20, max_promo_per_week: 1 }, share: 0.4,
    mix: { promo: 1 }, settings: RULES }, 4), null);
});

test('R2 — משולב לא נחתך ביחס (כמו במנוע), רק בתקרה השבועית שלו', () => {
  const base = { from: '2026-11-01', to: '2026-11-28', share: 1, gapDays: 1, settings: RULES };
  // ערוץ של 3, 4 שבועות, הכול משולב: 12 נכנסים — קודם נחתך ל-6 (12 / 4 ÷ 0.5)
  const hybrid = channelCapacity({ ...base, channel: { max_per_week: 3, urgent_reserve_pct: 0 },
                                   mix: { hybrid: 4 } });
  assert.equal(hybrid.capacity, 12);
  // עם תקרה שבועית למשולבים — היא כן חלה
  const capped = channelCapacity({ ...base, mix: { hybrid: 4 },
    channel: { max_per_week: 3, urgent_reserve_pct: 0, max_hybrid_per_week: 1 } });
  assert.equal(capped.capacity, 4);
  assert.equal(capped.limitedBy, 'hybrid_week');
  // משולב תופס חלק ממקום המכירתי: חצי משולב חצי מכירתי — המכירתי נחתך, המשולב לא
  const mixed = channelCapacity({ ...base, channel: { max_per_week: 3, urgent_reserve_pct: 0 },
                                  mix: { hybrid: 1, promo: 1 } });
  assert.equal(mixed.kinds.hybrid, 6);
  assert.equal(mixed.kinds.promo, 0);   // 3 (תקרה) − 6 × 0.5
});

test('R3 — קמפיין מכירתי קצר: רבע מהתקרה של 28 יום בכל שבוע, כמו המילוי המרוסן', async () => {
  const { ratioPromoLimit, weeklyPromoCap } = await import('../src/capacity.js');
  // ערוץ של 7 (בלי שמורה), יחס 3: 7 ב-28 יום, עד 2 בשבוע
  assert.equal(weeklyPromoCap(7, 3), 2);
  assert.equal(ratioPromoLimit(7, 7, 1, 3), 2);
  assert.equal(ratioPromoLimit(7, 28, 4, 3), 7);
  assert.equal(ratioPromoLimit(7, 7, 1, 0), Infinity);
  const week = channelCapacity({ from: '2026-11-01', to: '2026-11-07', share: 1, gapDays: 1,
    channel: { max_per_week: 7, urgent_reserve_pct: 0 }, mix: { promo: 5 },
    settings: { ...RULES, max_promo_per_day: 5 } });
  assert.equal(week.capacity, 2);   // קודם 7 — כל התקרה של 28 יום בשבוע אחד
  assert.equal(week.limitedBy, 'ratio');
});
