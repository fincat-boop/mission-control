import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waTaskAction } from '../src/publish/runner.js';
import { endpointAirStatus, failedPostAlerts, missedPostAlerts } from '../src/alerts.js';

/* ========================= משימת וואטסאפ: מה עושים ========================= */

test('waTaskAction — אין משימה: יוצרים, גם כשהטקסט לא מוכן', () => {
  assert.equal(waTaskAction({ ready: true, task_id: null }), 'insert');
  assert.equal(waTaskAction({ ready: false, task_id: null }), 'insert');
});

test('waTaskAction — משימה פתוחה שמצב המוכנות שלה השתנה: מעדכנים', () => {
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: false, task_ready: false }), 'update');
  // משימה ישנה בלי הדגל — מקבלת את הכותרת המשנית הנוכחית
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: false, task_ready: null }), 'update');
});

test('waTaskAction — משימה פתוחה במצב הנכון, או משימה שנסגרה: כלום', () => {
  assert.equal(waTaskAction({ ready: false, task_id: 5, task_done: false, task_ready: false }), null);
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: true, task_ready: false }), null);
});

/* ========================= התראות: כשל, החמצה, נקודה חדשה ========================= */

test('failedPostAlerts — חוסם, id יציב, קישור לפוסט, השגיאה בפירוט', () => {
  const [a] = failedPostAlerts([{
    id: 22, title: 'בלאק פריידי', channel_name: 'פייסבוק',
    scheduled_at: '2026-10-05T12:00:00Z', publish_error: 'אין חיבור',
  }]);
  assert.equal(a.id, 'post-failed-22');
  assert.equal(a.level, 'crit');
  assert.equal(a.title, 'פרסום נכשל: בלאק פריידי');
  assert.equal(a.post_id, 22);
  assert.equal(a.tab, 'board');
  assert.match(a.detail, /פייסבוק · .* · אין חיבור$/);
});

test('missedPostAlerts — דורש טיפול, id יציב, קישור לפוסט', () => {
  const [a] = missedPostAlerts([{ id: 18, title: 'כרטיס', channel_name: 'וואטסאפ', scheduled_at: '2026-10-05T07:00:00Z' }]);
  assert.equal(a.id, 'post-missed-18');
  assert.equal(a.level, 'warn');
  assert.equal(a.title, 'עבר המועד ולא פורסם: כרטיס');
  assert.equal(a.post_id, 18);
});

test('endpointAirStatus — נקודה חדשה בלי פוסטים לא מתריעה לפני שעבר הקצב שלה', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ep = { min_days_between: 7, importance: 5, last_at: null };
  assert.equal(endpointAirStatus({ ...ep, created_at: '2026-10-09T12:00:00Z' }, now), null);
  assert.equal(endpointAirStatus({ ...ep, created_at: '2026-10-03T12:00:00Z' }, now), null); // בדיוק 7
  assert.deepEqual(endpointAirStatus({ ...ep, created_at: '2026-10-01T12:00:00Z' }, now),
    { days_since: null, days_over: 9 });
});

test('endpointAirStatus — נקודה שפרסמה נמדדת מהפרסום האחרון, לא מהיצירה', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ep = { min_days_between: 7, importance: 5, created_at: '2025-01-01T00:00:00Z' };
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-08T12:00:00Z' }, now), null);
  assert.deepEqual(endpointAirStatus({ ...ep, last_at: '2026-09-30T12:00:00Z' }, now),
    { days_since: 10, days_over: 10 });
});
