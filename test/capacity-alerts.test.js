import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generalGridFor, paceDone, paceOf } from '../src/campaigns.js';
import { campaignAlerts } from '../src/alerts.js';

/**
 * התראות "חסר תוכן" ו"מפגר אחרי הקצב" נשענות על הקיבולת (שלב 1) — מה
 * שהמנוע באמת יכול לשבץ — ולא מבקשות לכתוב תוכן שלא יוכל להיכנס.
 */

const row = (x) => ({
  id: 3, name: 'פנסיה', phase: 'running', starts_on: '2030-01-01', ends_on: '2030-01-30',
  missing_content: 0, missing_ahead: 0, total_ahead: 0, required: 10, complete: false,
  pace: null, unplaced: 0, unpublished_ready: 0, ...x,
});

test('חסר תוכן — נספר מהיום והלאה: שורות שעברו לא מבקשות תוכן', () => {
  // 29 חסרים ברשת, אבל כולם בשורות שעברו — אין מה לכתוב
  assert.deepEqual(campaignAlerts([row({ missing_content: 29, missing_ahead: 0 })], '2030-01-15'), []);
  const [a] = campaignAlerts([row({ missing_content: 29, missing_ahead: 14, total_ahead: 14 })],
                             '2030-01-15');
  assert.equal(a.id, 'campaign-content-3');
  assert.equal(a.detail, 'הקמפיין רץ וחסרים לו 14 פוסטים מתוך 14 שנשארו עד הסוף');
});

test('חסר תוכן — קמפיין מוכן: כל הטיוטות (גם בשורה שעברה — עוד יכולה לצאת עד הסוף)', () => {
  const [a] = campaignAlerts([row({ complete: true, missing_content: 2, missing_ahead: 0 })],
                             '2030-01-15');
  assert.match(a.title, /^טיוטות לסיום/);
  assert.match(a.detail, /2 פוסטים עדיין בטיוטה \(מתוך 10\)/);
});

test('paceOf — היעד הוא הנדרש ברשת, כלומר הקיבולת (המרווח מגביל), לא הקצב של הערוץ', () => {
  // 30 יום, ערוץ של 5 בשבוע: הקצב "רוצה" ~21, המרווח (7) מכניס 5
  const c = { id: 3, endpoint_id: 1, endpoint_importance: 5, active: true, structure: 'general',
              starts_on: '2030-01-01', ends_on: '2030-01-30', channel_ids: [1] };
  const ch = { id: 1, name: 'פייסבוק', max_per_week: 5, urgent_reserve_pct: 20, blocked_days: [] };
  const grid = generalGridFor(c, [], [ch], '2030-01-15', [c], { gapDays: 7 });
  assert.equal(grid.total_cells, 5);
  const pace = paceOf(c, '2030-01-15', 1, grid);
  assert.equal(pace.expected_by_now, 2);   // floor(5 × 15/30)
  assert.equal(pace.behind, 1);
  const [a] = campaignAlerts([row({ pace })], '2030-01-15');
  assert.equal(a.id, 'campaign-pace-3');
  assert.match(a.detail, /לפי המקום שיש לקמפיין בערוצים היו אמורים לצאת עד היום 2 פוסטים, יצאו 1/);
  // אין מקום בכלל (רשת 0) — אין קצב לפגר אחריו
  assert.equal(paceOf(c, '2030-01-15', 0, { total_cells: 0 }), null);
});

test('paceDone — מה שפורסם ומה שלא אושר שיצא נספרים "יצאו"; ניוזלטר/ערוץ מושבת/חסד/נכשל — לא', () => {
  const now = new Date('2030-01-15T12:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const channels = new Map([
    [1, { id: 1, active: true, platform: 'facebook' }],
    [2, { id: 2, active: true, platform: 'newsletter' }],
    [3, { id: 3, active: false, platform: 'manual' }],
  ]);
  const posts = [
    { status: 'published', channel_id: 1, scheduled_at: ago(60 * 48) },
    { status: 'scheduled', channel_id: 1, scheduled_at: ago(60 * 24) },  // לא אושר שיצא
    { status: 'approved', channel_id: 1, scheduled_at: ago(60) },        // לא אושר שיצא
    { status: 'scheduled', channel_id: 1, scheduled_at: ago(10) },       // חצי שעה חסד
    { status: 'scheduled', channel_id: 2, scheduled_at: ago(60 * 24) },  // ניוזלטר
    { status: 'scheduled', channel_id: 3, scheduled_at: ago(60 * 24) },  // ערוץ מושבת
    { status: 'failed', channel_id: 1, scheduled_at: ago(60 * 24) },
    { status: 'pending_approval', channel_id: 1, scheduled_at: ago(60 * 24) },
  ];
  assert.equal(paceDone(posts, channels, now), 3);
});
