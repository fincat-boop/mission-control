import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_SUB_NOT_READY, MANUAL_SUB_READY, MANUAL_SUB_TITLE_ONLY, WA_SUB_READY, localHour,
  publishTaskSubtitle, publishTaskTitle, waTaskAction,
} from '../src/publish/runner.js';
import { endpointAirStatus, failedPostAlerts } from '../src/alerts.js';
import { unconfirmedAlert } from '../src/unconfirmed.js';
import { approveTaskBlocked, groupTasks, isUrgentTask, localYmd } from '../src/routes/tasks.js';

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

test('משימת "לפרסם היום" — כותרת לפי הערוץ, כותרת משנית לפי מצב הטקסט', () => {
  assert.equal(publishTaskTitle({ platform: 'whatsapp', title: 'כרטיס', channel_name: 'קבוצה' }),
    'לשלוח בוואטסאפ: כרטיס');
  assert.equal(publishTaskTitle({ platform: 'facebook', title: 'כרטיס', channel_name: 'פייסבוק' }),
    'לפרסם היום בפייסבוק: כרטיס');
  assert.equal(publishTaskSubtitle({ platform: 'whatsapp', ready: true, content_id: 1 }), WA_SUB_READY);
  assert.equal(publishTaskSubtitle({ platform: 'instagram', ready: true, content_id: 1 }), MANUAL_SUB_READY);
  assert.equal(publishTaskSubtitle({ platform: 'instagram', ready: false, content_id: 1 }), MANUAL_SUB_NOT_READY);
  // מבצע דחוף — כותרת בלבד בכוונה, לא "הטקסט לא מוכן"
  assert.equal(publishTaskSubtitle({ platform: 'facebook', ready: false, content_id: null, urgent: true }),
    MANUAL_SUB_TITLE_ONLY);
});

test('localHour — השעה בישראל, לא לפי TZ של התהליך', () => {
  assert.equal(localHour(new Date('2026-10-05T02:59:00Z')), 5);  // 05:59 בישראל (UTC+3)
  assert.equal(localHour(new Date('2026-10-05T03:00:00Z')), 6);
  assert.equal(localHour(new Date('2026-12-05T04:00:00Z')), 6);  // חורף, UTC+2
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

test('unconfirmedAlert — התראה מרוכזת אחת, דורש טיפול, רק למי שיכול לסמן', () => {
  assert.deepEqual(unconfirmedAlert([]), []);
  const [one] = unconfirmedAlert([{ id: 18 }]);
  assert.equal(one.title, 'פוסט אחד לא סומן כפורסם');
  const all = unconfirmedAlert([{ id: 18 }, { id: 19 }, { id: 20 }]);
  assert.equal(all.length, 1);
  const [a] = all;
  assert.equal(a.id, 'unconfirmed');
  assert.equal(a.level, 'warn');
  assert.equal(a.title, '3 פוסטים לא סומנו כפורסמו');
  assert.equal(a.action, 'unconfirmed');
  assert.equal(a.perm, 'content');
  assert.equal(a.post_id, undefined);
});

test('endpointAirStatus — נקודה חדשה בלי פוסטים לא מתריעה לפני שעבר הקצב שלה', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  // חשיבות 9 → round(60/9) = 7 ימים
  const ep = { importance: 9, last_at: null };
  assert.equal(endpointAirStatus({ ...ep, created_at: '2026-10-09T12:00:00Z' }, now), null);
  assert.equal(endpointAirStatus({ ...ep, created_at: '2026-10-03T12:00:00Z' }, now), null); // בדיוק 7
  assert.deepEqual(endpointAirStatus({ ...ep, created_at: '2026-10-01T12:00:00Z' }, now),
    { days_since: null, days_over: 9, level: 'warn' });
});

test('endpointAirStatus — נקודה שפרסמה נמדדת מהפרסום האחרון, לא מהיצירה', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ep = { importance: 9, created_at: '2025-01-01T00:00:00Z' };
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-08T12:00:00Z' }, now), null);
  assert.deepEqual(endpointAirStatus({ ...ep, last_at: '2026-09-30T12:00:00Z' }, now),
    { days_since: 10, days_over: 10, level: 'warn' });
});

test('endpointAirStatus — כיול: מעל הקצב warn, פי שניים crit, ושקט כשפוסט מתוכנן בתוך הקצב', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const ep = { importance: 9, created_at: '2025-01-01T00:00:00Z' }; // קצב 7
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-12T12:00:00Z' }, now).level, 'warn'); // 8
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-07T12:00:00Z' }, now).level, 'warn'); // 13
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-06T12:00:00Z' }, now).level, 'crit'); // 14
  // פוסט חי מתוכנן בעוד 5 ימים (בתוך הקצב) — בדרך, אין התראה
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-01T12:00:00Z',
                                   next_at: '2026-10-25T12:00:00Z' }, now), null);
  // מתוכנן רק בעוד 10 ימים — עדיין מתריעים
  assert.equal(endpointAirStatus({ ...ep, last_at: '2026-10-01T12:00:00Z',
                                   next_at: '2026-10-30T12:00:00Z' }, now).level, 'crit');
});

