import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsForUser, storageAlert, storageLimitMb } from '../src/alerts.js';
import { backupAlerts } from '../src/backup-status.js';

const MB = 1048576;

/* ========================= מי רואה מה ========================= */

test('alertsForUser — התראה עם perm רק למי שיכול לפעול; בלי user — הכול', () => {
  const alerts = [{ id: 'a' }, { id: 'approval-1', perm: 'approve' }, { id: 'storage', perm: 'settings' }];
  const content = { is_owner: false, perm_content: true, perm_approve: false, perm_settings: false };
  assert.deepEqual(alertsForUser(alerts, content).map((a) => a.id), ['a']);
  assert.deepEqual(alertsForUser(alerts, { ...content, perm_approve: true }).map((a) => a.id),
    ['a', 'approval-1']);
  assert.deepEqual(alertsForUser(alerts, { is_owner: true }).map((a) => a.id), ['a', 'approval-1', 'storage']);
  assert.equal(alertsForUser(alerts, null).length, 3);
});

/* ========================= אחסון ========================= */

test('storageLimitMb — מ-STORAGE_ALERT_MB, ברירת מחדל 500, ערך לא תקין = ברירת מחדל', () => {
  assert.equal(storageLimitMb({}), 500);
  assert.equal(storageLimitMb({ STORAGE_ALERT_MB: '1000' }), 1000);
  assert.equal(storageLimitMb({ STORAGE_ALERT_MB: 'abc' }), 500);
  assert.equal(storageLimitMb({ STORAGE_ALERT_MB: '-3' }), 500);
});

test('storageAlert — מתחת ל-70% אין; 70–90 דורש טיפול; מעל 90 חוסם; רק להגדרות, בלי "פתח"', () => {
  assert.equal(storageAlert({ usedBytes: 300 * MB, limitMb: 500 }), null);
  const warn = storageAlert({ usedBytes: 400 * MB, limitMb: 500 });
  assert.equal(warn.level, 'warn');
  assert.equal(warn.perm, 'settings');
  assert.equal(warn.tab, null);
  assert.equal(storageAlert({ usedBytes: 460 * MB, limitMb: 500 }).level, 'crit');
});

test('storageAlert — ההסבר אומר מה תופס מקום, מה מצב המדיה, ושזה אצל המפתח', () => {
  const a = storageAlert({
    usedBytes: 450 * MB, backupsBytes: 300 * MB, assetsBytes: 40 * MB, logBytes: 0,
    limitMb: 500, mediaInR2: true,
  });
  assert.match(a.detail, /450MB מתוך 500MB/);
  assert.match(a.detail, /גיבויים פנימיים 300MB, קבצים שעוד שמורים במסד 40MB/);
  assert.doesNotMatch(a.detail, /יומן פעולות/); // 0MB לא מוזכר
  assert.match(a.detail, /R2\) ולא תופסים כאן מקום/);
  assert.match(a.detail, /אצל המפתח/);
  assert.match(storageAlert({ usedBytes: 450 * MB, limitMb: 500, mediaInR2: false }).detail,
    /לא מוגדר, ולכן כל קובץ שעולה נשמר במסד/);
});

/* ========================= גיבוי ========================= */

const NOW = new Date('2026-10-05T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const layer = (layer, extra) => ({
  layer, label: layer, failTitle: `${layer} נכשל`, configured: true,
  last_attempt_at: hoursAgo(1), last_result: 'ok', last_error: null, last_success_at: hoursAgo(1),
  ...extra,
});

test('backupAlerts — הכול תקין: אין התראות', () => {
  assert.deepEqual(backupAlerts([layer('db'), layer('drive'), layer('r2')], NOW), []);
});

test('backupAlerts — שכבה שנכשלה בניסיון האחרון: דורש טיפול עם הסיבה, רק להגדרות', () => {
  const [a] = backupAlerts([layer('drive', { last_result: 'failed', last_error: 'quota' })], NOW);
  assert.equal(a.id, 'backup-failed-drive');
  assert.equal(a.level, 'warn');
  assert.equal(a.perm, 'settings');
  assert.equal(a.title, 'drive נכשל');
  assert.match(a.detail, /quota/);
});

test('backupAlerts — R2 בלי הצלחה ב-36 שעות: חוסם אחד (לא גם "נכשל")', () => {
  const out = backupAlerts([layer('r2', {
    last_result: 'failed', last_error: 'R2 PUT 403', last_success_at: hoursAgo(40),
  })], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'backup-stale-r2');
  assert.equal(out[0].level, 'crit');
  assert.match(out[0].detail, /R2 PUT 403/);
  // נכשל לאחרונה אבל הצליח לפני 10 שעות — רק "נכשל"
  assert.equal(backupAlerts([layer('r2', { last_result: 'failed', last_success_at: hoursAgo(10) })], NOW)[0].id,
    'backup-failed-r2');
});

test('backupAlerts — שכבה לא מוגדרת או שעוד לא נוסתה: שקט', () => {
  assert.deepEqual(backupAlerts([layer('r2', { configured: false, last_result: 'failed' })], NOW), []);
  assert.deepEqual(backupAlerts([layer('r2', { last_attempt_at: null, last_result: null, last_success_at: null })], NOW), []);
  // 36 שעות בלי הצלחה רלוונטי רק ל-R2 (הגיבוי המלא)
  assert.deepEqual(backupAlerts([layer('drive', { last_success_at: hoursAgo(50) })], NOW), []);
});
