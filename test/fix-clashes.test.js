import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planClashFixes } from '../src/fix-clashes.js';

/**
 * fix-clashes (CLI): רק מהיום והלאה, רק מתוכנן/מאושר זז, לא ליום חסום,
 * ובמרווח של הקמפיין של הפוסט מהשכן הקרוב.
 */

const today = '2030-01-06';
const p = (id, date, status = 'scheduled', x = {}) => ({
  id, endpoint_id: 1, channel_id: 1, scheduled_at: `${date}T10:00:00`, status, kind: 'value',
  title: `פוסט ${id}`, endpoint_name: 'קורס', channel_name: 'פייסבוק', campaign_id: null,
  campaign_min_gap_days: null, ...x,
});
const ch = (blocked = []) => [{ id: 1, blocked_days: blocked }];
const day = (m) => `${m.to.getFullYear()}-${String(m.to.getMonth() + 1).padStart(2, '0')}-${
  String(m.to.getDate()).padStart(2, '0')}`;

test('planClashFixes — המוקדם נשאר, השני זז למרווח הכללי מהשכן הקרוב', () => {
  const { groups, moves } = planClashFixes([p(1, '2030-01-08'), p(2, '2030-01-08')],
    { channels: ch(), settings: { min_gap_days: 7 }, today });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].stay.map((x) => x.id), [1]);
  assert.equal(moves.length, 1);
  assert.equal(day(groups[0].moves[0]), '2030-01-15');
  assert.equal(groups[0].moves[0].to.getHours(), 10);   // אותה שעה
});

test('planClashFixes — פורסם / בפרסום / נכשל / ממתין לאישור לא זזים', () => {
  const a = planClashFixes([p(1, '2030-01-08', 'published'), p(2, '2030-01-08')],
    { channels: ch(), settings: { min_gap_days: 7 }, today });
  assert.deepEqual(a.moves.map((m) => m.id), [2]);
  assert.deepEqual(a.groups[0].stay.map((x) => x.id), [1]);
  const b = planClashFixes([p(1, '2030-01-08', 'failed'), p(2, '2030-01-08', 'publishing'),
                            p(3, '2030-01-08', 'pending_approval')],
    { channels: ch(), settings: { min_gap_days: 7 }, today });
  assert.equal(b.moves.length, 0);
});

test('planClashFixes — נכשל שהמועד שלו עבר לא תופס את היום (takesRoom); עוד לפניו — תופס', () => {
  const now = new Date('2030-01-08T12:00:00');
  const past = planClashFixes([p(1, '2030-01-08', 'failed'), p(2, '2030-01-08', 'scheduled',
    { scheduled_at: '2030-01-08T16:00:00' })],
  { channels: ch(), settings: { min_gap_days: 7 }, now, today: '2030-01-08' });
  assert.deepEqual(past, { groups: [], moves: [] });
  const ahead = planClashFixes([p(1, '2030-01-09', 'failed'), p(2, '2030-01-09')],
    { channels: ch(), settings: { min_gap_days: 7 }, now, today: '2030-01-08' });
  assert.deepEqual(ahead.moves.map((m) => m.id), [2]);
});

test('planClashFixes — התנגשות ביום שעבר לא נוגעים בה', () => {
  const r = planClashFixes([p(1, '2030-01-03'), p(2, '2030-01-03')],
    { channels: ch(), settings: { min_gap_days: 7 }, today });
  assert.deepEqual(r, { groups: [], moves: [] });
});

test('planClashFixes — לא ליום חסום', () => {
  // רביעי 9.1; חמישי (4) חסום → שישי
  const r = planClashFixes([p(1, '2030-01-09'), p(2, '2030-01-09')],
    { channels: ch([4]), settings: { min_gap_days: 0 }, today });
  assert.equal(day(r.groups[0].moves[0]), '2030-01-11');
});

test('planClashFixes — המרווח של הקמפיין של הפוסט, ומול שכן קיים אחרי', () => {
  const camp = { campaign_id: 5, campaign_min_gap_days: 3 };
  // שכן ב-12.1: 9.1 ו-10.1 רחוקים 3 ימים מ-8.1 אבל 10.1 קרוב ל-12.1 → 9.1
  const r = planClashFixes([p(1, '2030-01-06'), p(2, '2030-01-06', 'scheduled', camp),
                            p(3, '2030-01-12')],
    { channels: ch(), settings: { min_gap_days: 7 }, today });
  assert.equal(day(r.groups[0].moves[0]), '2030-01-09');
  // מרווח שלא נכנס בשבועיים — נשאר ומדווח
  const stuck = planClashFixes([p(1, '2030-01-08'), p(2, '2030-01-08')],
    { channels: ch(), settings: { min_gap_days: 20 }, today });
  assert.equal(stuck.moves.length, 0);
  assert.deepEqual(stuck.groups[0].stuck.map((x) => x.id), [2]);
});

