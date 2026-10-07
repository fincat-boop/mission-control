import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, unplacedOf, unpublishedReady } from '../src/campaigns.js';
import { campaignAlerts } from '../src/alerts.js';

/**
 * תוכן שלא ייכנס עד סוף הקמפיין (שלב 4, ממצא 6): unplacedOf סופר גרסאות
 * בלי פוסט מול המקום שנשאר מהיום עד הסוף, ו-campaignAlerts מתריע עליהן.
 * קמפיין שהסתיים — גרסאות מוכנות שלא פורסמו, עד שבועיים אחרי הסוף.
 */

// ערוץ: תקרה 5, 20% לדחופים → תקציב 4 בשבוע. מרווח ברירת מחדל 7.
const ch = { id: 10, name: 'פייסבוק', max_per_week: 5, urgent_reserve_pct: 20, blocked_days: [] };
const ch2 = { id: 11, name: 'אינסטגרם', max_per_week: 5, urgent_reserve_pct: 20, blocked_days: [] };
// שבועיים: במרווח 7 נכנסים 2 פוסטים בכל ערוץ
const camp = {
  id: 1, endpoint_id: 1, endpoint_importance: 5, active: true, paused_at: null, share_pct: null,
  starts_on: '2030-01-06', ends_on: '2030-01-19', channel_ids: [10, 11],
};
const item = (id, variants, extra = {}) => ({
  id, slot_channel_id: null,
  variants: Object.entries(variants).map(([channel_id, status]) =>
    ({ channel_id: Number(channel_id), status })),
  ...extra,
});
const post = (content_id, channel_id, status, scheduled_at) =>
  ({ content_id, channel_id, status, scheduled_at });

test('unplacedOf — גרסאות בלי פוסט מעבר למקום שנשאר: unplaced; מה שנכנס: waiting', () => {
  const items = [1, 2, 3, 4].map((id) => item(id, { 10: 'ready' }));
  const r = unplacedOf(camp, items, [ch], [], [camp], { gapDays: 7, today: '2030-01-06' });
  assert.deepEqual(r.by_channel[10], { without: 4, free: 2, unplaced: 2 });
  assert.equal(r.waiting, 2);
  assert.equal(r.unplaced, 2);
});

test('unplacedOf — פוסט קיים: התוכן שלו לא נספר, והוא תופס מקום בחלון שנשאר', () => {
  const items = [1, 2, 3, 4].map((id) => item(id, { 10: 'ready' }));
  const posts = [post(1, 10, 'scheduled', '2030-01-08T10:00:00')];
  const r = unplacedOf(camp, items, [ch], posts, [camp], { gapDays: 7, today: '2030-01-06' });
  assert.deepEqual(r.by_channel[10], { without: 3, free: 1, unplaced: 2 });
});

test('unplacedOf — טיוטה נספרת (המנוע משבץ גם טיוטה); לא רלוונטי, משבצת של ערוץ אחר — לא', () => {
  const items = [
    item(1, { 10: 'draft' }),
    item(2, { 10: 'not_relevant' }),
    item(3, { 10: 'ready' }, { slot_channel_id: 11 }),   // משבצת של אינסטגרם
    item(4, { 11: 'ready' }, { slot_channel_id: 11 }),
  ];
  const r = unplacedOf(camp, items, [ch, ch2], [], [camp], { gapDays: 7, today: '2030-01-06' });
  assert.equal(r.by_channel[10].without, 1);
  assert.equal(r.by_channel[11].without, 1);
  assert.equal(r.unplaced, 0);
  assert.equal(r.waiting, 2);
});

