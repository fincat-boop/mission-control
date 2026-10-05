import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekApprovalReason } from '../src/routes/publish.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');

/** פוסט פייסבוק מוכן לגמרי — כל בדיקה מקלקלת בו דבר אחד */
const ready = (post = {}, variant = {}) => ({
  post: {
    id: 1, title: 'פוסט', platform: 'facebook', channel_name: 'פייסבוק',
    access_token_enc: 'enc', page_id: '123', content_id: 9, auto_enabled: true,
    scheduled_at: '2026-10-07T09:00:00+03:00', ...post,
  },
  variant: { status: 'ready', body: 'טקסט', ...variant },
  assets: [],
});

test('weekApprovalReason — פוסט עתידי ומוכן מאושר', () => {
  assert.equal(weekApprovalReason(ready(), NOW), null);
});

test('weekApprovalReason — מועד שעבר מדולג לפני כל בדיקה אחרת', () => {
  const r = weekApprovalReason(ready({ scheduled_at: '2026-10-05T09:00:00+03:00', access_token_enc: null }), NOW);
  assert.equal(r, 'המועד עבר');
});

test('weekApprovalReason — הסיבה של publishBlocker חוזרת כמו שהיא', () => {
  assert.equal(weekApprovalReason(ready({}, { status: 'draft' }), NOW),
    'הגרסה למדיה הזו עוד לא מסומנת "מוכן"');
  assert.equal(weekApprovalReason(ready({ access_token_enc: null }), NOW),
    'אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום');
});

test('weekApprovalReason — שליחה אוטומטית כבויה לערוץ', () => {
  assert.match(weekApprovalReason(ready({ auto_enabled: false }), NOW), /השליחה האוטומטית כבויה/);
});
