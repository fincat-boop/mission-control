import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlots, buildUsage, chooseForSlot, nextSlot, outsideCampaignWindow,
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
      lastPerPair: new Map(),
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
