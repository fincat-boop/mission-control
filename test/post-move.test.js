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

test('approvalResetOnMove — מעבר ערוץ מבטל אישור, שינוי מועד לא', async () => {
  const { approvalResetOnMove } = await import('../src/routes/board.js');
  const p = post({ status: 'approved' });
  assert.equal(approvalResetOnMove(p, { scheduled_at: '2026-10-09T09:00:00+03:00' }), false);
  assert.equal(approvalResetOnMove(p, { channel_id: 6 }), false);
  assert.equal(approvalResetOnMove(p, { channel_id: '7' }), true);
  assert.equal(approvalResetOnMove(p, { title: 'x' }), false);
});
