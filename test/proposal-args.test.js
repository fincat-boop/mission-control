import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeArgs, fmtWhen } from '../public/js/core/proposalArgs.js';

const lookup = {
  channels: [{ id: 1, name: 'פייסבוק' }, { id: 2, name: 'ניוזלטר' }],
  endpoints: [{ id: 3, name: 'כרטיס אשראי' }],
  campaigns: [{ id: 7, name: 'בלאק פריידי' }],
  users: [{ id: 4, name: 'דנה' }],
};

test('מזהים מוחלפים בשמות; מזהה שלא נמצא נשאר #מזהה', () => {
  assert.deepEqual(describeArgs({ channel_id: 2, endpoint_id: 3, campaign_id: 99 }, lookup), [
    ['ערוץ', 'ניוזלטר'], ['נקודת קצה', 'כרטיס אשראי'], ['קמפיין', '#99'],
  ]);
  assert.deepEqual(describeArgs({ channel_ids: [1, 2] }, lookup), [['ערוצים', 'פייסבוק, ניוזלטר']]);
  assert.deepEqual(describeArgs({ assignee_id: 4 }, lookup), [['אחראי', 'דנה']]);
});

test('סוג, מצב, ימים חסומים ובוליאני — בעברית', () => {
  assert.deepEqual(describeArgs({ kind: 'promo', status: 'ready', blocked_days: [5, 6], active: false }), [
    ['סוג', 'מכירתי'], ['מצב', 'מוכן'], ['ימים חסומים', 'שישי, שבת'], ['פעיל', 'לא'],
  ]);
});

test('תאריך בלי שעה ומועד עם שעה (שעון מקומי)', () => {
  assert.equal(fmtWhen('2026-10-07'), '7.10.2026');
  const local = new Date(2026, 9, 7, 10, 5); // יום רביעי
  assert.equal(fmtWhen(local.toISOString()), 'יום רביעי 7.10.2026 · 10:05');
  assert.equal(fmtWhen('לא תאריך'), 'לא תאריך');
});

test('פוסט — כותרת אם ידועה, אחרת #מזהה; מפתח לא מוכר נשאר כמו שהוא', () => {
  assert.deepEqual(describeArgs({ post_id: 22 }), [['פוסט', '#22']]);
  assert.deepEqual(describeArgs({ post_id: 22 }, { postTitle: 'השקה' }), [['פוסט', 'השקה (#22)']]);
  assert.deepEqual(describeArgs({ weird: { a: 1 } }), [['weird', '{"a":1}']]);
  assert.deepEqual(describeArgs({ share_pct: 20, min_gap_days: 3 }), [['נתח', '20%'], ['מרווח בין פוסטים', '3 ימים']]);
});
