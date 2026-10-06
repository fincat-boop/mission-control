import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleCount, channelCapacities, channelNeeds } from '../src/campaigns.js';
import { shareOf } from '../src/capacity.js';

const span = { starts_on: '2026-08-01', ends_on: '2026-08-31', active: true };

test('shareOf (לשעבר effectiveShare) — share_pct מפורש מנצח את המשקל', () => {
  assert.equal(shareOf({ ...span, share_pct: 25, importance: 9 }, []), 0.25);
});

test('shareOf (לשעבר effectiveShare) — נגזר מחשיבות נקודת הקצה מול הקמפיינים החופפים', () => {
  const a = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 6 };
  const b = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 3 };
  assert.equal(shareOf(a, [a, b]), 6 / 9);
});

test('shareOf (לשעבר effectiveShare) — החשיבות של הקמפיין עצמו לא נספרת; אותה נקודה = חלוקה שווה', () => {
  const a = { ...span, id: 1, endpoint_id: 1, importance: 9, endpoint_importance: 5 };
  const b = { ...span, id: 2, endpoint_id: 1, importance: 1, endpoint_importance: 5 };
  assert.equal(shareOf(a, [a, b]), 0.5);
});

test('shareOf (לשעבר effectiveShare) — הקמפיין בלי endpoint_importance נלקח מהרשימה לפי מזהה', () => {
  const listed = { ...span, id: 1, endpoint_id: 1, endpoint_importance: 8 };
  const other = { ...span, id: 2, endpoint_id: 2, endpoint_importance: 2 };
  assert.equal(shareOf({ ...span, id: 1, endpoint_id: 1 }, [listed, other]), 0.8);
});

test('shareOf (לשעבר effectiveShare) — בלי חופפים מחזיר 1', () => {
  assert.equal(shareOf({ ...span, endpoint_importance: 6 }, []), 1);
});

