import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePrimary, isMissed, nextFullHour, postFacts, rescheduleApproves,
} from '../public/js/core/postActions.js';

const NOW = new Date('2026-10-05T12:00:00');
const FUTURE = '2026-10-07T10:00:00';
const PAST = '2026-10-04T10:00:00';
const ALL = { content: true, approve: true };
const CONTENT = { content: true, approve: false };
const NONE = { content: false, approve: false };

/** פוסט עתידי, מתוכנן, בערוץ פייסבוק מחובר עם פרסום אוטומטי דלוק, תוכן מוכן */
const facts = (over = {}) => ({
  status: 'scheduled', scheduled_at: FUTURE, platform: 'facebook',
  autoReady: true, hasContent: true, variantReady: true, ...over,
});
const pick = (f, perms = ALL) => choosePrimary(f, perms, NOW);

test('postFacts — autoReady דורש פלטפורמה, חיבור וגם פרסום אוטומטי דלוק לערוץ', () => {
  const post = { status: 'scheduled', scheduled_at: FUTURE, content_id: 3, platform: 'facebook',
                 autopub_connected: true, autopub_enabled: true };
  assert.equal(postFacts(post, { status: 'ready' }).autoReady, true);
  assert.equal(postFacts({ ...post, autopub_enabled: false }, null).autoReady, false);
  assert.equal(postFacts({ ...post, autopub_connected: false }, null).autoReady, false);
  assert.equal(postFacts({ ...post, platform: 'whatsapp' }, null).autoReady, false);
  assert.equal(postFacts(post, { status: 'draft' }).variantReady, false);
  assert.equal(postFacts({ ...post, content_id: null }, null).hasContent, false);
});

test('מתוכנן עתידי עם תוכן מוכן בערוץ אוטומטי — "אשר לפרסום אוטומטי"', () => {
  assert.deepEqual(pick(facts()), { primary: 'approve', secondary: null });
});

test('ערוץ מחובר שהפרסום האוטומטי שלו כבוי — לא מציעים אישור (נכשל בשרת)', () => {
  assert.equal(pick(facts({ autoReady: false })).primary, null);
});

test('בלי הרשאת אישור — אין "אשר"', () => {
  assert.equal(pick(facts(), CONTENT).primary, null);
});

test('גרסה בטיוטה — "פתח בתוכן" (לסמן מוכן), לא אישור', () => {
  assert.equal(pick(facts({ variantReady: false })).primary, 'openContent');
});

test('מאושר עתידי — "בטל אישור"', () => {
  assert.equal(pick(facts({ status: 'approved' })).primary, 'unapprove');
  assert.equal(pick(facts({ status: 'approved' }), CONTENT).primary, null);
});

test('ממתין לאישור — "אשר" ראשית ו"דחה" משנית, רק עם הרשאת אישור', () => {
  assert.deepEqual(pick(facts({ status: 'pending_approval', hasContent: false })),
    { primary: 'approvePending', secondary: 'reject' });
  assert.equal(pick(facts({ status: 'pending_approval' }), CONTENT).primary, null);
  // המועד עבר — השרת לא יאשר: קודם מועד חדש (או דחייה)
  assert.deepEqual(pick(facts({ status: 'pending_approval', scheduled_at: PAST })),
    { primary: 'reschedule', secondary: 'reject' });
  assert.deepEqual(pick(facts({ status: 'pending_approval', scheduled_at: PAST }), { content: false, approve: true }),
    { primary: 'reject', secondary: null });
  // מועד חדש לממתין לא מאשר לפרסום אוטומטי — האישור שלו הוא "אשר" בנפרד
  assert.equal(rescheduleApproves(facts({ status: 'pending_approval' }), ALL), false);
});

test('נכשל — "קבע מועד חדש" (ואז אישור)', () => {
  assert.equal(pick(facts({ status: 'failed', scheduled_at: PAST })).primary, 'reschedule');
  assert.equal(pick(facts({ status: 'failed', scheduled_at: PAST }), NONE).primary, null);
  // נכשל שכבר הוזז קדימה — רק לאשר שוב
  assert.equal(pick(facts({ status: 'failed' })).primary, 'approve');
});

test('עבר המועד בערוץ ידני/וואטסאפ — "סמן כפורסם"', () => {
  const f = facts({ scheduled_at: PAST, platform: 'whatsapp', autoReady: false });
  assert.equal(pick(f).primary, 'markPublished');
  assert.equal(pick(f, CONTENT).primary, 'markPublished');
  assert.equal(pick(f, NONE).primary, null);
});

