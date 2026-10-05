import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choosePrimary, isMissed, nextFullHour, postFacts, rescheduleApproves,
} from '../public/js/core/postActions.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');
const FUTURE = '2026-10-07T10:00:00+03:00';
const PAST = '2026-10-04T10:00:00+03:00';
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
  // גם כשהמועד עבר — עדיין שאלה של אישור
  assert.equal(pick(facts({ status: 'pending_approval', scheduled_at: PAST })).primary, 'approvePending');
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

test('בפרסום — "שחרר פרסום תקוע" עם הרשאת אישור בלבד', () => {
  assert.equal(pick(facts({ status: 'publishing', scheduled_at: PAST })).primary, 'resetPublishing');
  assert.equal(pick(facts({ status: 'publishing' }), CONTENT).primary, null);
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
  assert.equal(isMissed({ status: 'approved', scheduled_at: '2026-10-05T11:50:00+03:00' }, NOW), false);
  assert.equal(isMissed({ status: 'approved', scheduled_at: '2026-10-05T11:40:00+03:00' }, NOW), true);
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
  assert.equal(at('2026-10-05T10:40:00+03:00').toISOString(), new Date('2026-10-05T11:00:00+03:00').toISOString());
  assert.equal(at('2026-10-05T10:50:00+03:00').toISOString(), new Date('2026-10-05T12:00:00+03:00').toISOString());
  assert.equal(at('2026-10-05T10:45:00+03:00').toISOString(), new Date('2026-10-05T11:00:00+03:00').toISOString());
});