test('shareOf (לשעבר effectiveShare) — חופף לא פעיל לא נספר', () => {
  const a = { ...span, id: 1, endpoint_importance: 5 };
  const inactive = { ...span, id: 2, endpoint_importance: 5, active: false };
  assert.equal(shareOf(a, [a, inactive]), 1); // רק a נספר: 5/5
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

test('channelNeeds — קצב × שבועות × נתח כשהמרווח לא מגביל (מרווח 1)', () => {
  const camp = { starts_on: '2026-08-01', ends_on: '2026-08-07', active: true, importance: 5 };
  const needs = channelNeeds(camp, [{ id: 1, max_per_week: 3 }], [camp], { gapDays: 1 });
  assert.equal(needs.get(1), 3); // שבוע אחד, נתח 1, קצב 3 (השמורה: floor(0.6) = 0)
});

test('channelNeeds — מרווח 7 (ברירת המחדל של המנוע): פוסט אחד בשבוע לערוץ', () => {
  const camp = { starts_on: '2026-08-01', ends_on: '2026-08-07', active: true, importance: 5 };
  const needs = channelNeeds(camp, [{ id: 1, max_per_week: 3 }], [camp]);
  assert.equal(needs.get(1), 1);
  const d = channelCapacities(camp, [{ id: 1, max_per_week: 3 }], [camp], { gapDays: 7 }).get(1);
  assert.equal(d.wanted, 3);
  assert.equal(d.capacity, 1);
  assert.equal(d.limitedBy, 'gap');
  assert.equal(d.share, 1);
});

test('channelNeeds — בלאק פריידי: 16 יום, 5 בשבוע, 40% — הרשת לא דורשת יותר ממה שנכנס', () => {
  const bf = { id: 7, endpoint_id: 4, share_pct: 40, active: true,
               starts_on: '2026-11-20', ends_on: '2026-12-05' };
  const fb = { id: 6, max_per_week: 5, urgent_reserve_pct: 20 };
  const d = channelCapacities(bf, [fb], [bf], { gapDays: 7 }).get(6);
  assert.equal(d.wanted, 5);     // החשבון הישן: round(5 × 16/7 × 0.4)
  assert.equal(d.rateCap, 4);    // round(4 × 16/7 × 0.4)
  assert.equal(d.gapCap, 3);     // 20.11, 27.11, 4.12
  assert.equal(d.capacity, 3);
  assert.equal(d.limitedBy, 'gap');
});

test('channelNeeds — בלי תאריכים מחזיר מפה ריקה', () => {
  assert.equal(channelNeeds({ active: true }, [{ id: 1, max_per_week: 3 }], []).size, 0);
});

/* ========================= קמפיין כללי ========================= */

import { generalGridFor, gridFor, resolvePeriod, structureChangeError } from '../src/campaigns.js';

// שבועיים, שני ערוצים: 3 ו-1 בשבוע → צורך 6 ו-2 כשהמרווח לא מגביל (GAP1),
// ו-2 ו-2 במרווח 7 של המנוע (פוסט אחד בשבוע לנקודה × ערוץ)
const twoWeeks = {
  starts_on: '2026-11-01', ends_on: '2026-11-14', active: true, importance: 5, structure: 'general',
};
const chA = { id: 1, name: 'פייסבוק', max_per_week: 3 };
const chB = { id: 2, name: 'ניוזלטר', max_per_week: 1 };
const GAP1 = { gapDays: 1 };
const slotItem = (id, channel, order, status) => ({
  id, slot_channel_id: channel, sort_order: order,
  variants: status ? [{ id: id * 10, channel_id: channel, status, body: 'x' }] : [],
});

test('generalGridFor — משבצות לכל מדיה לפי הצורך שלה, בלי זוויות', () => {
  const g = generalGridFor(twoWeeks, [], [chA, chB], '2026-10-01', [twoWeeks], GAP1);
  assert.deepEqual(g.needs, { 1: 6, 2: 2 });
  assert.equal(g.channels.length, 2);
  assert.equal(g.channels[0].slots.length, 6);
  assert.equal(g.channels[1].slots.length, 2);
  assert.equal(g.total_cells, 8);
  assert.equal(g.missing, 8);
  assert.equal(g.ready, 0);
  // פרוס על חלון הקמפיין: הראשונה ביום הראשון, האחרונה מקטע אחד לפני הסוף
  assert.equal(g.channels[0].slots[0].date, '2026-11-01');
  assert.equal(g.channels[0].slots[5].date, '2026-11-12');   // floor(5 × 14 / 6) = 11
  assert.equal(g.channels[1].slots[1].date, '2026-11-08');   // floor(1 × 14 / 2) = 7
});

test('generalGridFor — נדרש = סכום הצרכים, מוכן = גרסה מוכנה, חסר = נדרש − מוכן', () => {
  const content = [
    slotItem(1, 1, 1, 'ready'),
    slotItem(2, 1, 2, 'draft'),
    slotItem(3, 2, 1, 'ready'),
  ];
  const g = generalGridFor(twoWeeks, content, [chA, chB], '2026-10-01', [twoWeeks], GAP1);
  assert.equal(g.total_cells, 8);
  assert.equal(g.ready, 2);
  assert.equal(g.missing, 6);          // טיוטה עדיין חסרה — כמו בזוויות
  assert.equal(g.drafts, 1);
  assert.equal(g.channels[0].slots[1].state, 'draft');
  assert.equal(g.channels[1].slots[0].state, 'ready');
  assert.equal(g.channels[1].slots[1].state, 'empty');
});

test('generalGridFor — מרווח 7: הצורך = מה שהמנוע יכול לשבץ, לא הקצב', () => {
  const g = generalGridFor(twoWeeks, [], [chA, chB], '2026-10-01', [twoWeeks]);
  assert.deepEqual(g.needs, { 1: 2, 2: 2 });
  assert.equal(g.total_cells, 4);
  assert.deepEqual(g.channels[0].slots.map((s) => s.date), ['2026-11-01', '2026-11-08']);
});

test('generalGridFor — תוכן של מדיה אחת לא ממלא משבצת של מדיה אחרת', () => {
  const g = generalGridFor(twoWeeks, [slotItem(1, 1, 1, 'ready')], [chA, chB], '2026-10-01', [twoWeeks]);
  assert.equal(g.channels[0].slots[0].state, 'ready');
  assert.equal(g.channels[1].slots[0].state, 'empty');
});

test('generalGridFor — עודף מעבר לצורך מוצג ולא נספר', () => {
  const content = [slotItem(1, 2, 1, 'ready'), slotItem(2, 2, 2, 'ready'), slotItem(3, 2, 3, 'ready')];
  const g = generalGridFor(twoWeeks, content, [chB], '2026-10-01', [twoWeeks]);
  const slots = g.channels[0].slots;
  assert.equal(slots.length, 3);
  assert.equal(slots[2].extra, true);
  assert.equal(slots[2].date, null);
  assert.equal(g.total_cells, 2);
  assert.equal(g.ready, 2);
  assert.equal(g.missing, 0);
});

test('generalGridFor — בלי תאריכים אין משבצות', () => {
  const g = generalGridFor({ active: true, structure: 'general' }, [], [chA], '2026-10-01', []);
  assert.equal(g.channels.length, 0);
  assert.equal(g.total_cells, 0);
});

test('gridFor — קמפיין לפי זוויות לא השתנה: אותו חישוב תאים', () => {
  const camp = { ...twoWeeks, structure: 'angles' };
  const angle = { id: 1, sort_order: 1, variants: [
    { id: 1, channel_id: 1, status: 'ready' }, { id: 2, channel_id: 2, status: 'draft' }] };
  const g = gridFor(camp, [angle], [chA, chB], '2026-10-01', [camp], GAP1);
  assert.equal(g.angles.length, 6);   // לפי המדיה התובענית
  assert.equal(g.total_cells, 8);     // 6 + 2, השאר not_needed
  assert.equal(g.ready, 1);
  assert.equal(g.missing, 7);         // בזוויות טיוטה נספרת כחסר, כמו קודם
});

test('structureChangeError — מותר רק כל עוד אין תוכן', () => {
  assert.equal(structureChangeError('angles', 'general', 0), null);
  assert.equal(structureChangeError('general', 'angles', 0), null);
  assert.match(structureChangeError('angles', 'general', 3), /אחרי שכבר נוסף/);
  assert.equal(structureChangeError('angles', 'angles', 3), null);   // לא שינוי
  assert.equal(structureChangeError('angles', undefined, 3), null);  // לא נשלח
  assert.match(structureChangeError('angles', 'grid', 0), /לא מוכר/);
});

test('resolvePeriod — תקופה נשלחה: הסיום נגזר בשרת', () => {
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-12', period: '1m' }),
    { period: '1m', ends_on: '2026-12-11' });
  assert.deepEqual(resolvePeriod({ starts_on: '2026-01-31', period: '1m' }),
    { period: '1m', ends_on: '2026-02-28' });
  // ends_on שנשלח לצד תקופה קבועה לא גובר עליה
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-01', period: '2w', ends_on: '2027-01-01' }),
    { period: '2w', ends_on: '2026-11-14' });
});

