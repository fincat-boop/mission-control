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
