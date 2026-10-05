import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILL_INIT, cleanFillValues, initMessage, newsletterHubTag, newsletterPostAction,
  readFillMessage, seedValues,
} from '../public/js/core/hubFill.js';
import { choosePrimary, postFacts, publishingStuck, rescheduleApproves } from '../public/js/core/postActions.js';

/* ---------- פרוטוקול חלון העורך (BoardFill.tsx ב-HUB) ---------- */

const HUB = 'https://backbone.example';
const win = { name: 'the-hub-window' };
const other = { name: 'another-window' };
const expect = { origins: [HUB, 'https://app.backbone.example'], source: win };
const msg = (data, over = {}) => ({ origin: HUB, source: win, data, ...over });

test('readFillMessage — ready ו-save מהחלון שפתחנו וממקור ה-HUB', () => {
  assert.deepEqual(readFillMessage(msg({ type: 'mc-fill-ready' }), expect), { type: 'ready' });
  assert.deepEqual(readFillMessage(msg({ type: 'mc-fill-save', values: { 'תוכן': 'שלום', ריק: '' } }), expect),
    { type: 'save', values: { 'תוכן': 'שלום' } });
  // המקור השני ברשימה (כתובת ה-API) גם מורשה
  assert.deepEqual(readFillMessage(msg({ type: 'mc-fill-ready' }, { origin: 'https://app.backbone.example' }), expect),
    { type: 'ready' });
});

test('readFillMessage — מקור זר, חלון אחר, או בלי חלון צפוי — נזרק', () => {
  assert.equal(readFillMessage(msg({ type: 'mc-fill-save', values: {} }, { origin: 'https://evil.example' }), expect), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-save', values: {} }, { origin: 'https://backbone.example.evil.com' }), expect), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-save', values: {} }, { source: other }), expect), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-ready' }), { origins: [HUB], source: null }), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-ready' }), { origins: [], source: win }), null);
});

test('readFillMessage — תוכן לא תקין נזרק', () => {
  assert.equal(readFillMessage(msg('mc-fill-ready'), expect), null);
  assert.equal(readFillMessage(msg(null), expect), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-init', values: {} }), expect), null); // שלנו, לא שלהם
  assert.equal(readFillMessage(msg({ type: 'mc-fill-save' }), expect), null);
  assert.equal(readFillMessage(msg({ type: 'mc-fill-save', values: ['x'] }), expect), null);
  assert.equal(readFillMessage(msg({ type: 'other' }), expect), null);
});

test('cleanFillValues — רק מחרוזות לא ריקות, עם תקרות', () => {
  assert.deepEqual(cleanFillValues({ a: 'x', b: '  ', c: 5, d: { x: 1 } }), { a: 'x' });
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, 'v']));
  assert.equal(Object.keys(cleanFillValues(many)).length, 200);
  assert.equal(cleanFillValues({ a: 'x'.repeat(200001) }).a.length, 100000);
});

test('initMessage — הצורה ש-BoardFill מחכה לה', () => {
  assert.deepEqual(initMessage({ 'כותרת': 'שלום', ריק: '' }), { type: FILL_INIT, values: { 'כותרת': 'שלום' } });
});

test('seedValues — גוף ישן נזרע לשדה התוכן רק כשהוא ריק', () => {
  const fields = [{ name: 'כותרת' }, { name: 'תוכן' }];
  assert.deepEqual(seedValues({}, 'גוף ישן', fields), { 'תוכן': 'גוף ישן' });
  assert.deepEqual(seedValues({ 'תוכן': 'חדש' }, 'גוף ישן', fields), { 'תוכן': 'חדש' });
  assert.deepEqual(seedValues({}, 'גוף ישן', [{ name: 'כותרת' }]), {});
});

/* ---------- מצב מול ה-HUB: תג בלוח ופעולה בעורך ---------- */

test('newsletterHubTag — רק לניוזלטר שבידי ה-HUB', () => {
  assert.equal(newsletterHubTag({ status: 'scheduled' }), null);
  assert.equal(newsletterHubTag({ status: 'publishing' }), null); // פייסבוק בפרסום
  assert.equal(newsletterHubTag({ status: 'publishing', hub_status: 'draft' }).label, 'ממתין לאישור ב-HUB');
  assert.equal(newsletterHubTag({ status: 'publishing', hub_transferred_at: 'x' }).label, 'ממתין לאישור ב-HUB');
  assert.equal(newsletterHubTag({ status: 'publishing', hub_status: 'scheduled' }).tone, 'good');
  assert.equal(newsletterHubTag({ status: 'publishing', hub_status: 'sending' }).cls, 'auto');
});

