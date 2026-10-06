import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedContent, buildSlots, buildUsage, chooseForSlot, chooseHoleFills, holeReason, nextSlot,
  openHoles, outsideCampaignWindow, planItemKey, recheckSelection, selectPlanItems,
  stalenessOf, stalenessReference,
} from '../src/engine.js';
import { weekMeta } from '../src/board.js';

const SETTINGS = { max_promo_per_day: 1, hybrid_weight: 0.5, min_value_per_promo: 3 };

function channel(over = {}) {
  return {
    id: 1, name: 'ערוץ', max_per_week: 3, urgent_reserve_pct: 0,
    efficiency: 5, blocked_days: [], ...over,
  };
}

/** מריץ את לולאת בחירת המשבצות של planWeek בלי DB ובלי בחירת תוכן. */
function fill(channels, existing = [], anchor = '2026-08-12') {
  const week = weekMeta(anchor);
  const usage = buildUsage(channels, existing, SETTINGS);
  const pending = new Set(buildSlots(week, channels, null));
  const picked = [];

  while (pending.size) {
    const slot = nextSlot(pending, usage, week);
    pending.delete(slot);
    if (!usage.channelHasRoom(slot.channel_id)) continue;
    usage.take(slot.channel_id, slot.dateKey, 'value', 10);
    picked.push(slot);
  }
  return { week, picked };
}

const minGap = (indexes) => {
  const s = [...indexes].sort((a, b) => a - b);
  return Math.min(...s.slice(1).map((v, i) => v - s[i]));
};

test('שיבוץ נפרש על השבוע במקום להידחס לימים הראשונים', () => {
  const { picked } = fill([channel({ max_per_week: 3 })]);
  const days = picked.map((s) => s.index);

  assert.equal(days.length, 3);
  assert.ok(minGap(days) >= 2, `ימים צמודים מדי: ${days}`);
  assert.ok(Math.max(...days) >= 5, `לא הגיע לסוף השבוע: ${days}`);
});

test('שיבוץ מתרחק ממה שכבר על הלוח באותו ערוץ', () => {
  const ch = channel({ max_per_week: 2 });
  const week = weekMeta('2026-08-12');
  const existing = [{
    channel_id: 1, endpoint_id: 1, kind: 'value',
    scheduled_at: new Date(`${week.days[0].date}T10:00:00`),
  }];

  const { picked } = fill([ch], existing);
  // תקציב 2 פחות אחד תפוס = שיבוץ אחד, ורחוק ככל האפשר מיום ראשון
  assert.equal(picked.length, 1);
  assert.equal(picked[0].index, 6);
});

