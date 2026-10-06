import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('fix-clashes — CLI לארגון אחד (withOrg, --org), יבש כברירת מחדל', () => {
  const src = readFileSync(new URL('../src/fix-clashes.js', import.meta.url), 'utf8');
  assert.match(src, /withOrg\(orgId/);
  assert.match(src, /argv\.includes\('--yes'\)/);
  // אין שאילתה ברמת המודול (קודם רץ בייבוא, על כל הארגונים)
  assert.match(src, /if \(runAsCli\)/);
});