test('עבר המועד בערוץ אוטומטי — "קבע מועד חדש"', () => {
  assert.equal(pick(facts({ scheduled_at: PAST })).primary, 'reschedule');
  // מאושר שהטיק לא תפס (מעבר לחסד של רבע שעה) — מועד חדש, האישור נשאר
  assert.equal(pick(facts({ status: 'approved', scheduled_at: PAST })).primary, 'reschedule');
});

test('בפרסום — "שחרר פרסום תקוע" רק אחרי 10 דקות, ורק עם הרשאת אישור', () => {
  const old = '2026-10-05T11:45:00';   // רבע שעה לפני NOW
  const fresh = '2026-10-05T11:55:00'; // חמש דקות לפני NOW
  assert.equal(pick(facts({ status: 'publishing', scheduled_at: PAST, publishingStartedAt: old })).primary,
    'resetPublishing');
  assert.equal(pick(facts({ status: 'publishing', scheduled_at: PAST, publishingStartedAt: fresh })).primary, null);
  // שורה ישנה בלי זמן התחלה — מותר
  assert.equal(pick(facts({ status: 'publishing', scheduled_at: PAST })).primary, 'resetPublishing');
  assert.equal(pick(facts({ status: 'publishing', publishingStartedAt: old }), CONTENT).primary, null);
});

test('בלי תוכן — "שייך תוכן"', () => {
  assert.equal(pick(facts({ hasContent: false, variantReady: false })).primary, 'attach');
  assert.equal(pick(facts({ hasContent: false }), { content: false, approve: true }).primary, null);
});

test('פורסם — אין פעולה ראשית (המדידה בגוף החלון)', () => {
  assert.equal(pick(facts({ status: 'published', scheduled_at: PAST })).primary, null);
});

test('isMissed — מתוכנן שעבר; מאושר רק אחרי רבע שעה; נכשל/ממתין לא', () => {
  assert.equal(isMissed({ status: 'scheduled', scheduled_at: PAST }, NOW), true);
  assert.equal(isMissed({ status: 'scheduled', scheduled_at: FUTURE }, NOW), false);
  assert.equal(isMissed({ status: 'approved', scheduled_at: '2026-10-05T11:50:00' }, NOW), false);
  assert.equal(isMissed({ status: 'approved', scheduled_at: '2026-10-05T11:40:00' }, NOW), true);
  assert.equal(isMissed({ status: 'failed', scheduled_at: PAST }, NOW), false);
  assert.equal(isMissed({ status: 'pending_approval', scheduled_at: PAST }, NOW), false);
  assert.equal(isMissed({ status: 'published', scheduled_at: PAST }, NOW), false);
});

test('rescheduleApproves — רק כשהאישור יעבור, ולא למאושר (האישור נשאר)', () => {
  assert.equal(rescheduleApproves(facts({ status: 'failed' }), ALL), true);
  assert.equal(rescheduleApproves(facts({ status: 'failed' }), CONTENT), false);
  assert.equal(rescheduleApproves(facts({ status: 'approved' }), ALL), false);
  assert.equal(rescheduleApproves(facts({ autoReady: false }), ALL), false);
  assert.equal(rescheduleApproves(facts({ variantReady: false }), ALL), false);
});

test('nextFullHour — שעה עגולה, לפחות רבע שעה קדימה', () => {
  const at = (s) => nextFullHour(new Date(s));
  assert.equal(at('2026-10-05T10:40:00').toISOString(), new Date('2026-10-05T11:00:00').toISOString());
  assert.equal(at('2026-10-05T10:50:00').toISOString(), new Date('2026-10-05T12:00:00').toISOString());
  assert.equal(at('2026-10-05T10:45:00').toISOString(), new Date('2026-10-05T11:00:00').toISOString());
});

