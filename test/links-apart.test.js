import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addGroupDay, chooseForSlot, chooseHoleFills, linkDayTaken, linkedSameDay, removeGroupDay,
} from '../src/engine.js';
import { respaceMoves } from '../src/respace.js';
import { planClashFixes } from '../src/fix-clashes.js';
import { weekMeta } from '../src/board.js';

/**
 * פוסטים מקושרים (מקור + עוקבות) לא יוצאים באותו יום כשהקמפיין מבקש
 * (links_apart, ברירת מחדל כן) — בכל ערוץ. אותו פריט בשני ערוצים אינו
 * "מקושר". מול מסד אמיתי (planWeek) — ב-links-apart-db.test.js.
 */

test('groupDays — פריט אחר מהקבוצה תופס את היום; אותו פריט לא; הסרה מורידה רישום אחד', () => {
  const g = new Map();
  addGroupDay(g, 1, 1, '2030-01-07');
  assert.equal(linkDayTaken(g, 1, 2, '2030-01-07'), true);    // העוקבת מול המקור
  assert.equal(linkDayTaken(g, 1, 1, '2030-01-07'), false);   // המקור מול עצמו
  assert.equal(linkDayTaken(g, 1, 2, '2030-01-08'), false);   // יום אחר
  addGroupDay(g, 1, 1, '2030-01-07');                          // אותו פריט בערוץ שני
  removeGroupDay(g, 1, 1, '2030-01-07');
  assert.equal(linkDayTaken(g, 1, 2, '2030-01-07'), true, 'נשאר רישום אחד');
  removeGroupDay(g, 1, 1, '2030-01-07');
  assert.equal(linkDayTaken(g, 1, 2, '2030-01-07'), false);
});

test('linkedSameDay — לפי links_apart של הקמפיין; null (בלי קמפיין) = כן', () => {
  const g = new Map();
  addGroupDay(g, 1, 1, '2030-01-07');
  const follower = { id: 2, linked_to_id: 1, campaign_links_apart: true };
  assert.equal(linkedSameDay(follower, g, '2030-01-07'), true);
  assert.equal(linkedSameDay({ ...follower, campaign_links_apart: false }, g, '2030-01-07'), false);
  assert.equal(linkedSameDay({ ...follower, campaign_links_apart: null }, g, '2030-01-07'), true);
  // המקור מול עוקבת שכבר ביום
  const g2 = new Map();
  addGroupDay(g2, 1, 2, '2030-01-07');
  assert.equal(linkedSameDay({ id: 1, linked_to_id: null, campaign_links_apart: true }, g2, '2030-01-07'),
    true);
});

/* ---------- chooseForSlot ---------- */

const debts = { score: () => 1, parts: () => ({ daysSince: 3, staleness: 0, deficit: 0 }) };
const usage = { allows: () => true };
const item = (over = {}) => ({
  id: 1, endpoint_id: 7, kind: 'value', title: 'פריט', campaign_id: 5, linked_to_id: null,
  campaign_links_apart: true, eligible_channel_ids: [1, 2], ready_channel_ids: [1, 2], ...over,
});

test('chooseForSlot — עוקבת לא נבחרת ליום שבו המקור כבר יוצא; פריט אחר כן', () => {
  const g = new Map();
  addGroupDay(g, 1, 1, '2030-01-08');
  const ctx = {
    slot: { channel_id: 2, dateKey: '2030-01-08' }, endpoints: [{ id: 7, name: 'קורס', importance: 5 }],
    campaigns: [], debts, usage, usedContent: new Set(), settings: { min_gap_days: 0 },
    history: new Map(), sameDay: new Set(), groupDays: g,
  };
  assert.equal(chooseForSlot({ ...ctx, content: [item({ id: 2, linked_to_id: 1 })] }), null);
  const pick = chooseForSlot({ ...ctx, content: [item({ id: 2, linked_to_id: 1 }), item({ id: 3 })] });
  assert.equal(pick.content.id, 3);
  // links_apart כבוי — מותר
  const off = chooseForSlot({ ...ctx, content: [item({ id: 2, linked_to_id: 1, campaign_links_apart: false })] });
  assert.equal(off.content.id, 2);
});

/* ---------- chooseHoleFills (שיוך לפוסט חסר תוכן) ---------- */

const hole = (id, channel, date) => ({
  id, channel_id: channel, endpoint_id: 7, content_id: null, status: 'scheduled', kind: 'value',
  title: 'חסר תוכן', scheduled_at: new Date(`${date}T12:00:00`).toISOString(),
});

test('chooseHoleFills — שני פוסטים חסרי תוכן באותו יום בשני ערוצים: רק אחד מהקבוצה', () => {
  const content = [item({ id: 1, eligible_channel_ids: [1], ready_channel_ids: [1] }),
                   item({ id: 2, linked_to_id: 1, eligible_channel_ids: [2], ready_channel_ids: [2] })];
  const holes = [hole(100, 1, '2030-01-08'), hole(101, 2, '2030-01-08')];
  const on = chooseHoleFills({ holes, content, usedContent: new Set(), groupDays: new Map() });
  assert.deepEqual(on.map((a) => a.content_id), [1]);

  const offContent = content.map((c) => ({ ...c, campaign_links_apart: false }));
  const off = chooseHoleFills({ holes, content: offContent, usedContent: new Set(), groupDays: new Map() });
  assert.deepEqual(off.map((a) => a.content_id), [1, 2]);

  // יום אחר — שניהם
  const apart = chooseHoleFills({ holes: [hole(100, 1, '2030-01-08'), hole(101, 2, '2030-01-09')],
                                  content, usedContent: new Set(), groupDays: new Map() });
  assert.deepEqual(apart.map((a) => a.content_id), [1, 2]);
});

