import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_FILL_MAX_WEEKS, campaignFillWeeks, mergeFillResults, parseIdList, titleFromFilename,
} from '../src/routes/_shared.js';

test('parseIdList — מערך של מספרים', () => {
  assert.deepEqual(parseIdList([1, 2, 3]), [1, 2, 3]);
});

test('parseIdList — מסנן ערכים לא-מספריים ואפסים', () => {
  assert.deepEqual(parseIdList(['1', 'x', '0', '3']), [1, 3]);
});

test('parseIdList — מחרוזת JSON', () => {
  assert.deepEqual(parseIdList('[4,5]'), [4, 5]);
});

test('parseIdList — רשימה מופרדת בפסיקים', () => {
  assert.deepEqual(parseIdList('7, 8 ,9'), [7, 8, 9]);
});

test('parseIdList — ריק', () => {
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(null), []);
});

test('titleFromFilename — מסיר סיומת ומנקה מפרידים', () => {
  assert.equal(titleFromFilename('my_cool-post.png'), 'my cool post');
});

test('titleFromFilename — בלי סיומת נשאר כמו שהוא', () => {
  assert.equal(titleFromFilename('שלום'), 'שלום');
});

/* ---------- מילוי כל תקופת הקמפיין ---------- */

const camp = (over = {}) => ({ active: true, paused_at: null, starts_on: '2026-11-20',
                               ends_on: '2026-12-05', ...over });

test('campaignFillWeeks — כל שבוע שחופף לתקופה (ראשון עד שבת)', () => {
  // 20.11 (חמישי) עד 5.12 (שבת): שבועות 15.11, 22.11, 29.11
  assert.deepEqual(campaignFillWeeks(camp(), '2026-10-06'),
    ['2026-11-15', '2026-11-22', '2026-11-29']);
});

test('campaignFillWeeks — מתחיל מהיום כשהקמפיין כבר רץ', () => {
  assert.deepEqual(campaignFillWeeks(camp(), '2026-11-30'), ['2026-11-29']);
  assert.deepEqual(campaignFillWeeks(camp({ starts_on: null }), '2026-11-24'),
    ['2026-11-22', '2026-11-29']);
});

test('campaignFillWeeks — אין מה למלא: מושהה, לא פעיל, בלי סיום, נגמר, לא קיים', () => {
  assert.equal(campaignFillWeeks(camp({ paused_at: new Date() }), '2026-10-06'), null);
  assert.equal(campaignFillWeeks(camp({ active: false }), '2026-10-06'), null);
  assert.equal(campaignFillWeeks(camp({ ends_on: null }), '2026-10-06'), null);
  assert.equal(campaignFillWeeks(camp(), '2026-12-06'), null);
  assert.equal(campaignFillWeeks(null, '2026-10-06'), null);
});

test('campaignFillWeeks — תקרה של 26 שבועות', () => {
  const weeks = campaignFillWeeks(camp({ starts_on: '2026-10-06', ends_on: '2028-01-01' }), '2026-10-06');
  assert.equal(CAMPAIGN_FILL_MAX_WEEKS, 26);
  assert.equal(weeks.length, 26);
  assert.equal(weeks[0], '2026-10-04');
  assert.equal(weeks[25], '2027-03-28');
});

test('mergeFillResults — סכומים, רשימות מאוחדות, ובכמה שבועות נכתב משהו', () => {
  const w = (placed, attached, ids) => ({
    placed, attached, holes: 0, skipped: 1, dropped: [],
    created_ids: ids, created_items: ids.map((id) => ({ post_id: id, content_id: id * 10 })),
    attached_items: attached ? [{ post_id: 99 }] : [], summary: ids.map((id) => ({ title: `t${id}` })),
  });
  const m = mergeFillResults([w(2, 0, [1, 2]), w(0, 0, []), w(1, 1, [3])]);
  assert.equal(m.placed, 3);
  assert.equal(m.attached, 1);
  assert.equal(m.skipped, 3);
  assert.equal(m.weeks, 2);
  assert.deepEqual(m.created_ids, [1, 2, 3]);
  assert.deepEqual(m.created_items.map((x) => x.post_id), [1, 2, 3]);
  assert.equal(m.attached_items.length, 1);
  assert.equal(m.summary.length, 3);
});
