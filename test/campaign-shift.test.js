import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCampaignShift } from '../src/campaign-shift.js';

/**
 * planCampaignShift (טהורה): לאן כל פוסט של קמפיין שזז בזמן מגיע, או שהוא
 * יורד מהלוח כי המועד החדש לא עובר את הכללים של המנוע.
 */

// רביעי 20.11.2030, 14:30
const NOW = new Date('2030-11-20T14:30:00');
const CH = { id: 1, max_per_week: 7, urgent_reserve_pct: 0, blocked_days: [] };
const post = (id, when, o = {}) => ({
  id, channel_id: 1, endpoint_id: 1, content_id: 100 + id, kind: 'value', status: 'scheduled',
  scheduled_at: new Date(when).toISOString(), campaign_id: 9, ...o,
});
const plan = (moving, { fixed = [], days, channels = [CH], settings = { min_gap_days: 1 } }) =>
  planCampaignShift({ moving, fixed, channels, settings, days, now: NOW });
const local = (d) => `${d.getDate()}.${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

test('נוחת היום אחרי שהשעה עברה — השעה העגולה הבאה; יום שעבר — יורד', () => {
  const { moves, drops } = plan(
    [post(1, '2030-11-22T10:00:00'), post(2, '2030-11-21T10:00:00')], { days: -2 });
  // 22.11 → 20.11 (היום, 10:00 עבר) → 15:00 היום; 21.11 → 19.11 (עבר) → יורד
  assert.deepEqual(moves.map((m) => [m.post.id, local(m.at)]), [[1, '20.11 15:00']]);
  assert.deepEqual(drops.map((p) => p.id), [2]);
});

test('היום אחרי 22:00 — אין שעה פנויה, יורד', () => {
  const late = planCampaignShift({
    moving: [post(1, '2030-11-21T10:00:00')], fixed: [], channels: [CH],
    settings: { min_gap_days: 1 }, days: -1, now: new Date('2030-11-20T22:30:00'),
  });
  assert.equal(late.moves.length, 0);
  assert.equal(late.drops.length, 1);
});

test('מרווח של הקמפיין מול פוסט של אותה נקודה מחוץ לקמפיין', () => {
  const fixed = [post(50, '2030-11-27T10:00:00', { campaign_id: 8, content_id: 500 })];
  // מרווח 3: 22.11 → 25.11 רחוק יומיים מ-27.11 — לא עובר; 19.11 → 22.11 רחוק 5 — עובר
  const moving = [
    post(1, '2030-11-22T10:00:00', { campaign_min_gap_days: 3 }),
    post(2, '2030-11-19T10:00:00', { campaign_min_gap_days: 3 }),
  ];
  const { moves, drops } = plan(moving, { fixed, days: 3 });
  assert.deepEqual(moves.map((m) => m.post.id), [2]);
  assert.deepEqual(drops.map((p) => p.id), [1]);
});

test('פוסטים מקושרים (links_apart): לא ליום שבו כבר יוצא פריט אחר מהקבוצה', () => {
  // מקור 600 יוצא ב-25.11 בערוץ אחר; העוקבת שלו זזה ל-25.11 — יורדת
  const fixed = [post(60, '2030-11-25T12:00:00', { channel_id: 2, endpoint_id: 2, content_id: 600 })];
  const linked = post(1, '2030-11-22T10:00:00', { linked_to_id: 600 });
  const ch2 = { ...CH, id: 2 };
  assert.equal(plan([linked], { fixed, days: 3, channels: [CH, ch2] }).drops.length, 1);
  // הקמפיין ביקש לא להפריד — זז
  const free = plan([{ ...linked, campaign_links_apart: false }], { fixed, days: 3, channels: [CH, ch2] });
  assert.equal(free.moves.length, 1);
});

test('תקרה שבועית: ערוץ מלא בשבוע החדש — יורד; שעה תפוסה — השעה הבאה', () => {
  const small = { ...CH, max_per_week: 2 };
  const fixed = [
    post(70, '2030-11-24T10:00:00', { endpoint_id: 3, content_id: 700 }),
    post(71, '2030-11-26T10:00:00', { endpoint_id: 4, content_id: 701 }),
  ];
  const full = plan([post(1, '2030-11-22T10:00:00')], { fixed, days: 3, channels: [small] });
  assert.equal(full.drops.length, 1);
  // יש מקום — אותו יום ושעה של נקודה אחרת: 11:00
  const roomy = plan([post(1, '2030-11-21T10:00:00')], { fixed, days: 3 });
  assert.equal(roomy.moves.length, 1);
  assert.equal(local(roomy.moves[0].at), '24.11 11:00');
});

test('מחוץ לחלון החדש של הקמפיין — יורד', () => {
  const moving = [post(1, '2030-11-22T10:00:00',
    { campaign_starts_on: '2030-11-21', campaign_ends_on: '2030-11-24' })];
  assert.equal(plan(moving, { days: 3 }).drops.length, 1);
  assert.equal(plan(moving, { days: 1 }).moves.length, 1);
});

test('סבב 3: ההזזה מכבדת את המרווח המפורש של שכן קבוע (pairGap)', () => {
  // הפוסט זז יום קדימה ל-25.11; שכן קבוע ב-23.11 של קמפיין שביקש 7 — יורד
  const fixed = [post(9, '2030-11-23T10:00:00', { content_id: 500, campaign_id: 5,
                                                   campaign_min_gap_days: 7 })];
  const { moves, drops } = plan([post(1, '2030-11-24T10:00:00', { campaign_min_gap_days: 1 })],
    { fixed, days: 1 });
  assert.deepEqual(moves, []);
  assert.deepEqual(drops.map((p) => p.id), [1]);
  // שכן בלי מרווח מפורש — רק המרווח של הפוסט (1): נכנס
  const ok = plan([post(1, '2030-11-24T10:00:00', { campaign_min_gap_days: 1 })],
    { fixed: [post(9, '2030-11-23T10:00:00', { content_id: 500, campaign_id: null })], days: 1 });
  assert.equal(ok.moves.length, 1);
});
