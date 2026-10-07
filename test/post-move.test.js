import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMove, moveBlocker } from '../src/routes/board.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');
const post = (over = {}) => ({
  id: 1, status: 'scheduled', channel_id: 6, scheduled_at: '2026-10-07T09:00:00+03:00', ...over,
});

test('isMove — שליחת אותו מועד ואותו ערוץ אינה הזזה', () => {
  const p = post();
  assert.equal(isMove(p, { scheduled_at: '2026-10-07T06:00:00.000Z', channel_id: 6 }), false);
  assert.equal(isMove(p, { title: 'כותרת חדשה' }), false);
});

test('isMove — מועד אחר או ערוץ אחר הם הזזה', () => {
  const p = post();
  assert.equal(isMove(p, { scheduled_at: '2026-10-08T09:00:00+03:00' }), true);
  assert.equal(isMove(p, { channel_id: 7 }), true);
  assert.equal(isMove(p, { channel_id: '7' }), true);
});

test('moveBlocker — פוסט שפורסם או בשליחה לא זז (409)', () => {
  const when = '2026-10-08T09:00:00+03:00';
  assert.equal(moveBlocker(post({ status: 'published' }), when, NOW).status, 409);
  assert.equal(moveBlocker(post({ status: 'publishing' }), when, NOW).status, 409);
});

test('moveBlocker — הזזה לזמן שעבר נחסמת (400)', () => {
  const r = moveBlocker(post(), '2026-10-05T11:59:00+03:00', NOW);
  assert.equal(r.status, 400);
  assert.equal(r.error, 'אי אפשר להזיז פוסט לזמן שעבר');
});

test('moveBlocker — מתוכנן / מאושר / נכשל לעתיד — מותר', () => {
  const when = '2026-10-08T09:00:00+03:00';
  for (const status of ['scheduled', 'approved', 'failed']) {
    assert.equal(moveBlocker(post({ status }), when, NOW), null);
  }
  // פוסט שהמועד שלו עבר מוזז קדימה — זה בדיוק התיקון שרוצים לאפשר
  assert.equal(moveBlocker(post({ scheduled_at: '2026-10-01T09:00:00+03:00' }), when, NOW), null);
});

test('approvalResetOnChange — ערוץ, תוכן או נקודה אחרים מבטלים אישור; מועד/כותרת לא', async () => {
  const { approvalResetOnChange } = await import('../src/routes/board.js');
  const p = post({ status: 'approved', content_id: 5, endpoint_id: 4 });
  assert.equal(approvalResetOnChange(p, { scheduled_at: '2026-10-09T09:00:00+03:00' }), false);
  assert.equal(approvalResetOnChange(p, { channel_id: 6 }), false);
  assert.equal(approvalResetOnChange(p, { channel_id: '7' }), true);
  assert.equal(approvalResetOnChange(p, { title: 'x', assignee_id: 2 }), false);
  // החלפת תוכן (משימת swap) או נקודת קצה
  assert.equal(approvalResetOnChange(p, { content_id: 5 }), false);
  assert.equal(approvalResetOnChange(p, { content_id: 9 }), true);
  assert.equal(approvalResetOnChange(p, { content_id: null }), true);
  assert.equal(approvalResetOnChange(p, { endpoint_id: '4' }), false);
  assert.equal(approvalResetOnChange(p, { endpoint_id: 6 }), true);
});

test('channelChangeBlocker — ערוץ פעיל, ניסוח שאינו "לא רלוונטי", משבצת-מדיה בערוץ שלה', async () => {
  const { channelChangeBlocker } = await import('../src/routes/board.js');
  const target = { name: 'אינסטגרם', active: true };
  const item = { id: 5, slot_channel_id: null };
  assert.equal(channelChangeBlocker({ target, item, variant: { status: 'ready' } }, 7), null);
  assert.equal(channelChangeBlocker({ target, item, variant: { status: 'draft' } }, 7), null);
  // פוסט בלי תוכן — רק הערוץ נבדק
  assert.equal(channelChangeBlocker({ target, item: null, variant: null }, 7), null);
  assert.equal(channelChangeBlocker({ target: null, item, variant: null }, 7).status, 404);
  assert.equal(channelChangeBlocker({ target: { ...target, active: false }, item: null }, 7).status, 409);
  assert.match(channelChangeBlocker({ target, item, variant: null }, 7).error, /אין לתוכן הזה גרסה/);
  assert.match(channelChangeBlocker({ target, item, variant: { status: 'not_relevant' } }, 7).error, /לא רלוונטי/);
  assert.match(channelChangeBlocker({ target, item: { id: 5, slot_channel_id: 6 }, variant: { status: 'ready' } }, 7).error,
    /משבצת של ערוץ אחר/);
});

test('publishingBlocker — פוסט שבדרך לפלטפורמה לא נערך ולא נמחק; פורסם/מתוכנן — אין חסימה', async () => {
  const { publishingBlocker } = await import('../src/routes/board.js');
  assert.match(publishingBlocker(post({ status: 'publishing' })), /מתפרסם ממש עכשיו/);
  assert.match(publishingBlocker(post({ status: 'publishing', hub_transferred_at: '2026-10-05T09:00:00Z' })),
    /הועבר ל-HUB/);
  for (const status of ['scheduled', 'approved', 'failed', 'published']) {
    assert.equal(publishingBlocker(post({ status })), null);
  }
});
