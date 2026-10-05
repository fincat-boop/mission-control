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

/* ========================= קמפיין כללי ========================= */

import { generalGridFor, gridFor, resolvePeriod, structureChangeError } from '../src/campaigns.js';

// שבועיים, שני ערוצים: 3 ו-1 בשבוע → צורך 6 ו-2
const twoWeeks = {
  starts_on: '2026-11-01', ends_on: '2026-11-14', active: true, importance: 5, structure: 'general',
};
const chA = { id: 1, name: 'פייסבוק', target_per_week: 3 };
const chB = { id: 2, name: 'ניוזלטר', target_per_week: 1 };
const slotItem = (id, channel, order, status) => ({
  id, slot_channel_id: channel, sort_order: order,
  variants: status ? [{ id: id * 10, channel_id: channel, status, body: 'x' }] : [],
});

test('generalGridFor — משבצות לכל מדיה לפי הצורך שלה, בלי זוויות', () => {
  const g = generalGridFor(twoWeeks, [], [chA, chB], '2026-10-01', [twoWeeks]);
  assert.deepEqual(g.needs, { 1: 6, 2: 2 });
  assert.equal(g.channels.length, 2);
  assert.equal(g.channels[0].slots.length, 6);
  assert.equal(g.channels[1].slots.length, 2);
  assert.equal(g.total_cells, 8);
  assert.equal(g.missing, 8);
  assert.equal(g.ready, 0);
  // פרוס על חלון הקמפיין, משבצת ראשונה ביום הראשון ואחרונה ביום האחרון
  assert.equal(g.channels[0].slots[0].date, '2026-11-01');
  assert.equal(g.channels[0].slots[5].date, '2026-11-14');
  assert.equal(g.channels[1].slots[1].date, '2026-11-14');
});

test('generalGridFor — נדרש = סכום הצרכים, מוכן = גרסה מוכנה, חסר = נדרש − מוכן', () => {
  const content = [
    slotItem(1, 1, 1, 'ready'),
    slotItem(2, 1, 2, 'draft'),
    slotItem(3, 2, 1, 'ready'),
  ];
  const g = generalGridFor(twoWeeks, content, [chA, chB], '2026-10-01', [twoWeeks]);
  assert.equal(g.total_cells, 8);
  assert.equal(g.ready, 2);
  assert.equal(g.missing, 6);          // טיוטה עדיין חסרה — כמו בזוויות
  assert.equal(g.drafts, 1);
  assert.equal(g.channels[0].slots[1].state, 'draft');
  assert.equal(g.channels[1].slots[0].state, 'ready');
  assert.equal(g.channels[1].slots[1].state, 'empty');
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
  const g = gridFor(camp, [angle], [chA, chB], '2026-10-01', [camp]);
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
