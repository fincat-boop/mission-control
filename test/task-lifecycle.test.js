import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoAssignee, suppressTaskedAlerts, taskCloseReason } from '../src/task-lifecycle.js';
import { approveTaskBlocked, groupTasks, isSnoozed } from '../src/routes/tasks.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const HOUR = 3600000;
const at = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();
const task = (kind, post = {}, extra = {}) => ({
  id: 1, kind, done: false, post_id: 9, meta: null,
  post_status: 'scheduled', post_content_id: null, post_scheduled_at: at(5),
  ...post, ...extra,
});

/* ========================= taskCloseReason ========================= */

test('write/swap — נסגרת כשלפוסט יש תוכן, כשפורסם, או יממה אחרי המועד', () => {
  for (const kind of ['write', 'swap']) {
    assert.equal(taskCloseReason(task(kind), NOW), null);
    assert.equal(taskCloseReason(task(kind, { post_content_id: 4 }), NOW), 'has_content');
    assert.equal(taskCloseReason(task(kind, { post_status: 'published' }), NOW), 'published');
    assert.equal(taskCloseReason(task(kind, { post_scheduled_at: at(-23) }), NOW), null);
    assert.equal(taskCloseReason(task(kind, { post_scheduled_at: at(-25) }), NOW), 'expired');
  }
});

test('publish (וואטסאפ) — נסגרת כשפורסם או יממה אחרי; משימת פרסום ידנית ישנה נשארת', () => {
  const wa = { meta: { wa_send: true } };
  assert.equal(taskCloseReason(task('publish', {}, wa), NOW), null);
  assert.equal(taskCloseReason(task('publish', { post_status: 'published' }, wa), NOW), 'published');
  assert.equal(taskCloseReason(task('publish', { post_scheduled_at: at(-25) }, wa), NOW), 'expired');
  // בלי wa_send — לא נוגעים
  assert.equal(taskCloseReason(task('publish', { post_status: 'published' }), NOW), null);
});

test('failed — נסגרת כשפורסם, כשאושר שוב למועד עתידי, או כשהפוסט נמחק', () => {
  assert.equal(taskCloseReason(task('failed', { post_status: 'failed' }), NOW), null);
  assert.equal(taskCloseReason(task('failed', { post_status: 'published' }), NOW), 'published');
  assert.equal(taskCloseReason(task('failed', { post_status: 'approved', post_scheduled_at: at(2) }), NOW),
    'reapproved');
  // אושר אבל למועד שעבר — עוד לא פתור
  assert.equal(taskCloseReason(task('failed', { post_status: 'approved', post_scheduled_at: at(-2) }), NOW),
    null);
  assert.equal(taskCloseReason(task('failed', { post_status: null }), NOW), 'post_deleted');
});

test('approve — נסגרת ברגע שהפוסט כבר לא ממתין לאישור', () => {
  assert.equal(taskCloseReason(task('approve', { post_status: 'pending_approval' }), NOW), null);
  assert.equal(taskCloseReason(task('approve', { post_status: 'scheduled' }), NOW), 'resolved');
});

test('general, משימה בלי פוסט, או משימה סגורה — לעולם לא נסגרות לבד', () => {
  assert.equal(taskCloseReason(task('general', { post_status: 'published' }), NOW), null);
  assert.equal(taskCloseReason(task('write', { post_content_id: 3 }, { post_id: null }), NOW), null);
  assert.equal(taskCloseReason(task('write', { post_content_id: 3 }, { done: true }), NOW), null);
});

/* ========================= autoAssignee ========================= */

test('autoAssignee — משימת פוסט בלי אחראי מקבלת את האחראי של הפוסט, פעם אחת', () => {
  const t = { kind: 'write', done: false, assignee_id: null, post_assignee_id: 7, meta: null };
  assert.equal(autoAssignee(t), 7);
  assert.equal(autoAssignee({ ...t, kind: 'publish' }), 7);
  assert.equal(autoAssignee({ ...t, assignee_id: 3 }), null);              // כבר משויכת
  assert.equal(autoAssignee({ ...t, post_assignee_id: null }), null);      // לפוסט אין אחראי
  assert.equal(autoAssignee({ ...t, meta: { assignee_auto: true } }), null); // שיוך ידני הוסר — לא חוזר
  assert.equal(autoAssignee({ ...t, kind: 'approve' }), null);
});

/* ========================= סימן אחד לכל פוסט ========================= */

test('suppressTaskedAlerts — אישור/בלי טקסט מוסתרים כשיש משימה פתוחה; כשל נשאר', () => {
  const alerts = [
    { id: 'approval-1', post_id: 1 },
    { id: 'approval-2', post_id: 2 },
    { id: 'no-text-3', post_id: 3 },
    { id: 'no-text-4', post_id: 4 },
    { id: 'post-failed-5', post_id: 5 },
    { id: 'storage' },
  ];
  const open = [
    { post_id: 1, kind: 'approve' },
    { post_id: 3, kind: 'write' },
    { post_id: 4, kind: 'approve' }, // סוג לא תואם — ההתראה נשארת
    { post_id: 5, kind: 'failed' },
  ];
  assert.deepEqual(suppressTaskedAlerts(alerts, open).map((a) => a.id),
    ['approval-2', 'no-text-4', 'post-failed-5', 'storage']);
});

/* ========================= דחייה ========================= */

test('groupTasks — משימה שנדחתה יוצאת מהיום/דורש טיפול ומהמונה, ונכנסת ל"נדחו"', () => {
  const all = [
    { id: 1, done: false, due_on: '2026-10-05' },
    { id: 2, done: false, due_on: '2026-10-05', snoozed_until: at(10) },
    { id: 3, done: false, due_on: null, snoozed_until: at(-1) }, // הדחייה נגמרה
  ];
  const g = groupTasks(all, { today: '2026-10-05', weekStart: '2026-10-04', now: NOW });
  assert.deepEqual(g.today.map((t) => t.id), [1]);
  assert.deepEqual(g.attention.map((t) => t.id), [3]);
  assert.deepEqual(g.snoozed.map((t) => t.id), [2]);
  assert.equal(g.open_count, 2);
  assert.equal(isSnoozed({ done: true, snoozed_until: at(5) }, NOW), false);
});

test('approveTaskBlocked — גם דחייה של משימת אישור דורשת הרשאת אישור', () => {
  const content = { is_owner: false, perm_approve: false };
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { snoozed_until: at(5) }, content), true);
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { snoozed_until: at(5) }, { perm_approve: true }), false);
  assert.equal(approveTaskBlocked({ kind: 'write' }, { snoozed_until: at(5) }, content), false);
});