test('unplacedOf — פוסט שנכשל נחשב "יש פוסט" (המנוע לא ישבץ שוב), ולא תופס מקום', () => {
  const items = [1, 2, 3].map((id) => item(id, { 10: 'ready' }));
  // נכשל הבוקר — לא עלה לאוויר, המקום שלו פנוי (takesRoom, כמו במנוע)
  const posts = [post(1, 10, 'failed', '2030-01-06T08:00:00')];
  const now = new Date('2030-01-06T12:00:00');
  const r = unplacedOf(camp, items, [ch], posts, [camp], { gapDays: 7, now, today: '2030-01-06' });
  assert.deepEqual(r.by_channel[10], { without: 2, free: 2, unplaced: 0 });
  // נכשל שהמועד שלו עוד לפניו (נדיר) — תופס מקום כמו קודם, כמו במנוע
  const ahead = [post(1, 10, 'failed', '2030-01-07T10:00:00')];
  const r2 = unplacedOf(camp, items, [ch], ahead, [camp], { gapDays: 7, now, today: '2030-01-06' });
  assert.deepEqual(r2.by_channel[10], { without: 2, free: 1, unplaced: 1 });
});

test('unplacedOf — באמצע הקמפיין נמדד רק מה שנשאר: שבוע אחרון = מקום לפוסט אחד', () => {
  const items = [1, 2, 3].map((id) => item(id, { 10: 'ready' }));
  // פוסט שכבר יצא בשבוע הראשון לא תופס מקום בחלון שנשאר
  const posts = [post(1, 10, 'published', '2030-01-07T10:00:00')];
  const r = unplacedOf(camp, items, [ch], posts, [camp], { gapDays: 7, today: '2030-01-13' });
  assert.deepEqual(r.by_channel[10], { without: 2, free: 1, unplaced: 1 });
});

test('unplacedOf — קמפיין מתוכנן נמדד מההתחלה שלו; בלי תאריכים או אחרי הסוף — 0', () => {
  const items = [1, 2, 3].map((id) => item(id, { 10: 'ready' }));
  const early = unplacedOf(camp, items, [ch], [], [camp], { gapDays: 7, today: '2029-12-01' });
  assert.equal(early.unplaced, 1);
  const open = unplacedOf({ ...camp, ends_on: null }, items, [ch], [], [], { today: '2030-01-06' });
  assert.deepEqual(open, { unplaced: 0, waiting: 0, by_channel: {} });
  const over = unplacedOf(camp, items, [ch], [], [camp], { today: '2030-02-01' });
  assert.deepEqual(over, { unplaced: 0, waiting: 0, by_channel: {} });
});

test('unplacedOf — מרווח קצר יותר בקמפיין = יותר מקום (אותו חשבון כמו הרשת)', () => {
  const items = [1, 2, 3, 4].map((id) => item(id, { 10: 'ready' }));
  const tight = { ...camp, min_gap_days: 3 };
  const r = unplacedOf(tight, items, [ch], [], [tight], { gapDays: 7, today: '2030-01-06' });
  assert.equal(r.unplaced, 0);
});

test('unpublishedReady — מוכן שלא פורסם ואין לו פוסט שעוד יוצא; טיוטה לא נספרת', () => {
  const items = [
    item(1, { 10: 'ready' }),     // פורסם
    item(2, { 10: 'ready' }),     // פוסט שהמועד שלו עבר ולא יצא — נספר
    item(3, { 10: 'ready' }),     // בלי פוסט — נספר
    item(4, { 10: 'draft' }),     // טיוטה — לא
    item(5, { 10: 'ready' }),     // יוצא בעתיד — לא
  ];
  const now = new Date('2030-01-25T12:00:00');
  const posts = [
    post(1, 10, 'published', '2030-01-10T10:00:00'),
    post(2, 10, 'scheduled', '2030-01-15T10:00:00'),
    post(5, 10, 'scheduled', '2030-01-27T10:00:00'),
  ];
  assert.equal(unpublishedReady(items, [ch], posts, now), 2);
});

const row = (x) => ({
  id: 7, name: 'סתיו', phase: 'running', starts_on: '2030-01-06', ends_on: '2030-01-19',
  missing_content: 0, missing_ahead: 0, total_ahead: 0, required: 4, complete: false,
  pace: null, unplaced: 0, waiting: 0, unpublished_ready: 0, ...x,
});