test('resolvePeriod — תאריך ידני, ושגיאות', () => {
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-01', period: 'custom', ends_on: '2026-11-10' }),
    { period: 'custom', ends_on: '2026-11-10' });
  assert.ok(resolvePeriod({ starts_on: '2026-11-01', period: 'custom' }).error);
  assert.ok(resolvePeriod({ period: '1m' }).error);
  assert.ok(resolvePeriod({ starts_on: '2026-11-01', period: 'q' }).error);
});

test('resolvePeriod — עדכון: הזזת תאריך היעד גוררת את הסיום לפי התקופה השמורה', () => {
  const before = { starts_on: '2026-11-01', ends_on: '2026-11-30', period: '1m' };
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-15' }, before),
    { period: '1m', ends_on: '2026-12-14' });
  // תקופה ידנית — הסיום לא זז
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-05' },
    { ...before, period: 'custom' }), {});
  // שינוי שלא נוגע בתאריכים
  assert.deepEqual(resolvePeriod({ name: 'x' }, before), {});
});

test('resolvePeriod — תאריכים בלי תקופה (ציר האסטרטגיה): נשמרים, התקופה מוסקת', () => {
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-16', ends_on: '2026-12-15' },
    { period: '1m' }), { period: '1m', ends_on: '2026-12-15' });
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-16', ends_on: '2026-12-20' }),
    { period: '5w', ends_on: '2026-12-20' });
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-16', ends_on: '2026-12-21' }),
    { period: 'custom', ends_on: '2026-12-21' });
});

import { nextSlots } from '../src/campaigns.js';

test('nextSlots — ממלא משבצות פנויות לפי הסדר, ואז גולש אחרי האחרונה', () => {
  assert.deepEqual(nextSlots(4, [], 2), [1, 2]);
  assert.deepEqual(nextSlots(4, [1, 3], 3), [2, 4, 5]);
  assert.deepEqual(nextSlots(2, [1, 2], 2), [3, 4]);
  // עודף קיים מעבר לצורך — ממשיכים אחריו ולא דורסים
  assert.deepEqual(nextSlots(2, [1, 5], 2), [2, 6]);
  // בלי צורך (אין תאריכים) — הכול בסוף התור
  assert.deepEqual(nextSlots(null, [1, 2], 2), [3, 4]);
});

test('nextSlots — אף פעם לא מחזיר משבצת תפוסה או כפולה', () => {
  const taken = [2, 3, 7];
  const out = nextSlots(6, taken, 8);
  assert.equal(new Set(out).size, out.length);
  assert.ok(out.every((s) => !taken.includes(s)));
});

test('resolvePeriod — open: סוף ריק, רק בקמפיין לפי זוויות', () => {
  const legacy = { starts_on: '2026-11-01', ends_on: null, period: null, structure: 'angles' };
  assert.deepEqual(resolvePeriod({ starts_on: '2026-11-01', period: 'open' }, legacy),
    { period: 'open', ends_on: null });
  assert.ok(resolvePeriod({ starts_on: '2026-11-01', period: 'open' },
    { ...legacy, structure: 'general' }).error);
  assert.ok(resolvePeriod({ starts_on: '2026-11-01', period: 'open', structure: 'general' }).error);
});

test('generalGridFor — קמפיין שכולו טיוטות לא "מלא"; לא רלוונטי יוצא מהנדרש', () => {
  const drafts = [slotItem(1, 2, 1, 'draft'), slotItem(2, 2, 2, 'draft')];
  const g = generalGridFor(twoWeeks, drafts, [chB], '2026-10-01', [twoWeeks]);
  assert.equal(g.total_cells, 2);
  assert.equal(g.ready, 0);
  assert.equal(g.missing, 2);
  assert.equal(g.drafts, 2);

  const na = [slotItem(1, 2, 1, 'not_relevant'), slotItem(2, 2, 2, 'ready')];
  const h = generalGridFor(twoWeeks, na, [chB], '2026-10-01', [twoWeeks]);
  assert.equal(h.total_cells, 1);
  assert.equal(h.ready, 1);
  assert.equal(h.missing, 0);
  assert.equal(h.channels[0].required, 1);
});

test('gridFor — טיוטות נספרות לתצוגה, וגם בתוך החסר', () => {
  const camp = { ...twoWeeks, structure: 'angles' };
  const angle = { id: 1, sort_order: 1, variants: [
    { id: 1, channel_id: 1, status: 'ready' }, { id: 2, channel_id: 2, status: 'draft' }] };
  const g = gridFor(camp, [angle], [chA, chB], '2026-10-01', [camp]);
  assert.equal(g.drafts, 1);
  assert.equal(g.missing, g.total_cells - g.ready);
});

/* ========================= קמפיין מוכן ========================= */

import { isCompleteMode, statusOf } from '../src/campaigns.js';
import { campaignContentAlert } from '../src/alerts.js';

