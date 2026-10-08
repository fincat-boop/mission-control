import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest } from '../src/publish/approval.js';
import { taskCloseReason } from '../src/task-lifecycle.js';

/** סעיף 31 — הטביעה של מה שאושר (טהורה) */
const v = (over = {}) => ({ status: 'ready', body: 'טקסט', meta: { first_comment: 'א', link: 'https://x' }, ...over });

test('approvalDigest — אותו תוכן, סדר מפתחות אחר ב-meta — אותה טביעה', () => {
  const a = approvalDigest({ variant: v(), assets: [{ id: 1 }, { id: 2 }] });
  const b = approvalDigest({ variant: v({ meta: { link: 'https://x', first_comment: 'א' } }),
                             assets: [{ id: '1' }, { id: 2 }] });
  assert.equal(a, b);
});

test('approvalDigest — טקסט, מצב, meta, קובץ נוסף או סדר קבצים אחר — טביעה אחרת', () => {
  const base = approvalDigest({ variant: v(), assets: [{ id: 1 }, { id: 2 }] });
  for (const other of [
    { variant: v({ body: 'טקסט אחר' }), assets: [{ id: 1 }, { id: 2 }] },
    { variant: v({ status: 'draft' }), assets: [{ id: 1 }, { id: 2 }] },
    { variant: v({ meta: { first_comment: 'ב', link: 'https://x' } }), assets: [{ id: 1 }, { id: 2 }] },
    { variant: v(), assets: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { variant: v(), assets: [{ id: 2 }, { id: 1 }] },
    { variant: null, assets: [{ id: 1 }, { id: 2 }] },
  ]) assert.notEqual(approvalDigest(other), base);
});

test('taskCloseReason — "לאשר מחדש": נסגרת באישור / פרסום / יממה אחרי המועד, לא לפני', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const t = (post_status, at) => ({ id: 1, kind: 'approve', post_id: 5, done: false, meta: { reapprove: true },
                                    post_status, post_scheduled_at: at });
  assert.equal(taskCloseReason(t('scheduled', '2026-10-08T11:00:00Z'), now), null);
  assert.equal(taskCloseReason(t('approved', '2026-10-10T11:00:00Z'), now), 'reapproved');
  assert.equal(taskCloseReason(t('published', '2026-10-08T11:00:00Z'), now), 'published');
  assert.equal(taskCloseReason(t('scheduled', '2026-10-06T11:00:00Z'), now), 'expired');
  assert.equal(taskCloseReason({ ...t('scheduled', null), post_status: null }, now), 'post_deleted');
  // משימת אישור רגילה (ממתין לאישור) — כמו קודם
  assert.equal(taskCloseReason({ ...t('scheduled', null), meta: null }, now), 'resolved');
});

test('taskCloseReason — "להעביר ל-HUB": הועבר / פורסם / הוזז / המועד הגיע', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const at = '2026-10-09T08:00:00Z';
  const t = (post_status, scheduled = at) => ({ id: 2, kind: 'approve', post_id: 7, done: false,
    meta: { hub_transfer: true, for_at: '2026-10-09T08:00:00+00:00' }, post_status, post_scheduled_at: scheduled });
  assert.equal(taskCloseReason(t('scheduled'), now), null);
  assert.equal(taskCloseReason(t('approved'), now), null);
  assert.equal(taskCloseReason(t('publishing'), now), 'resolved');
  assert.equal(taskCloseReason(t('failed'), now), 'resolved');
  assert.equal(taskCloseReason(t('published'), now), 'published');
  assert.equal(taskCloseReason(t('scheduled', '2026-10-09T10:00:00Z'), now), 'moved');
  assert.equal(taskCloseReason(t('scheduled'), new Date('2026-10-09T08:01:00Z')), 'expired');
});

test('isMissed / retryPending — מאושר שמחכה לניסיון חוזר לא "עבר המועד" עד אחרי הניסיון', async () => {
  const { isMissed, retryPending } = await import('../public/js/core/postActions.js');
  const now = new Date('2026-10-08T12:00:00Z');
  const p = { status: 'approved', scheduled_at: '2026-10-08T11:30:00Z', publish_retry_at: '2026-10-08T12:05:00Z' };
  assert.equal(retryPending(p, now), true);
  assert.equal(isMissed(p, now), false);
  assert.equal(isMissed({ ...p, publish_retry_at: null }, now), true);
  assert.equal(isMissed(p, new Date('2026-10-08T12:30:00Z')), true);
  assert.equal(retryPending(p, new Date('2026-10-08T12:30:00Z')), false);
});
