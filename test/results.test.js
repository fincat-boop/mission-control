import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markTop, mergeResult, summarize, upsertSql, validateBatch, MAX_BATCH,
} from '../src/results.js';
import { presetRange, isPreset } from '../public/js/core/dataPeriod.js';

const post = (o) => ({
  channel_id: 1, channel_name: 'פייסבוק', endpoint_id: 1, endpoint_name: 'אתר',
  kind: 'value', campaign_id: null, campaign_name: null,
  reach: null, engagement: null, clicks: null, leads: null, ...o,
});

/* ---------- צבירה ---------- */

test('summarize — ריק אינו אפס: לא בסכום ולא במכנה של הממוצע', () => {
  const s = summarize([
    post({ reach: 100, leads: 2 }),
    post({ reach: 300, leads: null }),   // לידים לא נמדדו — לא נכנס לממוצע הלידים
    post({}),                            // פוסט בלי שום מדידה
  ]);
  assert.equal(s.totals.posts, 3);
  assert.equal(s.totals.measured, 2);
  assert.equal(s.totals.measured_pct, 67);
  assert.equal(s.totals.reach, 400);
  assert.equal(s.totals.avg_reach, 200);
  assert.equal(s.totals.leads, 2);
  assert.equal(s.totals.avg_leads, 2);         // 2/1 ולא 2/3
  assert.equal(s.totals.clicks, null);         // אין אף מדידה — null, לא 0
  assert.equal(s.totals.avg_clicks, null);
});

test('summarize — אפס מפורש הוא מדידה', () => {
  const s = summarize([post({ leads: 0 }), post({ leads: 4 })]);
  assert.equal(s.totals.measured, 2);
  assert.equal(s.totals.avg_leads, 2);
});

test('summarize — ארבעה פילוחים, "בלי קמפיין" בסוף', () => {
  const s = summarize([
    post({ campaign_id: null }),
    post({ campaign_id: 7, campaign_name: 'השקה', kind: 'promo', channel_id: 2, channel_name: 'וואטסאפ' }),
    post({ campaign_id: 7, campaign_name: 'השקה', kind: 'hybrid', endpoint_id: null, endpoint_name: null }),
  ]);
  assert.deepEqual(s.by_campaign.rows.map((r) => r.name), ['השקה', 'בלי קמפיין']);
  assert.deepEqual(s.by_kind.rows.map((r) => r.name).sort(), ['ערך', 'מכירתי', 'משולב'].sort());
  assert.equal(s.by_channel.rows.length, 2);
  assert.equal(s.by_endpoint.rows.at(-1).name, 'בלי נקודת קצה');
});

test('summarize — תקופה ריקה', () => {
  const s = summarize([]);
  assert.equal(s.totals.posts, 0);
  assert.equal(s.totals.measured_pct, 0);
  assert.deepEqual(s.by_channel.rows, []);
  assert.equal(s.by_channel.top_metric, null);
});

/* ---------- "הכי טוב" ---------- */

const row = (name, o) => ({ name, avg_leads: null, avg_clicks: null, avg_engagement: null,
  leads: null, clicks: null, engagement: null, ...o });

test('markTop — לפי ממוצע לידים, לא לפי סכום', () => {
  const list = [row('גדול', { avg_leads: 1, leads: 20 }), row('יעיל', { avg_leads: 3, leads: 6 })];
  assert.deepEqual(markTop(list), { metric: 'leads' });
  assert.deepEqual(list.map((r) => r.top), [false, true]);
});

test('markTop — אין לידים בכלל: קליקים, ואז מעורבות', () => {
  const a = [row('א', { avg_clicks: 2 }), row('ב', { avg_clicks: 5 })];
  assert.equal(markTop(a).metric, 'clicks');
  assert.equal(a[1].top, true);

  const b = [row('א', { avg_engagement: 9 }), row('ב', { avg_engagement: 4 })];
  assert.equal(markTop(b).metric, 'engagement');
  assert.equal(b[0].top, true);
});

test('markTop — לידים כולם אפס נחשבים "אין במה להשוות"', () => {
  const list = [row('א', { avg_leads: 0, avg_clicks: 1 }), row('ב', { avg_leads: 0, avg_clicks: 3 })];
  assert.equal(markTop(list).metric, 'clicks');
  assert.equal(list[1].top, true);
});

test('markTop — שורה אחת עם מדידה אינה "הכי טוב"; בלי מדידות אין סימון', () => {
  const one = [row('א', { avg_leads: 5 }), row('ב', {})];
  assert.equal(markTop(one).metric, null);
  assert.ok(one.every((r) => !r.top));
  assert.equal(markTop([row('א', {}), row('ב', {})]).metric, null);
});

test('markTop — שוויון בממוצע: הסכום מכריע', () => {
  const list = [row('א', { avg_leads: 2, leads: 2 }), row('ב', { avg_leads: 2, leads: 8 })];
  markTop(list);
  assert.equal(list[1].top, true);
});

/* ---------- ולידציה של שמירה מרוכזת ---------- */

const statuses = new Map([[1, 'published'], [2, 'published'], [3, 'scheduled']]);

test('validateBatch — ריק = null, מספרים מעוגלים, הערה נחתכת; רק שדות שנשלחו', () => {
  const { ok, errors } = validateBatch(
    [{ post_id: 1, reach: '120', engagement: '', leads: 0, note: '  טוב  ' }],
    statuses);
  assert.deepEqual(errors, []);
  // clicks לא נשלח — לא מופיע ב-set ולא יידרס
  assert.deepEqual(ok, [{ post_id: 1, set: { reach: 120, engagement: null, leads: 0, note: 'טוב' } }]);
});

/* ---------- מיזוג עדכון חלקי ---------- */