// חודש (30 יום), צורך לפי קצב: 3 בשבוע → 13, 1 בשבוע → 4
const month = {
  starts_on: '2026-11-01', ends_on: '2026-11-30', active: true, importance: 5,
  structure: 'general',
};
const done = { ...month, content_complete_at: '2026-10-05T10:00:00Z' };

test('generalGridFor מוכן — רק המשבצות שמולאו, בלי ריקות, וטיוטות נשארות לא מוכנות', () => {
  // ערוץ A: משבצות 1, 4, 9 (עם חורים); ערוץ B: משבצת 2 בטיוטה
  const content = [
    slotItem(1, 1, 1, 'ready'), slotItem(2, 1, 4, 'ready'), slotItem(3, 1, 9, 'draft'),
    slotItem(4, 2, 2, 'draft'),
  ];
  const before = generalGridFor(month, content, [chA, chB], '2026-10-01', [month]);
  assert.ok(before.total_cells > 4);

  const g = generalGridFor(done, content, [chA, chB], '2026-10-01', [done]);
  assert.equal(g.complete, true);
  assert.deepEqual(g.needs, { 1: 3, 2: 1 });
  assert.equal(g.channels[0].slots.length, 3);
  assert.equal(g.channels[1].slots.length, 1);
  assert.ok(g.channels.every((c) => c.slots.every((s) => s.state !== 'empty' && !s.extra)));
  assert.equal(g.total_cells, 4);
  assert.equal(g.ready, 2);
  assert.equal(g.drafts, 2);
  assert.equal(g.missing, 2);                   // חסר = נדרש − מוכן = הטיוטות
  // index נשאר sort_order (הלחיצה בממשק), התאריך לפי המקום ברשימה
  assert.deepEqual(g.channels[0].slots.map((s) => s.index), [1, 4, 9]);
  assert.deepEqual(g.channels[0].slots.map((s) => s.date),
    ['2026-11-01', '2026-11-11', '2026-11-21']);
  assert.equal(g.channels[1].slots[0].date, '2026-11-01'); // פריט יחיד — יום ההתחלה
});

test('generalGridFor מוכן — 6 פוסטים בחודש: כל 5 ימים, האחרון לא ביום האחרון', () => {
  const content = [1, 2, 3, 4, 5, 6].map((i) => slotItem(i, 1, i, 'ready'));
  const g = generalGridFor(done, content, [chA], '2026-10-01', [done]);
  assert.deepEqual(g.channels[0].slots.map((s) => s.date), [
    '2026-11-01', '2026-11-06', '2026-11-11', '2026-11-16', '2026-11-21', '2026-11-26']);
});

test('gridFor מוכן — זוויות שנכתבו בלבד; מדיה בלי גרסה לא מקבלת את הזווית', () => {
  const camp = { ...done, structure: 'angles' };
  const angles = [
    { id: 1, sort_order: 2, variants: [
      { id: 1, channel_id: 1, status: 'ready' }, { id: 2, channel_id: 2, status: 'draft' }] },
    { id: 2, sort_order: 5, variants: [{ id: 3, channel_id: 1, status: 'ready' }] },
    { id: 3, sort_order: 7, variants: [
      { id: 4, channel_id: 1, status: 'draft' }, { id: 5, channel_id: 2, status: 'not_relevant' }] },
  ];
  const g = gridFor(camp, angles, [chA, chB], '2026-10-01', [camp]);
  assert.equal(g.complete, true);
  assert.equal(g.angles.length, 3);
  assert.deepEqual(g.angles.map((r) => r.index), [2, 5, 7]);
  assert.deepEqual(g.angles.map((r) => r.date), ['2026-11-01', '2026-11-11', '2026-11-21']);
  assert.deepEqual(g.needs, { 1: 3, 2: 1 });
  assert.equal(g.angles[1].cells[1].state, 'not_needed');
  assert.equal(g.angles[2].cells[1].state, 'not_relevant');
  assert.equal(g.total_cells, 4);
  assert.equal(g.ready, 2);
  assert.equal(g.drafts, 2);
  assert.equal(g.missing, 2);
  assert.ok(g.angles.every((r) => r.cells.every((c) => c.state !== 'empty')));
});

test('isCompleteMode — רק עם סימון, תאריכים ותוכן; פתיחה מחדש מחזירה את המשבצות', () => {
  const one = [slotItem(1, 1, 1, 'ready')];
  assert.equal(isCompleteMode(done, one), true);
  assert.equal(isCompleteMode(done, []), false);
  assert.equal(isCompleteMode({ ...done, ends_on: null }, one), false);
  assert.equal(isCompleteMode(month, one), false);
  // reopen = content_complete_at חוזר ל-null → הקצאה רגילה לפי קצב
  const reopened = generalGridFor({ ...done, content_complete_at: null }, one, [chA], '2026-10-01');
  assert.equal(reopened.complete, undefined);
  assert.ok(reopened.channels[0].slots.length > 1);
  assert.equal(reopened.channels[0].slots[1].state, 'empty');
});

test('תוכן שנוסף אחרי הסימון מגדיל את הספירה', () => {
  const content = [slotItem(1, 1, 1, 'ready'), slotItem(2, 1, 2, 'ready')];
  const a = generalGridFor(done, content, [chA], '2026-10-01');
  const b = generalGridFor(done, [...content, slotItem(3, 1, 3, 'draft')], [chA], '2026-10-01');
  assert.equal(a.total_cells, 2);
  assert.equal(b.total_cells, 3);
  assert.equal(b.channels[0].slots[2].date, '2026-11-21');
});