test('תקציב מלא ממלא כל יום פעם אחת', () => {
  const { picked } = fill([channel({ max_per_week: 7 })]);
  assert.deepEqual(picked.map((s) => s.index).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test('ימים חסומים לא נכנסים למשבצות בכלל', () => {
  const week = weekMeta('2026-08-12');
  // 0 = ראשון, 6 = שבת
  const slots = buildSlots(week, [channel({ blocked_days: [5, 6] })], null);
  const dows = slots.map((s) => s.date.getDay());
  assert.equal(slots.length, 5);
  assert.ok(!dows.includes(5) && !dows.includes(6));
});

test('שני ערוצים לא נערמים על אותו יום', () => {
  const channels = [
    channel({ id: 1, name: 'א', max_per_week: 2 }),
    channel({ id: 2, name: 'ב', max_per_week: 2 }),
  ];
  const { picked } = fill(channels);
  assert.equal(picked.length, 4);

  const perDay = new Map();
  for (const s of picked) perDay.set(s.index, (perDay.get(s.index) ?? 0) + 1);
  assert.equal(Math.max(...perDay.values()), 1, `יום עמוס מדי: ${[...perDay]}`);
});

/* ========================= חלון הקמפיין ========================= */

const debtsStub = {
  score: () => 1,
  parts: () => ({ daysSince: 30, staleness: 2, deficit: 0, performance: null }),
};

/** בוחר תוכן לכל יום בשבוע בערוץ 1, ומחזיר אילו פריטים נבחרו באיזה יום */
function pickAcrossWeek(content, anchor = '2026-11-11') {
  const week = weekMeta(anchor);
  const ch = channel({ max_per_week: 7 });
  const settings = { ...SETTINGS, min_gap_days: 0 };
  const out = new Map();
  for (const slot of buildSlots(week, [ch], null)) {
    const pick = chooseForSlot({
      slot,
      endpoints: [{ id: 1, name: 'נקודה', importance: 5 }],
      content,
      campaigns: [],
      debts: debtsStub,
      usage: buildUsage([ch], [], settings),
      usedContent: new Set(),
      pairDates: new Map(),
      settings,
      placements: [],
      history: new Map(),
      sameDay: new Set(),
    });
    out.set(slot.dateKey, pick?.content.id ?? null);
  }
  return { week, out };
}

const item = (over) => ({
  id: 1, endpoint_id: 1, kind: 'value', evergreen: false,
  eligible_channel_ids: [1], ready_channel_ids: [1], ...over,
});

test('outsideCampaignWindow — לפני ההתחלה, אחרי הסוף, ותוכן שוטף', () => {
  const c = { campaign_id: 7, campaign_starts_on: '2026-11-10', campaign_ends_on: '2026-11-12' };
  assert.equal(outsideCampaignWindow(c, '2026-11-09'), true);
  assert.equal(outsideCampaignWindow(c, '2026-11-10'), false);
  assert.equal(outsideCampaignWindow(c, '2026-11-12'), false);
  assert.equal(outsideCampaignWindow(c, '2026-11-13'), true);
  assert.equal(outsideCampaignWindow({ campaign_id: null }, '2020-01-01'), false);
  assert.equal(outsideCampaignWindow({ campaign_id: 7 }, '2020-01-01'), false); // בלי תאריכים
  assert.equal(outsideCampaignWindow({ campaign_id: 7, campaign_starts_on: '2026-11-10' },
    '2030-01-01'), false); // בלי סוף
});

test('המנוע לא משבץ תוכן של קמפיין לפני starts_on או אחרי ends_on', () => {
  // שבוע 8.11–14.11; הקמפיין רץ 10.11–12.11
  const campaignItem = item({
    id: 5, campaign_id: 7, campaign_starts_on: '2026-11-10', campaign_ends_on: '2026-11-12',
  });
  const { out } = pickAcrossWeek([campaignItem]);
  for (const [date, picked] of out) {
    const inside = date >= '2026-11-10' && date <= '2026-11-12';
    assert.equal(picked, inside ? 5 : null, `${date}: ${picked}`);
  }
});

test('תוכן שוטף ממלא את הימים שמחוץ לחלון, התוכן של הקמפיין רק בתוכו', () => {
  const campaignItem = item({
    id: 5, kind: 'promo', campaign_id: 7,
    campaign_starts_on: '2026-11-10', campaign_ends_on: '2026-11-30',
  });
  const background = item({ id: 9, campaign_id: null });
  const { out } = pickAcrossWeek([campaignItem, background]);
  for (const [date, picked] of out) {
    if (date < '2026-11-10') assert.equal(picked, 9, date);
    else assert.ok([5, 9].includes(picked), date);
  }
});

test('משבצת-מדיה של קמפיין כללי (גרסה למדיה אחת) נבחרת רק במדיה שלה', () => {
  const general = item({
    id: 6, campaign_id: 8, slot_channel_id: 2, eligible_channel_ids: [2], ready_channel_ids: [2],
    campaign_starts_on: '2026-11-01', campaign_ends_on: '2026-11-30',
  });
  const { out } = pickAcrossWeek([general]); // הערוץ בבדיקה הוא 1
  assert.ok([...out.values()].every((v) => v === null));
});

test('holeReason — אין תוכן / תוכן רק של קמפיינים מחוץ לחלון / תוכן שלא מתאים', () => {
  const out = { campaign_id: 7, campaign_starts_on: '2027-01-01', campaign_ends_on: '2027-01-31' };
  const bg = { campaign_id: null };
  assert.match(holeReason([], '2026-11-10'), /אין שום תוכן/);
  assert.match(holeReason([out, out], '2026-11-10'), /קמפיינים שלא רצים/);
  assert.match(holeReason([out, bg], '2026-11-10'), /אף גרסה לא מתאימה/);
  assert.match(holeReason([out], '2027-01-10'), /אף גרסה לא מתאימה/);
});

/* ========================= ויתורים ========================= */

test('blockedContent — משובץ השבוע וגם ויתור של המשתמש חוסמים את אותו ערוץ בלבד', () => {
  const set = blockedContent(
    [{ channel_id: 1, content_id: 10 }, { channel_id: 2, content_id: null }],
    [{ channel_id: 3, content_id: 11 }],
  );
  assert.ok(set.has('1:10'));
  assert.ok(set.has('3:11'));
  assert.ok(!set.has('2:11'));
  assert.equal(set.size, 2);
});

/* ========================= מילוי פוסטים חסרי תוכן ========================= */

const NOW = new Date('2026-10-05T08:00:00');
const hole = (over = {}) => ({
  id: 100, channel_id: 1, endpoint_id: 7, content_id: null, status: 'scheduled',
  kind: 'value', title: 'חסר תוכן', published_at: null,
  scheduled_at: new Date('2026-10-08T12:00:00').toISOString(), ...over,
});
const holeItem = (over = {}) => ({
  id: 1, endpoint_id: 7, kind: 'value', title: 'תוכן', campaign_id: null,
  eligible_channel_ids: [1], ready_channel_ids: [1], ...over,
});

test('openHoles — רק עתידיים, מתוכננים, בלי תוכן, בערוץ ונקודה פעילים', () => {
  const existing = [
    hole({ id: 1 }),
    hole({ id: 2, content_id: 5 }),
    hole({ id: 3, scheduled_at: new Date('2026-10-04T10:00:00').toISOString() }),
    hole({ id: 4, status: 'pending_approval' }),
    hole({ id: 5, channel_id: 99 }),
    hole({ id: 6, endpoint_id: null }),
    hole({ id: 7, endpoint_id: 8 }),
  ];
  const ids = openHoles(existing, [{ id: 1 }], [{ id: 7 }], NOW).map((h) => h.id);
  assert.deepEqual(ids, [1]);
});

test('chooseHoleFills — מוכן קודם לטיוטה', () => {
  const fills = chooseHoleFills({
    holes: [hole()],
    content: [holeItem({ id: 1, ready_channel_ids: [] }), holeItem({ id: 2 })],
    usedContent: new Set(),
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].content_id, 2);
  assert.equal(fills[0].post_id, 100);
  assert.equal(fills[0].draft, false);
  assert.equal(fills[0].prev_title, 'חסר תוכן');
});

test('chooseHoleFills — טיוטה ממלאת כשאין מוכן, ומסומנת כטיוטה', () => {
  const fills = chooseHoleFills({
    holes: [hole()],
    content: [holeItem({ ready_channel_ids: [] })],
    usedContent: new Set(),
  });
  assert.equal(fills[0].draft, true);
});

test('chooseHoleFills — בתוך המוכנים, סוג שתואם לפוסט קודם', () => {
  const fills = chooseHoleFills({
    holes: [hole({ kind: 'promo' })],
    content: [holeItem({ id: 1, kind: 'value' }), holeItem({ id: 2, kind: 'promo' })],
    usedContent: new Set(),
  });
  assert.equal(fills[0].content_id, 2);
  assert.equal(fills[0].kind, 'promo');
  assert.equal(fills[0].prev_kind, 'promo');
});

test('chooseHoleFills — נקודה אחרת, ערוץ בלי ניסוח, ויתור וחלון שנגמר — לא ממלאים', () => {
  const fills = chooseHoleFills({
    holes: [hole()],
    content: [
      holeItem({ id: 1, endpoint_id: 8 }),
      holeItem({ id: 2, eligible_channel_ids: [2], ready_channel_ids: [2] }),
      holeItem({ id: 3 }),
      holeItem({ id: 4, campaign_id: 9, campaign_starts_on: '2026-09-01', campaign_ends_on: '2026-10-07' }),
    ],
    usedContent: new Set(['1:3']),
  });
  assert.deepEqual(fills, []);
});

test('chooseHoleFills — אותו תוכן לא ממלא שני פוסטים, ומסומן כמשומש לשאר הריצה', () => {
  const used = new Set();
  const fills = chooseHoleFills({
    holes: [hole({ id: 1 }), hole({ id: 2, scheduled_at: new Date('2026-10-09T12:00:00').toISOString() })],
    content: [holeItem({ id: 5 })],
    usedContent: used,
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].post_id, 1);
  assert.ok(used.has('1:5'));
});

test('chooseHoleFills — תוכן חד-פעמי שכבר שובץ בעבר לא חוזר', () => {
  const history = new Map([[5, { lastByChannel: new Map([[1, '2026-09-01']]) }]]);
  const fills = chooseHoleFills({
    holes: [hole()], content: [holeItem({ id: 5 })], usedContent: new Set(), history,
  });
  assert.deepEqual(fills, []);
});

/* ========================= בחירה מתוך ההצעה ========================= */

const PLAN = {
  placements: [{ content_id: 1, channel_id: 1, scheduled_at: 'A', endpoint_id: 7 },
               { content_id: 2, channel_id: 1, scheduled_at: 'B', endpoint_id: 7 }]
    .map((x) => ({ ...x, key: planItemKey('placement', x) })),
  attachments: [{ post_id: 50, content_id: 3 }].map((x) => ({ ...x, key: planItemKey('attach', x) })),
  holes: [{ channel_id: 2, scheduled_at: 'C', endpoint_id: 8 }]
    .map((x) => ({ ...x, key: planItemKey('hole', x) })),
};

test('planItemKey — מפתחות יציבים ונבדלים לפי סוג', () => {
  assert.equal(PLAN.placements[0].key, '1|1|A|7');
  assert.equal(PLAN.attachments[0].key, 'attach|50|3');
  assert.equal(PLAN.holes[0].key, 'hole|2|C|8');
});

test('selectPlanItems — בלי selected הכול נשאר, כמו תמיד', () => {
  const { plan, skipped } = selectPlanItems(PLAN, null);
  assert.equal(plan, PLAN);
  assert.equal(skipped, 0);
});

test('selectPlanItems — רק המסומנים, ומסומן שכבר לא בהצעה נספר כמדולג', () => {
  const { plan, skipped } = selectPlanItems(PLAN, ['2|1|B|7', 'attach|50|3', '9|9|Z|9']);
  assert.deepEqual(plan.placements.map((p) => p.content_id), [2]);
  assert.equal(plan.attachments.length, 1);
  assert.equal(plan.holes.length, 0);
  assert.equal(skipped, 1);
});

/* ========================= קיבולת: שינוי סוג ========================= */

test('buildUsage.retag — שיוך תוכן מכירתי לפוסט שסומן ערך מעדכן את היחס בלי לתפוס מקום', () => {
  const week = weekMeta('2026-08-12');
  const usage = buildUsage([channel({ max_per_week: 3 })],
    [{ channel_id: 1, kind: 'value', scheduled_at: new Date(`${week.days[2].date}T10:00:00`) }],
    SETTINGS);
  usage.retag(1, week.days[2].date, 'value', 'promo');
  const r = usage.ratioReport();
  assert.equal(r.counts.promo, 1);
  assert.equal(r.counts.value, 0);
  assert.equal(usage.remaining(1), 2);
});

test('openHoles autoOnly — המילוי השקט רואה רק פוסטים שהמנוע יצר כחסרי תוכן', () => {
  const existing = [hole({ id: 1, auto_hole: true }), hole({ id: 2, auto_hole: false }), hole({ id: 3 })];
  const all = openHoles(existing, [{ id: 1 }], [{ id: 7 }], NOW).map((h) => h.id);
  const auto = openHoles(existing, [{ id: 1 }], [{ id: 7 }], NOW, { autoOnly: true }).map((h) => h.id);
  assert.deepEqual(all, [1, 2, 3]);
  assert.deepEqual(auto, [1]);
});

test('chooseHoleFills — תקרת מכירתי ליום מלאה: פוסט ערך לא מתמלא במכירתי', () => {
  const at = '2026-10-08T12:00:00';
  const existing = [
    { channel_id: 1, kind: 'promo', scheduled_at: new Date('2026-10-08T09:00:00') },
    { channel_id: 1, kind: 'value', scheduled_at: new Date(at) },
    ...Array.from({ length: 6 }, (_, i) =>
      ({ channel_id: 1, kind: 'value', scheduled_at: new Date(`2026-10-0${4 + (i % 3)}T10:00:00`) })),
  ];
  const usage = () => buildUsage([channel({ max_per_week: 20 })], existing, SETTINGS);
  const h = hole({ scheduled_at: new Date(at).toISOString() });

  const blocked = chooseHoleFills({
    holes: [h], content: [holeItem({ id: 1, kind: 'promo' })], usedContent: new Set(), usage: usage(),
  });
  assert.deepEqual(blocked, []);

  // יש גם תוכן ערך — הוא נבחר במקום המכירתי שנחסם
  const fallback = chooseHoleFills({
    holes: [h],
    content: [holeItem({ id: 1, kind: 'promo' }), holeItem({ id: 2, kind: 'value', ready_channel_ids: [] })],
    usedContent: new Set(), usage: usage(),
  });
  assert.equal(fallback[0].content_id, 2);
});

test('buildUsage.retag — מעדכן גם את מונה המכירתי ליום', () => {
  const usage = buildUsage([channel({ max_per_week: 20 })],
    [{ channel_id: 1, kind: 'value', scheduled_at: new Date('2026-10-08T10:00:00') },
     ...Array.from({ length: 8 }, () =>
       ({ channel_id: 1, kind: 'value', scheduled_at: new Date('2026-10-05T10:00:00') }))],
    SETTINGS);
  assert.equal(usage.allowsRetag(1, '2026-10-08', 'value', 'promo'), true);
  usage.retag(1, '2026-10-08', 'value', 'promo');
  // תקרה של מכירתי אחד ביום — עכשיו תפוסה
  assert.equal(usage.allows(1, '2026-10-08', 'promo'), false);
  assert.equal(usage.allowsRetag(1, '2026-10-08', 'value', 'promo'), false);
});

test('chooseHoleFills — משבצת-מדיה של ערוץ אחר לא ממלאת פוסט, גם כשיש לה ניסוח לערוץ', () => {
  const fills = chooseHoleFills({
    holes: [hole()],
    content: [holeItem({ id: 1, campaign_id: 9, slot_channel_id: 2 }), holeItem({ id: 2, slot_channel_id: 1, campaign_id: 9 })],
    usedContent: new Set(),
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].content_id, 2);
});

test('recheckSelection — מכירתי שנשען על ערך שהורד מהסימון יורד, עם סיבה', () => {
  const ch = channel({ max_per_week: 10 });
  const ctx = { channels: [ch], existing: [], settings: SETTINGS };
  const pl = (id, kind, date) => ({ key: `k${id}`, title: `t${id}`, channel_id: 1, kind, date });
  const full = [pl(1, 'value', '2026-10-04'), pl(2, 'value', '2026-10-05'),
                pl(3, 'value', '2026-10-06'), pl(4, 'promo', '2026-10-07')];

  const all = recheckSelection({ placements: full, attachments: [], holes: [] }, ctx);
  assert.equal(all.placements.length, 4);
  assert.deepEqual(all.dropped, []);

  const onlyPromo = recheckSelection({ placements: [full[0], full[3]], attachments: [], holes: [] }, ctx);
  assert.deepEqual(onlyPromo.placements.map((p) => p.key), ['k1']);
  assert.equal(onlyPromo.dropped[0].key, 'k4');
  assert.match(onlyPromo.dropped[0].reason, /ערך/);
});

/* ========================= קמפיין מוכן ========================= */

import { plannedDate } from '../src/engine.js';
import { generalGridFor } from '../src/campaigns.js';

/**
 * מריץ את הלולאה של planWeek שבוע אחרי שבוע על ערוץ אחד (קצב 3 בשבוע),
 * עם היסטוריה מצטברת — תוכן חד-פעמי שכבר שובץ לא חוזר. מחזיר מתי כל פריט
 * שובץ.
 */
function runWeeks(content, anchors, chOver = {}) {
  const ch = channel({ max_per_week: 3, ...chOver });
  const settings = { ...SETTINGS, min_gap_days: 0 };
  const placedAt = new Map();
  for (const anchor of anchors) {
    const week = weekMeta(anchor);
    const usage = buildUsage([ch], [], settings);
    const usedContent = new Set();
    const pending = new Set(buildSlots(week, [ch], null));
    const history = new Map([...placedAt].map(([id, date]) =>
      [id, { lastByChannel: new Map([[1, date]]) }]));
    while (pending.size) {
      const slot = nextSlot(pending, usage, week);
      pending.delete(slot);
      if (!usage.channelHasRoom(slot.channel_id)) continue;
      const pick = chooseForSlot({
        slot, endpoints: [{ id: 1, name: 'נקודה', importance: 5 }], content, campaigns: [],
        debts: debtsStub, usage, usedContent, pairDates: new Map(), settings,
        placements: [], history, sameDay: new Set(),
      });
      if (!pick) continue;
      usage.take(slot.channel_id, slot.dateKey, pick.content.kind, 10);
      usedContent.add(`${slot.channel_id}:${pick.content.id}`);
      history.set(pick.content.id, { lastByChannel: new Map([[1, slot.dateKey]]) });
      placedAt.set(pick.content.id, slot.dateKey);
    }
  }
  return placedAt;
}

// חודש: 1.11 (ראשון) עד 30.11; חמישה שבועות שמכסים אותו
const NOV = ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];
const sixItems = (complete) => [1, 2, 3, 4, 5, 6].map((i) => item({
  id: i, campaign_id: 7, slot_channel_id: 1, sort_order: i,
  campaign_starts_on: '2026-11-01', campaign_ends_on: '2026-11-30',
  ...(complete ? { campaign_complete_at: '2026-10-05T10:00:00Z',
                   campaign_slot_rank: i, campaign_slot_count: 6 } : {}),
}));

test('plannedDate — אותו תאריך שהרשת מציגה (spreadDate), ורק בקמפיין מוכן', () => {
  const items = sixItems(true);
  const grid = generalGridFor(
    { starts_on: '2026-11-01', ends_on: '2026-11-30', content_complete_at: 'x' },
    items.map((x) => ({ ...x, variants: [{ id: x.id, channel_id: 1, status: 'ready' }] })),
    [{ id: 1, name: 'ערוץ' }], '2026-10-01');
  assert.deepEqual(items.map(plannedDate), grid.channels[0].slots.map((s) => s.date));
  assert.equal(plannedDate(sixItems(false)[0]), null);
  assert.equal(outsideCampaignWindow(items[1], '2026-11-05'), true);   // לפני 6.11
  assert.equal(outsideCampaignWindow(items[1], '2026-11-06'), false);
  assert.equal(outsideCampaignWindow(items[1], '2026-11-20'), false);  // התפספס — מותר אחר כך
  assert.equal(outsideCampaignWindow(items[1], '2026-12-01'), true);   // אחרי סוף הקמפיין
});

test('קמפיין רגיל עם 6 פוסטים בקצב 3 בשבוע — נגמר בשבועיים הראשונים (המצב שמתקנים)', () => {
  const at = runWeeks(sixItems(false), NOV);
  assert.equal(at.size, 6);
  assert.ok([...at.values()].every((d) => d < '2026-11-15'), [...at.values()].join(','));
});

test('קמפיין מוכן: 6 פוסטים בחודש נפרסים על כל התקופה, אף אחד לא לפני התאריך שלו', () => {
  const items = sixItems(true);
  const at = runWeeks(items, NOV);
  assert.equal(at.size, 6);
  for (const it of items) {
    assert.ok(at.get(it.id) >= plannedDate(it), `${it.id}: ${at.get(it.id)} < ${plannedDate(it)}`);
  }
  const dates = [...at.values()].sort();
  assert.ok(dates[5] >= '2026-11-21', dates.join(','));   // האחרון בסוף התקופה
  // לא יותר משניים באותו שבוע — לא נדחס לשבועות הראשונים
  const perWeek = new Map();
  for (const d of dates) {
    const w = weekMeta(d).start;
    perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
  }
  assert.ok(Math.max(...perWeek.values()) <= 2, [...perWeek].join(' '));
});

test('קמפיין מוכן: המשבצת של האחרון התפספסה — הוא עדיין יוצא לפני ends_on', () => {
  const items = sixItems(true);
  const last = items[5];
  assert.equal(plannedDate(last), '2026-11-26');           // חמישי — לפני הסוף, לא עליו
  // חמישי חסום בערוץ: המשבצת המתוכננת של האחרון לא קיימת
  const at = runWeeks(items, NOV, { blocked_days: [4] });
  assert.equal(at.size, 6, [...at].join(' '));
  assert.ok(at.get(last.id) > '2026-11-26' && at.get(last.id) <= '2026-11-30', at.get(last.id));
});

test('holeReason — קמפיין מוכן שהתוכן שלו מחכה לתאריך המתוכנן', () => {
  const items = sixItems(true).slice(1);                  // הראשון כבר יצא; הבא ב-6.11
  assert.match(holeReason(items, '2026-11-03'), /מתוכנן לתאריכים מאוחרים יותר/);
  // לפני תחילת הקמפיין — עדיין "קמפיינים שלא רצים"
  assert.match(holeReason(items, '2026-10-20'), /קמפיינים שלא רצים/);
  // ביום המתוכנן יש תוכן מתאים — הסיבה הכללית
  assert.match(holeReason(items, '2026-11-06'), /אף גרסה לא מתאימה/);
});

/* ---------- יעד אסטרטגי לפי השבוע המתוכנן, לא לפי היום ---------- */

import { strategyDeficits, strategyTargets } from '../src/engine.js';

// "היום" = אוקטובר: שוטף של נקודה 1 רץ עכשיו; בלאק פריידי (נקודה 2, 40%)
// מתחיל רק ב-20.11. עד עכשיו המנוע הסתכל על הקמפיינים של היום, ולכן כשתכנן
// את שבוע בלאק פריידי היעד של נקודה 2 היה 0 — והיא קיבלה 0 משבצות.
const routine = { id: 1, endpoint_id: 1, endpoint_importance: 5, share_pct: null,
                  active: true, paused_at: null, starts_on: '2026-10-01', ends_on: '2026-12-31' };
const blackFriday = { id: 7, endpoint_id: 2, endpoint_importance: 9, share_pct: 40,
                      active: true, paused_at: null, starts_on: '2026-11-20', ends_on: '2026-12-05' };

test('strategyTargets — קמפיין עתידי מושך את הנקודה שלו כשמתכננים את השבוע שבו הוא רץ', () => {
  const bfWeek = weekMeta('2026-11-24');
  const { targetPct, from, to } = strategyTargets([routine, blackFriday], bfWeek);
  assert.equal(targetPct.get(2), 40);
  assert.equal(Math.round(targetPct.get(1)), 60);          // היתרה לאוטומטי
  assert.equal(from, '2026-10-01');                       // starts_on המוקדם בשבוע
  assert.equal(to, bfWeek.days[6].date);

  // עד עכשיו לנקודה 1 יש 10 פוסטים חיים בחלון, ולנקודה 2 אף אחד
  const d = strategyDeficits(targetPct, [{ endpoint_id: 1, n: 10 }]);
  assert.equal(d.get(2), 0.4);
  assert.equal(d.get(1), 0);
});

test('strategyTargets — בשבוע של היום בלאק פריידי עוד לא רץ: אין לו יעד', () => {
  const now = weekMeta('2026-10-14');
  const { targetPct } = strategyTargets([routine, blackFriday], now);
  assert.equal(targetPct.has(2), false);
  assert.equal(targetPct.get(1), 100);
  assert.equal(strategyDeficits(targetPct, [{ endpoint_id: 1, n: 3 }]).get(2), undefined);
});

test('strategyTargets — בלי קמפיינים בשבוע: החלון 90 יום אחורה, בלי יעדים', () => {
  const w = weekMeta('2027-03-10');
  const { targetPct, from } = strategyTargets([routine, blackFriday], w);
  assert.equal(targetPct.size, 0);
  assert.equal(from, '2026-12-07');                       // 7.3.2027 − 90
});

test('strategyTargets — מושהה לא מושך; מפורשים מעל 100% מוקטנים', () => {
  const w = weekMeta('2026-11-24');
  const paused = { ...blackFriday, paused_at: '2026-11-01T00:00:00Z' };
  assert.equal(strategyTargets([routine, paused], w).targetPct.has(2), false);
  const big = { ...routine, share_pct: 90 };
  const { targetPct } = strategyTargets([big, blackFriday], w);
  assert.equal(Math.round(targetPct.get(1)), 69);           // 90 / 130
  assert.equal(Math.round(targetPct.get(2)), 31);           // 40 / 130
});

test('strategyDeficits — נקודה שוטפת בלי יעד לא נכנסת לבסיס ולא יוצרת פיגור קבוע', () => {
  const targets = new Map([[1, 60], [2, 40]]);
  // נקודה 3 (שוטף, בלי קמפיין) פרסמה 100 — לפני התיקון נקודות 1 ו-2 פיגרו תמיד
  const d = strategyDeficits(targets, [
    { endpoint_id: 1, n: 6 }, { endpoint_id: 2, n: 4 }, { endpoint_id: 3, n: 100 }]);
  assert.equal(d.get(1), 0);
  assert.equal(d.get(2), 0);
  assert.equal(d.has(3), false);
  // מפגרת באמת ביחס לשותפות ליעד: 1 מול 9 כשהיעד 40% מול 60%
  const lag = strategyDeficits(targets, [{ endpoint_id: 1, n: 9 }, { endpoint_id: 2, n: 1 },
                                         { endpoint_id: 3, n: 100 }]);
  assert.equal(Math.round(lag.get(2) * 100), 30);
});

test('strategyDeficits — יעדים מתחת ל-100% מנורמלים לאותו בסיס', () => {
  // שני קבועים: 40% ו-20% (סכום 60) → 2/3 מול 1/3 מהפוסטים שלהם
  const d = strategyDeficits(new Map([[2, 40], [3, 20]]),
    [{ endpoint_id: 2, n: 5 }, { endpoint_id: 3, n: 5 }, { endpoint_id: 9, n: 50 }]);
  assert.equal(Math.round(d.get(2) * 100), 17);   // 66.7 − 50
  assert.equal(d.get(3), 0);
});

/* ========================= מרווח לפי קמפיין, שכן לשני הכיוונים ========================= */

import { addPairDate, contentGap, nearestDays } from '../src/engine.js';

/** בחירה למשבצת אחת בערוץ 1, עם פוסטים קיימים של נקודה 1 בתאריכים dates */
function pickOn(dateKey, content, dates, settings = { ...SETTINGS, min_gap_days: 7 }) {
  const ch = channel({ max_per_week: 7 });
  const pick = chooseForSlot({
    slot: { channel_id: 1, channel_name: 'ערוץ', dateKey, date: new Date(`${dateKey}T00:00:00`) },
    endpoints: [{ id: 1, name: 'נקודה', importance: 5 }],
    content, campaigns: [], debts: debtsStub,
    usage: buildUsage([ch], [], settings), usedContent: new Set(),
    pairDates: new Map([['1:1', [...dates]]]), settings,
    placements: [], history: new Map(), sameDay: new Set(),
  });
  return pick?.content.id ?? null;
}

test('nearestDays — המרחק לשכן הקרוב, לפני או אחרי; בלי פוסטים — אינסוף', () => {
  assert.equal(nearestDays(['2026-11-01', '2026-11-30'], '2026-11-03'), 2);
  assert.equal(nearestDays(['2026-11-01', '2026-11-30'], '2026-11-27'), 3);
  assert.equal(nearestDays([], '2026-11-03'), Infinity);
  assert.equal(nearestDays(undefined, '2026-11-03'), Infinity);
  // מעבר שעון (25.10) לא מקצר יום
  assert.equal(nearestDays(['2026-10-24'], '2026-10-26'), 2);
});

test('addPairDate — נשמר ממוין גם כשמוסיפים תאריך מוקדם', () => {
  const m = new Map([['1:1', ['2026-11-10']]]);
  addPairDate(m, '1:1', '2026-11-03');
  addPairDate(m, '2:1', '2026-11-05');
  assert.deepEqual(m.get('1:1'), ['2026-11-03', '2026-11-10']);
  assert.deepEqual(m.get('2:1'), ['2026-11-05']);
});

test('contentGap — המרווח של הקמפיין של התוכן; תוכן בלי קמפיין — הכללי', () => {
  const s = { min_gap_days: 7 };
  assert.equal(contentGap(item({ campaign_id: 3, campaign_min_gap_days: 2 }), s), 2);
  assert.equal(contentGap(item({ campaign_id: 3, campaign_min_gap_days: null }), s), 7);
  assert.equal(contentGap(item({ campaign_id: null }), s), 7);
  assert.equal(contentGap(item({ campaign_id: null }), {}), 7);
});

test('רגרסיה: פוסט עתידי לא מסתיר שכן קרוב — המרווח נבדק לשני הכיוונים', () => {
  // פוסט קיים ב-1.11 ועוד אחד עתידי ב-30.11. קודם נבדק רק המאוחר (max),
  // ומשבצת ב-3.11 עברה למרות שהיא יומיים אחרי 1.11.
  const dates = ['2026-11-01', '2026-11-30'];
  const c = item({ id: 4 });
  assert.equal(pickOn('2026-11-03', [c], dates), null, 'יומיים אחרי 1.11');
  assert.equal(pickOn('2026-11-26', [c], dates), null, 'ארבעה ימים לפני 30.11');
  assert.equal(pickOn('2026-11-08', [c], dates), 4, 'שבוע אחרי 1.11 — מותר');
  assert.equal(pickOn('2026-11-23', [c], dates), 4, 'שבוע לפני 30.11 — מותר');
});

test('מרווח לפי מועמד: שני קמפיינים של אותה נקודה עם מרווחים שונים', () => {
  // פוסט קיים לפני 3 ימים. קמפיין א׳ (מרווח 2) נכנס, קמפיין ב׳ (מרווח 7) לא.
  const dates = ['2026-11-05'];
  const tight = item({ id: 21, campaign_id: 1, campaign_min_gap_days: 2 });
  const loose = item({ id: 22, campaign_id: 2, campaign_min_gap_days: 7 });
  assert.equal(pickOn('2026-11-08', [loose, tight], dates), 21);
  assert.equal(pickOn('2026-11-08', [loose], dates), null);
  // יום אחרי הפוסט — גם מרווח 2 לא מספיק
  assert.equal(pickOn('2026-11-06', [tight], dates), null);
  // שבוע אחרי — שניהם מותרים, והראשון בסדר זוכה (שניהם מוכנים, אותו סוג)
  assert.equal(pickOn('2026-11-12', [loose, tight], dates), 22);
});

test('מרווח 1 בקמפיין: כל יום מותר, אבל לא אותו יום', () => {
  const daily = item({ id: 31, campaign_id: 1, campaign_min_gap_days: 1 });
  assert.equal(pickOn('2026-11-06', [daily], ['2026-11-05']), 31);
  assert.equal(pickOn('2026-11-05', [daily], ['2026-11-05']), null);
});

test('תוכן שוטף (בלי קמפיין) נבדק מול ברירת המחדל הכללית', () => {
  const plain = item({ id: 41, campaign_id: null });
  const s3 = { ...SETTINGS, min_gap_days: 3 };
  assert.equal(pickOn('2026-11-07', [plain], ['2026-11-05'], s3), null);
  assert.equal(pickOn('2026-11-08', [plain], ['2026-11-05'], s3), 41);
});

test('chooseHoleFills — תוכן של קמפיין שהמרווח שלו לא מתקיים מול השכן לא ממלא את הפוסט', () => {
  // הפוסט ב-8.10, שכן של אותה נקודה וערוץ ב-5.10 (3 ימים). הפוסט עצמו ברשימה.
  const pairDates = new Map([['7:1', ['2026-10-05', '2026-10-08']]]);
  const loose = holeItem({ id: 1, campaign_id: 3, campaign_min_gap_days: 7 });
  const tight = holeItem({ id: 2, campaign_id: 4, campaign_min_gap_days: 3 });
  const pick = (content) => chooseHoleFills({
    holes: [hole()], content, usedContent: new Set(), settings: { min_gap_days: 7 }, pairDates,
  }).map((f) => f.content_id);
  assert.deepEqual(pick([loose]), []);
  assert.deepEqual(pick([loose, tight]), [2]);
  // תוכן שוטף נבדק מול הכללי (7) — לא נכנס
  assert.deepEqual(pick([holeItem({ id: 5 })]), []);
  // בלי השכן — התאריך של הפוסט עצמו לא חוסם אותו
  assert.deepEqual(chooseHoleFills({
    holes: [hole()], content: [loose], usedContent: new Set(), settings: { min_gap_days: 7 },
    pairDates: new Map([['7:1', ['2026-10-08']]]),
  }).map((f) => f.content_id), [1]);
});

/* ========================= ימים שעברו ========================= */

test('buildSlots עם today: ימים לפני היום לא נכנסים; היום עצמו כן', () => {
  const week = weekMeta('2026-08-12'); // 9–15.8
  const slots = buildSlots(week, [channel()], null, { today: '2026-08-12' });
  assert.deepEqual(slots.map((s) => s.dateKey),
    ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15']);
  // שבוע שכולו עבר — אין משבצות בכלל; בלי today — כל השבוע, כמו קודם
  assert.equal(buildSlots(week, [channel()], null, { today: '2026-09-01' }).length, 0);
  assert.equal(buildSlots(week, [channel()], null).length, 7);
});

/* ========================= ותק ביחס לשבוע המתוכנן ========================= */

test('stalenessReference: שבוע עתידי — תחילתו; השבוע הנוכחי — עכשיו', () => {
  const now = new Date('2026-10-06T15:00:00');
  assert.equal(stalenessReference(weekMeta('2026-11-24'), now).getTime(),
    new Date('2026-11-22T00:00:00').getTime());
  assert.equal(stalenessReference(weekMeta('2026-10-08'), now), now);
});

test('stalenessOf: ימים עד הייחוס חלקי הקצב; בלי פוסט — 2 קבוע', () => {
  const ref = new Date('2026-11-22T00:00:00');
  const ep = { importance: 5 }; // קצב 12 ימים
  const twoDays = stalenessOf(new Date('2026-11-20T00:00:00'), ref, ep);
  const month = stalenessOf(new Date('2026-10-23T00:00:00'), ref, ep);
  assert.equal(Math.round(twoDays.daysSince), 2);
  assert.equal(Math.round(month.daysSince), 30);
  assert.ok(twoDays.staleness < month.staleness);
  assert.deepEqual(stalenessOf(null, ref, ep), { daysSince: null, staleness: 2 });
});

test('stalenessOf: לא פורסמה — מאז שנוצרה באותו קצב, ולפחות 2', () => {
  const ref = new Date('2026-11-22T00:00:00');
  const created = (d) => ({ importance: 5, created_at: new Date(`${d}T00:00:00`) }); // קצב 12
  // 60 יום (חוצה מעבר שעון — שעה אחת לא משנה) חלקי 12
  const old = stalenessOf(null, ref, created('2026-09-23'));
  assert.equal(old.daysSince, null);
  assert.equal(Math.round(old.staleness * 100) / 100, 5);
  assert.deepEqual(stalenessOf(null, ref, created('2026-11-20')), { daysSince: null, staleness: 2 });
  // פוסט קיים גובר על תאריך היצירה
  assert.equal(stalenessOf(new Date('2026-11-10T00:00:00'), ref, created('2026-01-01')).staleness, 1);
});

/* ========================= שער היחס בשבוע מרוסן ========================= */

test('buildUsage projectedPromoCap — מכירתי עד floor(תקציבים / (1+יחס)), גם בלי ערך על הלוח', () => {
  // שני ערוצים × 7 = 14; יחס 3 → 3 מכירתיים בשבוע
  const chans = [channel({ id: 1, max_per_week: 7 }), channel({ id: 2, max_per_week: 7 })];
  const settings = { ...SETTINGS, max_promo_per_day: 5 };
  const usage = buildUsage(chans, [], settings, { projectedPromoCap: true });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(usage.allows(1, '2026-10-08', 'promo', 100 + i), true, `מכירתי ${i + 1}`);
    usage.take(1, '2026-10-08', 'promo', 10 + i);
  }
  assert.equal(usage.allows(2, '2026-10-08', 'promo', 200), false, 'הרביעי חורג מהתקרה');
  assert.deepEqual(usage.ratioReport().blockedPairs, ['2:200']);

  // מכירתי שכבר על הלוח באותו שבוע נספר בתקרה
  const busy = buildUsage(chans, [
    { channel_id: 1, kind: 'promo', scheduled_at: new Date('2026-10-05T10:00:00') },
    { channel_id: 2, kind: 'promo', scheduled_at: new Date('2026-10-06T10:00:00') },
  ], settings, { projectedPromoCap: true });
  assert.equal(busy.allows(1, '2026-10-08', 'promo'), true);
  busy.take(1, '2026-10-08', 'promo', 10);
  assert.equal(busy.allows(1, '2026-10-09', 'promo'), false);

  // השער הרגיל (שבוע מלא) — בלי ערך על הלוח אין מכירתי בכלל, כמו קודם
  assert.equal(buildUsage(chans, [], settings).allows(1, '2026-10-08', 'promo'), false);
  // יחס 0 = שער כבוי
  const off = buildUsage(chans, [], { ...settings, min_value_per_promo: 0 }, { projectedPromoCap: true });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(off.allows(1, `2026-10-0${4 + i}`, 'promo'), true);
    off.take(1, `2026-10-0${4 + i}`, 'promo', 10);
  }
});