test('planClashFixes — לא יוצא מחלון הקמפיין (windowAllows, כמו respace)', () => {
  const camp = { campaign_id: 5, campaign_starts_on: '2030-01-01', campaign_ends_on: '2030-01-10' };
  const r = planClashFixes([p(1, '2030-01-10'), p(2, '2030-01-10', 'scheduled', camp)],
    { channels: ch(), settings: { min_gap_days: 0 }, today });
  assert.equal(r.moves.length, 0);
  assert.deepEqual(r.groups[0].stuck.map((x) => x.id), [2]);
  // קמפיין מוכן: לא לפני התאריך המתוכנן (פריט 4 מתוך 6 ב-1.11–30.11 → 16.11)
  const done = { campaign_id: 6, campaign_starts_on: '2030-11-01', campaign_ends_on: '2030-11-30',
                 campaign_complete_at: '2030-10-01T10:00:00Z', campaign_slot_rank: 4,
                 campaign_slot_count: 6 };
  const late = planClashFixes([p(1, '2030-11-12'), p(2, '2030-11-12', 'scheduled', done)],
    { channels: ch(), settings: { min_gap_days: 0 }, today });
  // 12.11 עצמו כבר לפני התאריך המתוכנן — פוסט שיושב מחוץ לחלון לא ננעל (כמו respace)
  assert.equal(day(late.groups[0].moves[0]), '2030-11-13');
  const inside = planClashFixes([p(1, '2030-11-16'), p(2, '2030-11-16', 'scheduled', done)],
    { channels: ch(), settings: { min_gap_days: 0 }, today });
  assert.equal(day(inside.groups[0].moves[0]), '2030-11-17');
});

test('planClashFixes — max_promo_per_day בכל הערוצים', () => {
  const promo = { kind: 'promo' };
  const r = planClashFixes([
    p(1, '2030-01-08', 'scheduled', promo), p(2, '2030-01-08', 'scheduled', promo),
    p(3, '2030-01-09', 'scheduled', { ...promo, endpoint_id: 2, channel_id: 2 }),
  ], { channels: [...ch(), { id: 2, blocked_days: [] }],
       settings: { min_gap_days: 0, max_promo_per_day: 1 }, today });
  assert.equal(day(r.groups[0].moves[0]), '2030-01-10');
  // ערך לא נספר במכסת המכירתי — נכנס ל-9.1
  const v = planClashFixes([
    p(1, '2030-01-08'), p(2, '2030-01-08'),
    p(3, '2030-01-09', 'scheduled', { ...promo, endpoint_id: 2, channel_id: 2 }),
  ], { channels: [...ch(), { id: 2, blocked_days: [] }],
       settings: { min_gap_days: 0, max_promo_per_day: 1 }, today });
  assert.equal(day(v.groups[0].moves[0]), '2030-01-09');
});

test('planClashFixes — שעה תפוסה בערוץ: השעה הפנויה הבאה; יום מלא עד 22 — היום הבא', () => {
  // פוסטים של נקודות אחרות באותו ערוץ — תופסים שעות, לא מתנגשים
  const other = (id, hour) => ({ ...p(id, '2030-01-09', 'scheduled', { endpoint_id: id }),
                                 scheduled_at: `2030-01-09T${String(hour).padStart(2, '0')}:00:00` });
  const r = planClashFixes([p(1, '2030-01-08'), p(2, '2030-01-08'), other(3, 10)],
    { channels: ch(), settings: { min_gap_days: 0 }, today });
  const m = r.groups[0].moves[0];
  assert.equal(day(m), '2030-01-09');
  assert.equal(m.to.getHours(), 11);
  const full = Array.from({ length: 13 }, (_, i) => other(10 + i, 10 + i));   // 10:00–22:00
  const f = planClashFixes([p(1, '2030-01-08'), p(2, '2030-01-08'), ...full],
    { channels: ch(), settings: { min_gap_days: 0 }, today });
  assert.equal(f.groups.length, 1);
  assert.equal(day(f.groups[0].moves[0]), '2030-01-10');
});

test('planClashFixes — סבב 3: מכבד את המרווח המפורש של השכן (pairGap), לא רק את שלו', () => {
  // שני פוסטים ב-8.1 (הזז — קמפיין מרווח 1), ושכן ב-10.1 של קמפיין שביקש 5:
  // 9.1 ו-11–14.1 קרובים לשכן — הראשון הפנוי הוא 15.1
  const posts = [p(1, '2030-01-08'), p(2, '2030-01-08', 'scheduled', { campaign_id: 3, campaign_min_gap_days: 1 }),
                 p(3, '2030-01-10', 'scheduled', { campaign_id: 4, campaign_min_gap_days: 5 })];
  const { groups } = planClashFixes(posts, { channels: ch(), settings: { min_gap_days: 1 }, today });
  assert.equal(day(groups[0].moves[0]), '2030-01-15');
});