test('statusOf — קמפיין מוכן עם טיוטות לא "חסר": "מוכן · X טיוטות לסיום"', () => {
  const myChannels = [chA];
  const today = '2026-11-05';
  for (const structure of ['general', 'angles']) {
    const c = { ...done, structure };
    const st = statusOf({ c, today, myChannels,
      grid: { complete: true, missing: 2, drafts: 2, ready: 3, total_cells: 5 } });
    assert.equal(st.key, 'complete_drafts');
    assert.equal(st.label, 'מוכן · 2 טיוטות לסיום');
    assert.doesNotMatch(st.label, /חסר/);
    const one = statusOf({ c, today, myChannels,
      grid: { complete: true, missing: 1, drafts: 1, ready: 3, total_cells: 4 } });
    assert.equal(one.label, 'מוכן · טיוטה אחת לסיום');
    const full = statusOf({ c, today, myChannels,
      grid: { complete: true, missing: 0, drafts: 0, ready: 4, total_cells: 4 } });
    assert.equal(full.key, 'complete');
    assert.equal(full.tone, 'good');
  }
  // קמפיין רגיל — בלי שינוי
  const normal = statusOf({ c: month, today, myChannels,
    grid: { missing: 2, drafts: 0, ready: 3, total_cells: 5 } });
  assert.equal(normal.key, 'missing_content');
});

test('התראת תוכן — בקמפיין מוכן "טיוטות לסיום" ולא "חסר תוכן"', () => {
  const base = { id: 4, name: 'סתיו', phase: 'running', missing_content: 2, required: 6 };
  const complete = campaignContentAlert({ ...base, complete: true }, 0);
  assert.match(complete.title, /^טיוטות לסיום/);
  assert.doesNotMatch(complete.title + complete.detail, /חסר/);
  assert.match(complete.detail, /2 פוסטים עדיין בטיוטה/);
  const normal = campaignContentAlert({ ...base, complete: false }, 0);
  assert.match(normal.title, /^חסר תוכן/);
  assert.equal(normal.level, 'crit');
});

import { completionSummary } from '../src/campaigns.js';

test('completionSummary — כמה משבצות ריקות יורדות, כמה נשארות לכל מדיה, כמה טיוטות', () => {
  const content = [
    slotItem(1, 1, 1, 'ready'), slotItem(2, 1, 4, 'draft'), slotItem(3, 2, 1, 'ready'),
  ];
  // כמו שורה של campaignsWithHealth לפני הסימון
  const g = generalGridFor(month, content, [chA, chB], '2026-10-01', [month]);
  const row = { ...month, id: 9, content, channels: [chA, chB], complete: false,
                missing_content: g.missing, drafts: g.drafts };
  const s = completionSummary(row, '2026-10-01');
  assert.equal(s.removed_empty, g.total_cells - 3);  // כל מה שלא נכתב
  assert.deepEqual(s.kept_by_channel, { 1: 2, 2: 1 });
  assert.equal(s.posts, 3);
  assert.equal(s.drafts, 1);
  assert.equal(s.ready, 2);
  assert.equal(s.starts_on, '2026-11-01');
  assert.equal(s.ends_on, '2026-11-30');
});

test('completionSummary — מסרב בלי תאריכים או בלי תוכן', () => {
  const base = { ...month, content: [slotItem(1, 1, 1, 'ready')], channels: [chA],
                 missing_content: 0, drafts: 0 };
  assert.match(completionSummary({ ...base, ends_on: null }).error, /אין תאריכים/);
  assert.match(completionSummary({ ...base, content: [] }).error, /אין בקמפיין תוכן/);
  // תוכן רק במדיה שהוסרה מהקמפיין — אין מה לפרוס
  assert.ok(completionSummary({ ...base, content: [slotItem(1, 2, 1, 'ready')] }).error);
});

import { readFileSync } from 'node:fs';

test('שכפול — העותק מתחיל לא "מוכן": insertCampaign לא מעתיק content_complete_at', () => {
  const src = readFileSync(new URL('../src/routes/campaigns.js', import.meta.url), 'utf8');
  const insert = src.slice(src.indexOf('async function insertCampaign'),
    src.indexOf("r.post('/campaigns',"));
  assert.match(insert, /insert into campaigns/);
  assert.doesNotMatch(insert, /content_complete_at/);
  // השכפול עובר דרך copyCampaign, שיוצר את הקמפיין דרכו — ומסמן "מוכן"
  // רק כשמבקשים במפורש (הרצה של קמפיין מחזורי), לא בשכפול רגיל
  const copy = src.slice(src.indexOf('async function copyCampaign'));
  assert.match(copy.slice(0, copy.indexOf('\n}\n')), /insertCampaign\(b\)/);
  const dup = src.slice(src.indexOf("r.post('/campaigns/:id/duplicate'"));
  assert.match(dup.slice(0, dup.indexOf('}));')), /copyCampaign\(src, b\);/);
});

/* ---------- גל 4: כל זווית נראית, ומקומות לא מתנגשים ---------- */

