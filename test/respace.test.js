import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onBlockedDay } from '../src/respace.js';

// 2026-08-14 = שישי (5), 2026-08-15 = שבת (6)
const friday = { scheduled_at: '2026-08-14T10:00:00' };
const saturday = { scheduled_at: '2026-08-15T10:00:00' };

test('onBlockedDay — יום שהערוץ חסם', () => {
  assert.equal(onBlockedDay(friday, { blocked_days: [5, 6] }), true);
  assert.equal(onBlockedDay(saturday, { blocked_days: [6] }), true);
});

test('onBlockedDay — יום פתוח', () => {
  assert.equal(onBlockedDay(friday, { blocked_days: [6] }), false);
  assert.equal(onBlockedDay(saturday, { blocked_days: [] }), false);
});

test('onBlockedDay — ערוץ בלי הגדרה בכלל לא חוסם', () => {
  assert.equal(onBlockedDay(saturday, {}), false);
  assert.equal(onBlockedDay(saturday, null), false);
});

import { readFileSync } from 'node:fs';
import { windowAllows } from '../src/respace.js';

// קמפיין מוכן בנובמבר, 6 פוסטים: השני מתוכנן ל-6.11
const completePost = (scheduledAt) => ({
  scheduled_at: scheduledAt, campaign_id: 7,
  campaign_starts_on: '2026-11-01', campaign_ends_on: '2026-11-30',
  campaign_complete_at: '2026-10-05T10:00:00Z', campaign_slot_rank: 2, campaign_slot_count: 6,
});

test('windowAllows — פוסט של קמפיין מוכן לא זז לפני התאריך המתוכנן שלו', () => {
  const p = completePost('2026-11-09T10:00:00');
  assert.equal(windowAllows(p, '2026-11-05'), false);   // לפני 6.11
  assert.equal(windowAllows(p, '2026-11-06'), true);
  assert.equal(windowAllows(p, '2026-11-12'), true);
  assert.equal(windowAllows(p, '2026-12-01'), false);   // אחרי סוף הקמפיין
  // קמפיין רגיל — רק החלון
  const normal = { ...p, campaign_complete_at: null };
  assert.equal(windowAllows(normal, '2026-11-02'), true);
});

test('planRespace שולף את עמודות "קמפיין מוכן" — אחרת הכלל לא חל בהזזה', () => {
  const src = readFileSync(new URL('../src/respace.js', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('export async function planRespace'), src.indexOf('const byId'));
  assert.match(q, /\$\{COMPLETE_SPREAD_COLUMNS\}/);
});

/* ---------- שלב 4: מרווח מול פוסטים קבועים באותו שבוע ---------- */

import { respaceMoves } from '../src/respace.js';
import { weekMeta } from '../src/board.js';

const rWeek = weekMeta('2030-01-09');          // 6.1–12.1.2030
const rCh = { id: 1, name: 'פייסבוק', max_per_week: 5, urgent_reserve_pct: 0, blocked_days: [] };
const rSettings = { min_gap_days: 7, max_promo_per_day: 1 };
const rPost = (id, date, status, x = {}) => ({
  id, title: `פוסט ${id}`, kind: 'value', status, scheduled_at: `${date}T10:00:00`,
  channel_id: 1, endpoint_id: 1, campaign_id: null, campaign_min_gap_days: null, ...x,
});

test('respaceMoves — פוסט קבוע באותו שבוע (פורסם) נכנס לבדיקת המרווח, לא רק לאותו יום', () => {
  // פורסם ב-9.1; במרווח 7 אין בשבוע יום שרחוק ממנו מספיק
  const posts = [rPost(1, '2030-01-09', 'published'), rPost(2, '2030-01-07', 'scheduled')];
  const plan = respaceMoves({ week: rWeek, channels: [rCh], posts, settings: rSettings,
                              today: '2030-01-06' });
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.stuck.map((s) => s.post.id), [2]);
});

test('respaceMoves — מרווח הקמפיין של הפוסט שזז, לשני הכיוונים, מול קבוע (יום חסום)', () => {
  // ממוקד: רק הפוסט על שישי החסום זז; הפוסט של 10.1 קבוע. מרווח הקמפיין 3:
  // 8, 9, 12 קרובים מדי ל-10 — נשארים 6 או 7
  const ch = { ...rCh, blocked_days: [5] };
  const posts = [
    rPost(1, '2030-01-10', 'scheduled'),
    rPost(2, '2030-01-11', 'scheduled', { campaign_id: 4, campaign_min_gap_days: 3 }),
  ];
  const plan = respaceMoves({ week: rWeek, channels: [ch], posts, settings: rSettings,
                              onlyIllegal: true, today: '2030-01-06' });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].post.id, 2);
  assert.ok(plan.moves[0].dateKey <= '2030-01-07', plan.moves[0].dateKey);
});

test('respaceMoves — פוסט על יום שעבר לא זז, והוא שכן לבדיקת המרווח', () => {
  const posts = [
    rPost(1, '2030-01-07', 'scheduled'),               // עבר (היום 9.1) — קבוע
    rPost(2, '2030-01-10', 'scheduled', { campaign_id: 4, campaign_min_gap_days: 3 }),
  ];
  const plan = respaceMoves({ week: rWeek, channels: [rCh], posts, settings: rSettings,
                              today: '2030-01-09' });
  assert.ok(plan.moves.every((m) => m.post.id !== 1));
  const m = plan.moves.find((x) => x.post.id === 2);
  assert.ok(m && m.dateKey >= '2030-01-10', m?.dateKey);   // 9.1 — רק יומיים מ-7.1
});

test('respaceMoves — השכנים מחוץ לשבוע לא משתנים (המפה של הקורא לא נדרסת)', () => {
  const neighbours = new Map([['1:1', ['2029-12-20']]]);
  respaceMoves({ week: rWeek, channels: [rCh], posts: [rPost(1, '2030-01-07', 'scheduled')],
                 settings: rSettings, neighbours, today: '2030-01-06' });
  assert.deepEqual(neighbours.get('1:1'), ['2029-12-20']);
});