test('defaultUrgentTime — 10:00, או השעה העגולה הבאה כשכבר מאוחר מזה היום', async () => {
  const { defaultUrgentTime } = await import('../public/js/core/postActions.js');
  const t = (s) => defaultUrgentTime(new Date(s));
  assert.equal(t('2026-10-05T08:20:00'), '10:00');
  // 09:50 — עשר דקות לפני 10:00 זה צפוף מדי; לפחות רבע שעה קדימה → 11:00
  assert.equal(t('2026-10-05T09:50:00'), '11:00');
  assert.equal(t('2026-10-05T15:20:00'), '16:00');
  assert.equal(t('2026-10-05T21:30:00'), '10:00'); // מאוחר מדי — מחר
  // סעיף 12: שעת הפרסום הרגילה של הערוץ במקום 10:00
  assert.equal(defaultUrgentTime(new Date('2026-10-05T06:20:00'), 8), '08:00');
  assert.equal(defaultUrgentTime(new Date('2026-10-05T08:50:00'), 8), '10:00');
  assert.equal(defaultUrgentTime(new Date('2026-10-05T21:30:00'), 18), '18:00');
});

test('nextFreeSlot — השעה העגולה הפנויה הבאה בערוץ', async () => {
  const { nextFreeSlot } = await import('../public/js/core/postActions.js');
  const d = (s) => new Date(s).toISOString();
  const now = new Date('2026-10-05T15:20:00'); // יום שני
  // בלי כלום על הלוח — 16:00
  assert.equal(nextFreeSlot({ now }).toISOString(), d('2026-10-05T16:00:00'));
  // 16:00 תפוס בערוץ — 17:00
  assert.equal(nextFreeSlot({ now, busy: [{ at: '2026-10-05T16:00:00' }] }).toISOString(),
    d('2026-10-05T17:00:00'));
  // מאוחר מדי היום — מחר ב-9:00
  assert.equal(nextFreeSlot({ now: new Date('2026-10-05T20:50:00') }).toISOString(),
    d('2026-10-06T09:00:00'));
  // מחר (שלישי=2) חסום לערוץ — מחרתיים
  assert.equal(nextFreeSlot({ now: new Date('2026-10-05T20:50:00'), blockedDays: [2] }).toISOString(),
    d('2026-10-07T09:00:00'));
  // לאותה נקודה כבר יש פוסט היום בערוץ — מחר
  assert.equal(nextFreeSlot({ now, endpointId: 4, busy: [{ at: '2026-10-05T09:00:00', endpoint_id: 4 }] })
    .toISOString(), d('2026-10-06T09:00:00'));
  // לפני שעות הפעילות — 9:00 של אותו יום
  assert.equal(nextFreeSlot({ now: new Date('2026-10-05T06:10:00') }).toISOString(),
    d('2026-10-05T09:00:00'));
});

test('resetTooSoon (שרת) — אותו סף של 10 דקות', async () => {
  const { resetTooSoon } = await import('../src/publish/runner.js');
  const now = new Date('2026-10-05T12:00:00');
  assert.equal(resetTooSoon('2026-10-05T11:55:00', now), true);
  assert.equal(resetTooSoon('2026-10-05T11:50:00', now), false);
  assert.equal(resetTooSoon(null, now), false);
});

test('editPatch — רק מה ששונה מול הטופס שנטען', async () => {
  const { editPatch } = await import('../public/js/core/postActions.js');
  const snap = { date: '2026-10-08', time: '09:00', channel: '6', assignee: '2', title: 'כותרת', note: '' };
  // כלום לא השתנה — גוף ריק (גם אם המועד המקורי כלל שניות, הוא לא נשלח)
  assert.deepEqual(editPatch(snap, { ...snap }), { body: {} });
  // רק כותרת — לא נוגעים באחראי, בערוץ או במועד
  assert.deepEqual(editPatch(snap, { ...snap, title: 'חדשה' }), { body: { title: 'חדשה' } });
  // ניקוי אחראי מפורש — null
  assert.deepEqual(editPatch(snap, { ...snap, assignee: '' }), { body: { assignee_id: null } });
  // ערוץ ריק לא נשלח כ-0
  assert.deepEqual(editPatch(snap, { ...snap, channel: '' }), { body: {} });
  assert.deepEqual(editPatch(snap, { ...snap, channel: '7' }), { body: { channel_id: 7 } });
  // שעה חדשה — מועד מלא
  const r = editPatch(snap, { ...snap, time: '11:30' });
  assert.equal(r.body.scheduled_at, new Date('2026-10-08T11:30:00').toISOString());
  assert.equal(editPatch(snap, { ...snap, time: '' }).error, 'צריך תאריך ושעה');
  assert.equal(editPatch(snap, { ...snap, title: '' }).error, 'צריך כותרת לפוסט');
  assert.deepEqual(editPatch(snap, { ...snap, note: 'הערה' }), { body: { note: 'הערה' } });
});