test('gridFor — זווית מעבר לתכנון ושתיים באותו מקום חוזרות ב-extra, לא נעלמות', () => {
  const camp = { ...twoWeeks, structure: 'angles', target_posts: 2 };
  const a = (id, order) => ({ id, sort_order: order, variants: [
    { id: id * 10, channel_id: 1, status: 'ready' }] });
  const g = gridFor(camp, [a(1, 1), a(2, 1), a(3, 2), a(4, 5)], [chA, chB], '2026-10-01', [camp]);
  assert.equal(g.angles.length, 2);
  // המקום הראשון הולך לזווית הראשונה לפי הסדר (ואז לפי id)
  assert.equal(g.angles[0].content.id, 1);
  assert.deepEqual(g.extra.map((x) => x.content.id), [2, 4]);
  assert.equal(g.extra[0].extra, true);
  // תא בלי גרסה מעבר לתכנון — לא נדרש; לא נספר בנדרש
  assert.equal(g.extra[0].cells.find((x) => x.channel_id === 2).state, 'not_needed');
  assert.equal(g.total_cells, 4);
});

test('gridFor — קמפיין בלי תאריכים: כל הזוויות ב-extra', () => {
  const g = gridFor({ active: true, structure: 'angles' },
    [{ id: 1, sort_order: 1, variants: [] }], [chA], '2026-10-01', []);
  assert.equal(g.angles.length, 0);
  assert.equal(g.extra.length, 1);
});

test('nextSlots — מקומות כפולים או מחוץ לטווח לא מבלבלים את הספירה', () => {
  // שתי זוויות ב-2 ואחת ב-9 (מעבר לתכנון של 4): פנויים 1, 3, 4 ואז אחרי 9
  assert.deepEqual(nextSlots(4, [2, 2, 9], 4), [1, 3, 4, 10]);
  // זווית שעוברת לקמפיין מלא מקבלת את המקום שאחרי האחרון
  assert.deepEqual(nextSlots(3, [1, 2, 3], 1), [4]);
  // מקום 0 (תוכן שוטף שהוכנס לקמפיין) לא נחשב תפוס ולא נבחר
  assert.deepEqual(nextSlots(2, [0], 2), [1, 2]);
});

/* ---------- גל 4: מה חסר מהיום והלאה ---------- */

import { missingAhead } from '../src/campaigns.js';

test('missingAhead — שורות שעברו ומשבצות בלי תאריך לא נספרות', () => {
  const rows = [
    { date: '2026-10-01', cells: [{ state: 'empty' }, { state: 'draft' }] },   // עבר
    { date: '2026-10-05', cells: [{ state: 'empty' }, { state: 'ready' }] },   // היום
    { date: '2026-10-11', cells: [{ state: 'draft' }, { state: 'not_needed' }] },
    { date: '2026-10-12', cells: [{ state: 'empty' }, { state: 'not_relevant' }] },
    { date: null, cells: [{ state: 'empty' }] },
  ];
  assert.deepEqual(missingAhead(rows, '2026-10-05'), { missing: 3, total: 4 });
  // שבעה ימים: 5.10 עד 11.10 כולל, 12.10 כבר בחוץ
  assert.deepEqual(missingAhead(rows, '2026-10-05', 7), { missing: 2, total: 3 });
});

test('statusOf — "חסרים" לפי מה שנשאר מהיום, ובלי חסר קדימה: "מלא מהיום והלאה"', () => {
  const c = { active: true, starts_on: '2026-09-01', ends_on: '2026-12-01' };
  const grid = { missing: 5, total_cells: 10, ready: 5 };
  const ch = [{ id: 1 }];
  const st = statusOf({ c, today: '2026-10-05', grid, myChannels: ch,
                        ahead: { missing: 2, total: 6 } });
  assert.equal(st.label, 'חסרים 2 מתוך 6');
  const done = statusOf({ c, today: '2026-10-05', grid, myChannels: ch,
                          ahead: { missing: 0, total: 6 } });
  assert.equal(done.label, 'מלא מהיום והלאה');
});

/* ---------- אין מקום בערוצים: מצב משלו, לא "מלא — 0/0" ---------- */

import { noRoomReason } from '../src/campaigns.js';

const q4 = { id: 1, endpoint_id: 1, endpoint_importance: 5, share_pct: null, active: true,
             starts_on: '2026-10-01', ends_on: '2026-12-31', structure: 'general' };
const oct60 = { id: 2, endpoint_id: 2, share_pct: 60, active: true,
                starts_on: '2026-10-01', ends_on: '2026-10-31' };
const dec50 = { id: 3, endpoint_id: 3, share_pct: 50, active: true,
                starts_on: '2026-12-01', ends_on: '2026-12-31' };
const fb5 = { id: 6, name: 'פייסבוק', max_per_week: 5, urgent_reserve_pct: 20 };

test('generalGridFor — אוטומטי מול קבועים שלא נפגשים לא קורס ל-0/0', () => {
  const list = [q4, oct60, dec50];
  const g = generalGridFor(q4, [], [fb5], '2026-09-01', list, { gapDays: 7 });
  assert.deepEqual(g.needs, { 6: 14 });           // 92 יום במרווח 7; הקצב (33) לא מגביל
  assert.equal(noRoomReason(q4, channelCapacities(q4, [fb5], list, { gapDays: 7 })), null);
});