test('newsletterPostAction — העבר / פתח / למה לא', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const p = { status: 'scheduled', scheduled_at: '2026-10-07T09:00:00Z' };
  const ok = { now, ready: true, subject: 'נושא' };
  assert.deepEqual(newsletterPostAction(p, ok), { action: 'transfer' });
  assert.deepEqual(newsletterPostAction({ ...p, status: 'publishing', external_url: 'https://h/x' }, ok), { action: 'open' });
  assert.match(newsletterPostAction({ ...p, scheduled_at: '2026-10-05T11:00:00Z' }, ok).reason, /המועד עבר/);
  assert.match(newsletterPostAction(p, { ...ok, ready: false }).reason, /מוכן/);
  assert.match(newsletterPostAction(p, { ...ok, subject: ' ' }).reason, /נושא/);
});

/* ---------- הפעולה הראשית בחלון הפוסט ---------- */

const NOW = new Date('2026-10-05T12:00:00');
const nl = (over = {}) => ({
  status: 'scheduled', scheduled_at: '2026-10-07T10:00:00', platform: 'newsletter',
  autoReady: true, hasContent: true, variantReady: true, ...over,
});
const ALL = { content: true, approve: true };

test('choosePrimary — ניוזלטר מוכן: "העבר ל-HUB" במקום "אשר"', () => {
  assert.deepEqual(choosePrimary(nl(), ALL, NOW), { primary: 'transferHub', secondary: null });
  assert.deepEqual(choosePrimary(nl({ status: 'approved' }), ALL, NOW), { primary: 'transferHub', secondary: null });
  assert.deepEqual(choosePrimary(nl({ status: 'failed' }), ALL, NOW), { primary: 'transferHub', secondary: null });
  // בלי הרשאת אישור — אין פעולה ראשית
  assert.deepEqual(choosePrimary(nl(), { content: true, approve: false }, NOW), { primary: null, secondary: null });
  // לא מוכן — פותחים בתוכן, כמו כל ערוץ
  assert.equal(choosePrimary(nl({ variantReady: false }), ALL, NOW).primary, 'openContent');
  // המועד עבר — מועד חדש
  assert.equal(choosePrimary(nl({ scheduled_at: '2026-10-04T10:00:00' }), ALL, NOW).primary, 'reschedule');
});

test('choosePrimary — ניוזלטר שבידי ה-HUB: "פתח ב-HUB"', () => {
  const f = postFacts({ status: 'publishing', platform: 'newsletter', external_url: 'https://h/c/1/edit',
    scheduled_at: '2026-10-07T10:00:00', content_id: 1 }, { status: 'ready' });
  assert.equal(f.hubUrl, 'https://h/c/1/edit');
  assert.deepEqual(choosePrimary(f, ALL, NOW), { primary: 'openHub', secondary: null });
});

test('rescheduleApproves — ניוזלטר לא מאושר אחרי מועד חדש (מעבירים ל-HUB)', () => {
  assert.equal(rescheduleApproves(nl({ status: 'failed' }), ALL), false);
  assert.equal(rescheduleApproves(nl({ status: 'failed', platform: 'facebook' }), ALL), true);
});

test('שחרר פרסום תקוע — ניוזלטר שהועבר: רק 10 דקות אחרי המועד, לא אחרי ההעברה', async () => {
  const { resetClockStart, resetTooSoon } = await import('../src/publish/runner.js');
  const now = new Date('2026-10-05T12:00:00Z');
  const row = { publishing_started_at: '2026-10-03T09:00:00Z', scheduled_at: '2026-10-06T07:00:00Z',
    hub_transferred_at: '2026-10-03T09:00:00Z' };
  assert.equal(resetTooSoon(resetClockStart(row), now), true);       // לפני המועד
  assert.equal(resetTooSoon(resetClockStart({ ...row, scheduled_at: '2026-10-05T11:55:00Z' }), now), true);
  assert.equal(resetTooSoon(resetClockStart({ ...row, scheduled_at: '2026-10-05T11:45:00Z' }), now), false);
  // פוסט רגיל — מתי שנתפס
  assert.equal(resetTooSoon(resetClockStart({ ...row, hub_transferred_at: null }), now), false);

  const f = postFacts({ status: 'publishing', platform: 'newsletter', external_url: 'https://h/e',
    ...row }, { status: 'ready' });
  assert.equal(publishingStuck(f, now), false);
  assert.equal(publishingStuck(postFacts({ status: 'publishing', platform: 'newsletter', ...row,
    scheduled_at: '2026-10-05T11:45:00Z' }, null), now), true);
});