test('mergeResult — מה שנשלח גובר, השאר נשאר מהמסד', () => {
  const existing = { reach: 500, engagement: 40, clicks: 7, leads: 2, note: 'ישן' };
  const { row, clear } = mergeResult(existing, { leads: 5 });
  assert.deepEqual(row, { reach: 500, engagement: 40, clicks: 7, leads: 5, note: 'ישן' });
  assert.equal(clear, false);
});

test('mergeResult — ריקון שדה אחד מוחק רק אותו', () => {
  const existing = { reach: 500, engagement: null, clicks: 7, leads: null, note: null };
  const { row, clear } = mergeResult(existing, { clicks: null });
  assert.deepEqual(row, { reach: 500, engagement: null, clicks: null, leads: null, note: null });
  assert.equal(clear, false);
});

test('mergeResult — clear רק כשהמצב המלא אחרי המיזוג ריק', () => {
  // ריקון השדה היחיד שהיה — נמחק
  assert.equal(mergeResult({ reach: 500, engagement: null, clicks: null, leads: null, note: null },
    { reach: null }).clear, true);
  // ריקון שדה כשנשארו אחרים — לא נמחק
  assert.equal(mergeResult({ reach: 500, engagement: 3, clicks: null, leads: null, note: null },
    { reach: null }).clear, false);
  // הערה בלבד מחזיקה את השורה
  assert.equal(mergeResult({ reach: 1, engagement: null, clicks: null, leads: null, note: 'x' },
    { reach: null }).clear, false);
  // אין שורה קיימת ונשלח רק ריק — אין מה לשמור
  assert.equal(mergeResult(null, { reach: null, note: null }).clear, true);
  // אין שורה קיימת: מה שלא נשלח הוא null, לא 0
  assert.deepEqual(mergeResult(undefined, { clicks: 4 }).row,
    { reach: null, engagement: null, clicks: 4, leads: null, note: null });
});

test('upsertSql — בהתנגשות מתעדכנים רק השדות שנשלחו', () => {
  const sql = upsertSql({ leads: 5, note: null });
  assert.match(sql, /do update set leads = excluded\.leads, note = excluded\.note, updated_at = now\(\)/);
  assert.doesNotMatch(sql, /reach = excluded/);
  // מפתח זר בבקשה לא נכנס לשאילתה
  assert.doesNotMatch(upsertSql({ leads: 1, 'x; drop table posts': 1 }), /drop/);
});

test('validateBatch — שגיאה לכל שורה בעייתית, עם האינדקס שלה', () => {
  const { ok, errors } = validateBatch([
    { post_id: 1, reach: 5 },                 // תקינה
    { post_id: 2, reach: -1 },                // שלילי
    { post_id: 3, reach: 5 },                 // לא פורסם
    { post_id: 99, reach: 5 },                // לא קיים
    { post_id: 'abc' },                       // מזהה לא תקין
    { post_id: 1, leads: 'שלוש' },            // כפול + לא מספר
  ], statuses);
  assert.equal(ok.length, 1);
  assert.deepEqual(errors.map((e) => e.index), [1, 2, 3, 4, 5]);
  assert.match(errors[0].error, /אי-שליליים/);
  assert.match(errors[1].error, /שפורסם/);
  assert.match(errors[2].error, /לא נמצא/);
  assert.match(errors[4].error, /פעמיים/);
});

test('validateBatch — גוף ריק או גדול מדי', () => {
  assert.equal(validateBatch([], statuses).errors[0].index, -1);
  assert.equal(validateBatch(undefined, statuses).errors.length, 1);
  const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ post_id: i + 1 }));
  assert.match(validateBatch(big, statuses).errors[0].error, /עד/);
});

/* ---------- תקופות ---------- */

test('presetRange — החודש / החודש הקודם לפי שעון ישראל', () => {
  // 1.10.2026 00:30 בישראל = 30.9 21:30 UTC — כבר אוקטובר
  const now = new Date('2026-09-30T21:30:00Z');
  assert.deepEqual(presetRange('this_month', now), { from: '2026-10-01', to: '2026-10-01' });
  assert.deepEqual(presetRange('prev_month', now), { from: '2026-09-01', to: '2026-09-30' });
  // ינואר → דצמבר של השנה הקודמת; פברואר מעוברת
  assert.deepEqual(presetRange('prev_month', new Date('2027-01-15T10:00:00Z')),
    { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(presetRange('prev_month', new Date('2028-03-10T10:00:00Z')),
    { from: '2028-02-01', to: '2028-02-29' });
});

test('presetRange — N ימים כולל היום; ערך לא מוכר', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  assert.deepEqual(presetRange('14', now), { from: '2026-09-22', to: '2026-10-05' });
  assert.deepEqual(presetRange('1', now), { from: '2026-10-05', to: '2026-10-05' });
  assert.equal(presetRange('abc', now), null);
  assert.equal(isPreset('custom'), false);
  assert.equal(isPreset('prev_month'), true);
  assert.equal(isPreset('15'), false);
});

/* ---------- תקרת int ---------- */

test('parseMetric — מעל 2147483647 נדחה, התקרה עצמה עוברת', async () => {
  const { parseMetric, METRIC_MAX } = await import('../src/performance.js');
  assert.equal(parseMetric(String(METRIC_MAX)), METRIC_MAX);
  assert.throws(() => parseMetric('2147483648'), /גדול מדי/);
  assert.throws(() => parseMetric(1e12), /גדול מדי/);
  // ובשמירה המרוכזת — שגיאה לשורה, לא 500
  const { errors } = validateBatch([{ post_id: 1, reach: '99999999999' }], statuses);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 0);
  assert.match(errors[0].error, /גדול מדי/);
});