test('noRoomReason + statusOf — קבוע של 100% לאורך כל התקופה: "אין מקום בערוצים"', () => {
  const full = { ...oct60, share_pct: 100, ends_on: '2026-12-31' };
  const list = [q4, full];
  const caps = channelCapacities(q4, [fb5], list, { gapDays: 7 });
  const reason = noRoomReason(q4, caps);
  assert.match(reason, /נתח קבוע תופסים את כל הערוצים/);
  const g = generalGridFor(q4, [], [fb5], '2026-09-01', list, { gapDays: 7 });
  assert.equal(g.total_cells, 0);
  const st = statusOf({ c: q4, today: '2026-09-01', grid: g, myChannels: [fb5], noRoom: reason });
  assert.equal(st.key, 'no_room');
  assert.equal(st.label, 'אין מקום בערוצים');
  assert.notEqual(st.tone, 'good');
  // נתח 0% שנקבע במפורש — סיבה משלו
  const zero = { ...q4, share_pct: 0 };
  assert.match(noRoomReason(zero, channelCapacities(zero, [fb5], [zero], { gapDays: 7 })),
    /נתח 0%/);
});

test('noRoomReason — כל הערוצים בתקציב 0: הסיבה היא התקרה', () => {
  const reserved = { ...fb5, urgent_reserve_pct: 100 };
  const caps = channelCapacities(q4, [reserved], [q4], { gapDays: 7 });
  assert.equal(caps.get(6).limitedBy, 'budget');
  assert.match(noRoomReason(q4, caps), /תקרה 0/);
});

test('gridFor — במרווח 7 של המנוע (ברירת מחדל): זווית לשבוע, תאים לפי הקיבולת', () => {
  const camp = { ...twoWeeks, structure: 'angles' };
  const g = gridFor(camp, [], [chA, chB], '2026-10-01', [camp]);
  assert.deepEqual(g.needs, { 1: 2, 2: 2 });       // קצב 6 ו-2, אבל מרווח 7 בשבועיים = 2
  assert.equal(g.angles.length, 2);
  assert.equal(g.total_cells, 4);
  assert.equal(g.missing, 4);
  assert.deepEqual(g.angles.map((r) => r.date), ['2026-11-01', '2026-11-08']);
  assert.ok(g.angles.every((r) => r.cells.every((x) => x.state === 'empty')));
});

/* ========================= מרווח לקמפיין ואחים באותה נקודה ========================= */

test('channelCapacities — המרווח של הקמפיין גובר על הכללי', () => {
  const bf = { id: 7, endpoint_id: 4, share_pct: 40, active: true, min_gap_days: 3,
               starts_on: '2026-11-20', ends_on: '2026-12-05' };
  const fb = { id: 6, max_per_week: 5, urgent_reserve_pct: 20 };
  const d = channelCapacities(bf, [fb], [bf], { gapDays: 7 }).get(6);
  assert.equal(d.gapDays, 3);
  assert.equal(d.gapCap, 6);     // 20, 23, 26, 29.11, 2.12, 5.12
  assert.equal(d.capacity, 4);   // הקצב מגביל עכשיו
  assert.equal(d.limitedBy, 'rate');
  // בלי מרווח לקמפיין — הכללי
  const g = channelCapacities({ ...bf, min_gap_days: null }, [fb], [bf], { gapDays: 7 }).get(6);
  assert.equal(g.gapDays, 7);
  assert.equal(g.gapCap, 3);
});

test('channelCapacities — שני קמפיינים חופפים של אותה נקודה באותו ערוץ חולקים את המרווח', () => {
  const fb = { id: 6, max_per_week: 7, urgent_reserve_pct: 0 };
  const a = { id: 1, endpoint_id: 4, share_pct: 50, active: true, channel_ids: [6],
              starts_on: '2026-11-01', ends_on: '2026-11-28' };
  const b = { ...a, id: 2 };
  // לבד: 4 שבועות במרווח 7 = 4
  assert.equal(channelCapacities(a, [fb], [a], { gapDays: 7 }).get(6).gapCap, 4);
  const d = channelCapacities(a, [fb], [a, b], { gapDays: 7 }).get(6);
  assert.equal(d.siblings, 2);
  assert.equal(d.gapCap, 2);
  assert.equal(d.capacity, 2);
});

test('channelCapacities — אח לא נספר: נקודה אחרת, ערוץ אחר, מושהה, לא חופף', () => {
  const fb = { id: 6, max_per_week: 7, urgent_reserve_pct: 0 };
  const a = { id: 1, endpoint_id: 4, share_pct: 30, active: true, channel_ids: [6],
              starts_on: '2026-11-01', ends_on: '2026-11-28' };
  const others = [
    { ...a, id: 2, endpoint_id: 5 },
    { ...a, id: 3, channel_ids: [9] },
    { ...a, id: 4, paused_at: '2026-10-01T00:00:00Z' },
    { ...a, id: 5, active: false },
    { ...a, id: 6, starts_on: '2026-12-01', ends_on: '2026-12-31' },
    { ...a, id: 7, channel_ids: undefined },
  ];
  assert.equal(channelCapacities(a, [fb], [a, ...others], { gapDays: 7 }).get(6).siblings, 1);
});