/* ========================= תאריך מקומי וקבוצות המשימות ========================= */

test('localYmd — התאריך בישראל, לא ב-UTC ולא לפי TZ של התהליך', () => {
  // 22:30 UTC בקיץ = 01:30 למחרת בישראל (UTC+3)
  assert.equal(localYmd(new Date('2026-10-05T22:30:00Z')), '2026-10-06');
  assert.equal(localYmd(new Date('2026-10-05T20:59:00Z')), '2026-10-05');
  // חורף (UTC+2): 22:30 UTC = 00:30 למחרת
  assert.equal(localYmd(new Date('2026-12-31T22:30:00Z')), '2027-01-01');
});

test('groupTasks — היום / דורש טיפול / הושלם השבוע / מונה פתוחות', () => {
  const all = [
    { id: 1, done: false, due_on: '2026-10-05' },
    { id: 2, done: false, due_on: '2026-10-03' },
    { id: 3, done: false, due_on: null },
    { id: 4, done: true, due_on: '2026-10-05', done_at: '2026-10-05T08:00:00Z' },
    { id: 5, done: true, due_on: '2026-09-28', done_at: '2026-09-30T08:00:00Z' }, // שבוע שעבר
  ];
  const g = groupTasks(all, { today: '2026-10-05', weekStart: '2026-10-04' });
  assert.deepEqual(g.today.map((t) => t.id), [1]);
  assert.deepEqual(g.attention.map((t) => t.id), [2, 3]);
  assert.deepEqual(g.done_this_week.map((t) => t.id), [4]);
  assert.equal(g.open_count, 3);
});

test('groupTasks — "בקרוב" נפרד מ"דורש טיפול" ולא נספר בתגית; פג תוקף ≠ הושלם', () => {
  const all = [
    { id: 1, kind: 'general', done: false, due_on: '2026-10-05' },
    { id: 2, kind: 'write', done: false, due_on: '2026-10-09' },             // בקרוב
    { id: 3, kind: 'approve', done: false, due_on: null, scheduled_at: '2026-10-07T09:00:00Z' }, // לפי הפוסט
    { id: 4, kind: 'approve', done: false, due_on: null, scheduled_at: '2026-10-04T09:00:00Z' }, // באיחור
    { id: 5, kind: 'publish', done: true, due_on: '2026-10-04', done_at: '2026-10-05T01:00:00Z',
      meta: { publish_day: true, auto_closed: 'expired' } },
    { id: 6, kind: 'publish', done: true, due_on: '2026-10-05', done_at: '2026-10-05T09:00:00Z',
      meta: { publish_day: true, auto_closed: 'published' } },
  ];
  const g = groupTasks(all, { today: '2026-10-05', weekStart: '2026-10-04' });
  assert.deepEqual(g.today.map((t) => t.id), [1]);
  assert.deepEqual(g.attention.map((t) => t.id), [4]);
  assert.deepEqual(g.upcoming.map((t) => t.id).sort(), [2, 3]);
  assert.equal(g.open_count, 2);
  assert.deepEqual(g.done_this_week.map((t) => t.id), [6]);
  assert.deepEqual(g.expired_this_week.map((t) => t.id), [5]);
});

test('isUrgentTask — משימת מערכת דחופה רק היום/באיחור; ידנית — כמו שסומנה', () => {
  const today = '2026-10-05';
  assert.equal(isUrgentTask({ kind: 'swap', urgent: true, due_on: '2026-10-08' }, today), false);
  assert.equal(isUrgentTask({ kind: 'write', urgent: true, due_on: '2026-10-05' }, today), true);
  assert.equal(isUrgentTask({ kind: 'publish', urgent: false, due_on: '2026-10-05' }, today), true);
  assert.equal(isUrgentTask({ kind: 'failed', urgent: true, due_on: '2026-10-01' }, today), true);
  assert.equal(isUrgentTask({ kind: 'approve', urgent: true, due_on: null }, today), false);
  assert.equal(isUrgentTask({ kind: 'general', urgent: true, due_on: '2026-12-01' }, today), true);
  assert.equal(isUrgentTask({ kind: 'general', urgent: false, due_on: '2026-10-01' }, today), false);
  // הקבוצות מקבלות את הדחיפות המחושבת
  const g = groupTasks([{ id: 1, kind: 'swap', urgent: true, done: false, due_on: '2026-10-08' }],
    { today, weekStart: '2026-10-04' });
  assert.equal(g.upcoming[0].urgent, false);
});

/* ========================= משימת אישור — הרשאה ========================= */

test('approveTaskBlocked — בלי perm_approve אי אפשר לסגור או לשנות סוג של משימת אישור', () => {
  const content = { is_owner: false, perm_content: true, perm_approve: false };
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { done: true }, content), true);
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { kind: 'general' }, content), true);
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { title: 'x' }, content), false);
  assert.equal(approveTaskBlocked({ kind: 'general' }, { done: true }, content), false);
});

test('approveTaskBlocked — מאשר או בעלים סוגרים כרגיל', () => {
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { done: true }, { perm_approve: true }), false);
  assert.equal(approveTaskBlocked({ kind: 'approve' }, { done: true }, { is_owner: true }), false);
});
