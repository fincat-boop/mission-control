import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedContent, buildSlots, buildUsage, chooseHoleFills, inCampaignWindow, nextSlot,
  openHoles, planItemKey, selectPlanItems,
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

/* ========================= חלון קמפיין ========================= */

test('חלון קמפיין — תוכן שוטף תמיד בפנים', () => {
  assert.equal(inCampaignWindow({ campaign_id: null }, '2026-10-05'), true);
});

test('חלון קמפיין — בתוך התאריכים, כולל הקצוות', () => {
  const c = { campaign_id: 3, campaign_starts_on: '2026-10-01', campaign_ends_on: '2026-10-10' };
  assert.equal(inCampaignWindow(c, '2026-10-01'), true);
  assert.equal(inCampaignWindow(c, '2026-10-10'), true);
  assert.equal(inCampaignWindow(c, '2026-10-05'), true);
});

test('חלון קמפיין — קמפיין שנגמר אתמול לא משתבץ היום, ושעוד לא התחיל — לא', () => {
  const ended = { campaign_id: 3, campaign_starts_on: '2026-09-01', campaign_ends_on: '2026-10-04' };
  const future = { campaign_id: 4, campaign_starts_on: '2026-10-06', campaign_ends_on: null };
  assert.equal(inCampaignWindow(ended, '2026-10-05'), false);
  assert.equal(inCampaignWindow(future, '2026-10-05'), false);
});

test('חלון קמפיין — בלי תאריכים = פתוח', () => {
  assert.equal(inCampaignWindow({ campaign_id: 5 }, '2030-01-01'), true);
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
const item = (over = {}) => ({
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
    content: [item({ id: 1, ready_channel_ids: [] }), item({ id: 2 })],
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
    content: [item({ ready_channel_ids: [] })],
    usedContent: new Set(),
  });
  assert.equal(fills[0].draft, true);
});

test('chooseHoleFills — בתוך המוכנים, סוג שתואם לפוסט קודם', () => {
  const fills = chooseHoleFills({
    holes: [hole({ kind: 'promo' })],
    content: [item({ id: 1, kind: 'value' }), item({ id: 2, kind: 'promo' })],
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
      item({ id: 1, endpoint_id: 8 }),
      item({ id: 2, eligible_channel_ids: [2], ready_channel_ids: [2] }),
      item({ id: 3 }),
      item({ id: 4, campaign_id: 9, campaign_starts_on: '2026-09-01', campaign_ends_on: '2026-10-07' }),
    ],
    usedContent: new Set(['1:3']),
  });
  assert.deepEqual(fills, []);
});

test('chooseHoleFills — אותו תוכן לא ממלא שני פוסטים, ומסומן כמשומש לשאר הריצה', () => {
  const used = new Set();
  const fills = chooseHoleFills({
    holes: [hole({ id: 1 }), hole({ id: 2, scheduled_at: new Date('2026-10-09T12:00:00').toISOString() })],
    content: [item({ id: 5 })],
    usedContent: used,
  });
  assert.equal(fills.length, 1);
  assert.equal(fills[0].post_id, 1);
  assert.ok(used.has('1:5'));
});

test('chooseHoleFills — תוכן חד-פעמי שכבר שובץ בעבר לא חוזר', () => {
  const history = new Map([[5, { lastByChannel: new Map([[1, '2026-09-01']]) }]]);
  const fills = chooseHoleFills({
    holes: [hole()], content: [item({ id: 5 })], usedContent: new Set(), history,
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
  usage.retag(1, 'value', 'promo');
  const r = usage.ratioReport();
  assert.equal(r.counts.promo, 1);
  assert.equal(r.counts.value, 0);
  assert.equal(usage.remaining(1), 2);
});