test('channelCapacities — יום אחד לשלושה אחים: הראשון לפי מזהה מקבל אותו, השאר 0', () => {
  const fb = { id: 6, max_per_week: 7, urgent_reserve_pct: 0 };
  const a = { id: 1, endpoint_id: 4, share_pct: 20, active: true, channel_ids: [6],
              starts_on: '2026-11-01', ends_on: '2026-11-07' };
  const list = [a, { ...a, id: 2 }, { ...a, id: 3 }];
  const d = channelCapacities(a, [fb], list, { gapDays: 7 }).get(6);
  assert.equal(d.siblings, 3);
  assert.equal(d.gapCap, 1);     // floor(1/3) = 0, והשארית (1) לראשון
  const last = channelCapacities(list[2], [fb], list, { gapDays: 7 }).get(6);
  assert.equal(last.gapCap, 0);
  assert.equal(last.capacity, 0);
  assert.equal(last.limitedBy, 'gap');
  assert.match(noRoomReason(list[2], channelCapacities(list[2], [fb], list, { gapDays: 7 })),
    /קמפיינים אחרים של אותה נקודת קצה/);
});

/* ========================= תצוגה מקדימה של קיבולת ========================= */

import { capacityPreview } from '../src/campaigns.js';

const BF = { id: 7, endpoint_id: 4, share_pct: 40, active: true, endpoint_importance: 5,
             starts_on: '2026-11-20', ends_on: '2026-12-05' };
const FB = { id: 6, name: 'פייסבוק', max_per_week: 5, urgent_reserve_pct: 20 };

test('capacityPreview — בלאק פריידי במרווח 7: המרווח מקצץ, ובמרווח 5 הכול נכנס', () => {
  const p = capacityPreview(BF, [FB], [], { gapDays: 7 });
  assert.equal(p.from, '2026-11-20');
  assert.equal(p.to, '2026-12-05');
  assert.equal(p.gap_days, 7);
  assert.deepEqual(p.channels, [{
    channel_id: 6, name: 'פייסבוק', wanted: 5, rate_cap: 4, capacity: 3, gap_cap: 3,
    siblings: 1, limited_by: 'gap', gap_to_fit: 5,
  }]);
  assert.equal(p.short, true);
  assert.equal(p.fixed, null);

  // הטיוטה עם מרווח 5 — כבר לא קצר
  const tight = capacityPreview({ ...BF, min_gap_days: 5 }, [FB], [], { gapDays: 7 });
  assert.equal(tight.gap_days, 5);
  assert.equal(tight.channels[0].capacity, 4);
  assert.equal(tight.channels[0].limited_by, 'rate');
  assert.equal(tight.channels[0].gap_to_fit, null);
  assert.equal(tight.short, false);
});

test('capacityPreview — קמפיין מוכן: כמה נכתב, באיזה מרווח נכנס, ועד מתי להאריך', () => {
  const p = capacityPreview(BF, [FB], [], { gapDays: 7, written: { 6: 3 } });
  const [f] = p.fixed.channels;
  assert.equal(f.written, 3);
  assert.equal(f.capacity, 3);
  assert.equal(f.rate_cap, 4);
  assert.equal(f.rate_short, false);
  assert.equal(f.gap_to_fit, 7);              // 3 ב-16 יום: 20, 27.11, 4.12
  assert.equal(f.end_to_fit, '2026-12-04');   // אפשר אפילו לקצר ביום
  // בהקצאה לפי קצב BF חסר (3 מתוך 4), אבל בקמפיין מוכן הקצב לא קובע — short לא נדלק
  assert.equal(capacityPreview(BF, [FB], [], { gapDays: 7 }).short, true);
  assert.equal(p.short, false);

  const more = capacityPreview(BF, [FB], [], { gapDays: 7, written: { 6: 5 } }).fixed.channels[0];
  // המרווח לבדו מכיל 5 במרווח 3 (20, 23, 26, 29.11, 2.12) — אבל הקצב (4) לא
  // מגיע ל-5, ולכן rate_short: דחיסה לבד לא תספיק, רק הארכה
  assert.equal(more.gap_to_fit, 3);
  assert.equal(more.rate_cap, 4);
  assert.equal(more.rate_short, true);
  // 5 במרווח 7 = 29 יום, והקצב 4×שבועות×40% מגיע ל-5 כבר אחרי 22
  assert.equal(more.end_to_fit, '2026-12-18');
});

test('capacityPreview — ערוץ בלי תוכן במצב מוכן, ובלי תאריכים אין ערוצים', () => {
  const p = capacityPreview(BF, [FB], [], { gapDays: 7, written: {} });
  assert.deepEqual(p.fixed.channels[0], { channel_id: 6, written: 0, capacity: 3, rate_cap: 4,
                                          rate_short: false, gap_to_fit: null, end_to_fit: null });
  const open = capacityPreview({ ...BF, ends_on: null }, [FB], [], { gapDays: 7 });
  assert.deepEqual(open.channels, []);
  assert.equal(open.short, false);
});

test('capacityPreview — אח באותה נקודה ובאותו ערוץ מחלק את המרווח', () => {
  const sib = { ...BF, id: 8, share_pct: 20, channel_ids: [6] };
  const p = capacityPreview({ ...BF, min_gap_days: 3 }, [FB], [sib], { gapDays: 7 });
  const [c] = p.channels;
  assert.equal(c.siblings, 2);
  assert.equal(c.gap_cap, 3);                 // 6 ימים במרווח 3, חלקי 2
  assert.equal(c.limited_by, 'gap');
  assert.equal(c.gap_to_fit, 2);              // 8 ימים במרווח 2 → 4 לכל אח
});