test('campaignAlerts — "תוכן שלא ייכנס": warn, עם התאריך, פותח את הקמפיין', () => {
  const [a] = campaignAlerts([row({ unplaced: 3 })], '2030-01-08');
  assert.equal(a.id, 'campaign-unplaced-7');
  assert.equal(a.level, 'warn');
  assert.equal(a.title, 'תוכן שלא ייכנס: סתיו');
  assert.match(a.detail, /^3 פוסטים לא ייכנסו עד סוף הקמפיין \(19\.1\.2030\)/);
  assert.match(a.detail, /להאריך, לדחוס את המרווח או להסיר/);
  assert.equal(a.tab, 'plan');
  assert.equal(a.campaign_id, 7);
  // גם בקמפיין מתוכנן, וגם יחד עם חסר תוכן
  const both = campaignAlerts([row({ phase: 'upcoming', starts_on: '2030-01-10', unplaced: 1,
                                     missing_content: 2, missing_ahead: 2, total_ahead: 4 })],
                              '2030-01-08');
  assert.deepEqual(both.map((x) => x.id), ['campaign-content-7', 'campaign-unplaced-7']);
  assert.match(both[1].detail, /^פוסט אחד לא ייכנס/);
  // מושהה — בלי רעש
  assert.deepEqual(campaignAlerts([row({ phase: 'paused', unplaced: 3 })], '2030-01-08'), []);
});

test('campaignAlerts — קמפיין שהסתיים: info על מוכן שלא פורסם, עד שבועיים אחרי הסוף', () => {
  const ended = row({ phase: 'ended', unpublished_ready: 4, unplaced: 9 });
  const [a] = campaignAlerts([ended], '2030-01-25');
  assert.equal(a.id, 'campaign-leftover-7');
  assert.equal(a.level, 'info');
  assert.equal(a.title, '4 פוסטים מוכנים של סתיו לא פורסמו');
  assert.equal(a.campaign_id, 7);
  assert.equal(campaignAlerts([ended], '2030-02-02').length, 1);   // 14 ימים — עוד מופיע
  assert.deepEqual(campaignAlerts([ended], '2030-02-03'), []);    // 15 — נעלם
  assert.deepEqual(campaignAlerts([{ ...ended, unpublished_ready: 0 }], '2030-01-25'), []);
});

test('statusOf — תוכן שלא ייכנס: סיבה בתג (tooltip), בלי מצב חדש', () => {
  const c = { active: true, starts_on: '2030-01-06', ends_on: '2030-01-19' };
  const grid = { missing: 0, total_cells: 4, ready: 4 };
  const st = statusOf({ c, today: '2030-01-08', grid, myChannels: [ch],
                        ahead: { missing: 0, total: 2 }, unplaced: 2 });
  assert.equal(st.key, 'full');
  assert.equal(st.reason, '2 פוסטים לא ייכנסו עד סוף הקמפיין');
  // עם סיבה קיימת (אין מקום) — מצטרף אליה
  const room = statusOf({ c, today: '2030-01-08', grid, myChannels: [ch],
                          noRoom: 'אין מקום', unplaced: 1 });
  assert.equal(room.reason, 'אין מקום · פוסט אחד לא ייכנס עד סוף הקמפיין');
  // בלי unplaced — בלי סיבה
  assert.equal(statusOf({ c, today: '2030-01-08', grid, myChannels: [ch] }).reason, undefined);
});

test('unplacedOf — ערוץ לא פעיל או נקודת קצה לא פעילה: אין מקום, הכול לא ייכנס', () => {
  const items = [1, 2].map((id) => item(id, { 10: 'ready', 11: 'ready' }));
  const off = { ...ch2, active: false };
  const r = unplacedOf(camp, items, [ch, off], [], [camp], { gapDays: 7, today: '2030-01-06' });
  assert.deepEqual(r.by_channel[10], { without: 2, free: 2, unplaced: 0 });
  assert.deepEqual(r.by_channel[11], { without: 2, free: 0, unplaced: 2 });
  assert.equal(r.waiting, 2);
  const asleep = { ...camp, endpoint_active: false };
  const e = unplacedOf(asleep, items, [ch, ch2], [], [asleep], { gapDays: 7, today: '2030-01-06' });
  assert.equal(e.waiting, 0);
  assert.equal(e.unplaced, 4);
});