test('chooseHoleFills — מול פוסט קיים של הקבוצה (groupDays מהמסד)', () => {
  const g = new Map();
  addGroupDay(g, 1, 1, '2030-01-08');
  const fills = chooseHoleFills({
    holes: [hole(101, 2, '2030-01-08')],
    content: [item({ id: 2, linked_to_id: 1, eligible_channel_ids: [2], ready_channel_ids: [2] })],
    usedContent: new Set(), groupDays: g,
  });
  assert.equal(fills.length, 0);
});

/* ---------- respaceMoves ---------- */

const rWeek = weekMeta('2030-01-09');          // 6.1–12.1.2030
const rChs = [1, 2].map((id) => ({ id, name: `ערוץ ${id}`, max_per_week: 7, urgent_reserve_pct: 0,
                                   blocked_days: [] }));
const rPost = (id, channel, date, status, x = {}) => ({
  id, title: `פוסט ${id}`, kind: 'value', status, scheduled_at: `${date}T10:00:00`,
  channel_id: channel, endpoint_id: 1, campaign_id: 5, campaign_min_gap_days: null,
  content_id: null, linked_to_id: null, campaign_links_apart: true, ...x,
});

test('respaceMoves — פוסט מקושר לא זז ליום שבו המקור (קבוע) יוצא בערוץ אחר', () => {
  // ערוץ 2 חוסם הכול חוץ מ-8.1 ו-10.1; המקור פורסם ב-8.1 בערוץ 1 → העוקבת ל-10.1
  const chs = [rChs[0], { ...rChs[1], blocked_days: [0, 1, 3, 5, 6] }];
  const posts = [
    rPost(1, 1, '2030-01-08', 'published', { content_id: 10 }),
    rPost(2, 2, '2030-01-09', 'scheduled', { content_id: 11, linked_to_id: 10 }),   // רביעי חסום
  ];
  const plan = respaceMoves({ week: rWeek, channels: chs, posts, settings: { min_gap_days: 0 },
                              onlyIllegal: true, today: '2030-01-06' });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].dateKey, '2030-01-10');

  // links_apart כבוי — 8.1 מותר (היום הפנוי הראשון בסדר של nextSlot, או 10.1)
  const off = respaceMoves({
    week: rWeek, channels: chs, settings: { min_gap_days: 0 }, onlyIllegal: true, today: '2030-01-06',
    posts: posts.map((p) => ({ ...p, campaign_links_apart: false })),
  });
  assert.equal(off.moves.length, 1);
  // רק 8.1 פתוח — העוקבת נשארת במקום כשהמקור שם
  const only8 = [rChs[0], { ...rChs[1], blocked_days: [0, 1, 3, 4, 5, 6] }];
  const stuck = respaceMoves({ week: rWeek, channels: only8, posts, settings: { min_gap_days: 0 },
                               onlyIllegal: true, today: '2030-01-06' });
  assert.equal(stuck.moves.length, 0);
  assert.deepEqual(stuck.stuck.map((s) => s.post.id), [2]);
  const stuckOff = respaceMoves({
    week: rWeek, channels: only8, settings: { min_gap_days: 0 }, onlyIllegal: true, today: '2030-01-06',
    posts: posts.map((p) => ({ ...p, campaign_links_apart: false })),
  });
  assert.equal(stuckOff.moves[0].dateKey, '2030-01-08');
});

/* ---------- fix-clashes ---------- */

test('planClashFixes — היום שנבחר לא יום שבו פוסט מקושר יוצא', () => {
  const p = (id, channel, date, x = {}) => ({
    id, endpoint_id: 1, channel_id: channel, scheduled_at: `${date}T10:00:00`, status: 'scheduled',
    kind: 'value', title: `פוסט ${id}`, endpoint_name: 'קורס', channel_name: 'פייסבוק',
    campaign_id: null, campaign_min_gap_days: null, content_id: null, linked_to_id: null,
    campaign_links_apart: true, ...x,
  });
  // התנגשות ב-8.1 בערוץ 1; השני (עוקבת של 10) זז. 9.1 תפוס במקור (ערוץ 2) → 10.1
  const posts = [p(1, 1, '2030-01-08'), p(2, 1, '2030-01-08', { content_id: 11, linked_to_id: 10 }),
                 p(3, 2, '2030-01-09', { content_id: 10 })];
  const r = planClashFixes(posts, { channels: [{ id: 1, blocked_days: [] }, { id: 2, blocked_days: [] }],
                                    settings: { min_gap_days: 0 }, today: '2030-01-06' });
  const to = r.groups[0].moves[0].to;
  assert.equal(to.getDate(), 10);
  const off = planClashFixes(posts.map((x) => ({ ...x, campaign_links_apart: false })),
    { channels: [{ id: 1, blocked_days: [] }, { id: 2, blocked_days: [] }],
      settings: { min_gap_days: 0 }, today: '2030-01-06' });
  assert.equal(off.groups[0].moves[0].to.getDate(), 9);
});
