import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_UNVERIFIED, NEWSLETTER_NO_APPROVE, NOT_APPROVED_ERROR, hubUnverified, alreadyTransferred, cleanFieldValues,
  hasNewsletterContent, hubStale, hubWaitState, newsletterClockStart, newsletterDigest,
  nextHubRef, reusableHubStatus, transferBlocker,
} from '../src/publish/newsletter.js';
import {
  STUCK_NEWSLETTER_CAP_ERROR, STUCK_NEWSLETTER_ERROR, pollDue, publishBlocker, stuckPublishingError,
} from '../src/publish/runner.js';
import { weekApprovalReason } from '../src/routes/publish.js';
import { moveBlocker } from '../src/routes/board.js';
import { hubAppMissing, hubCampaignUrl, hubFillUrl, hubOrigins } from '../src/hub-mail.js';

const NOW = new Date('2026-10-05T12:00:00+03:00');

process.env.HUB_API_URL = 'https://hub.example.com';
process.env.HUB_API_KEY = 'k';

/** ניוזלטר מוכן להעברה — כל בדיקה מקלקלת בו דבר אחד */
const nl = (post = {}, variant = {}, meta = {}) => ({
  post: {
    id: 7, title: 'ניוזלטר שבועי', platform: 'newsletter', channel_name: 'ניוזלטר',
    status: 'scheduled', content_id: 3, scheduled_at: '2026-10-07T09:00:00+03:00', ...post,
  },
  variant: {
    status: 'ready', body: '', ...variant,
    meta: { subject: 'מה חדש', field_values: { 'תוכן': 'שלום', ריק: '  ' }, template_id: 't1', ...meta },
  },
  assets: [],
});

/* ---------- מה מותר להעביר ---------- */

test('transferBlocker — ניוזלטר עתידי ומוכן עובר', () => {
  assert.equal(transferBlocker(nl(), { now: NOW }), null);
  assert.equal(transferBlocker(nl({ status: 'approved' }), { now: NOW }), null);
  assert.equal(transferBlocker(nl({ status: 'failed' }), { now: NOW }), null);
});

test('transferBlocker — מועד שעבר, סטטוס אחר, ערוץ אחר', () => {
  assert.match(transferBlocker(nl({ scheduled_at: '2026-10-05T11:00:00+03:00' }), { now: NOW }), /המועד עבר/);
  assert.match(transferBlocker(nl({ status: 'pending_approval' }), { now: NOW }), /ממתין לאישור/);
  assert.match(transferBlocker(nl({ status: 'published' }), { now: NOW }), /שעוד לא יצא/);
  assert.match(transferBlocker(nl({ platform: 'facebook' }), { now: NOW }), /רק ניוזלטר/);
});

test('transferBlocker — תוכן: חיבור, גרסה מוכנה, נושא, ותוכן כלשהו', () => {
  assert.match(transferBlocker(nl(), { now: NOW, hubReady: false }), /HUB_API_URL/);
  assert.match(transferBlocker(nl({}, { status: 'draft' }), { now: NOW }), /מוכן/);
  assert.match(transferBlocker(nl({}, {}, { subject: ' ' }), { now: NOW }), /נושא/);
  assert.match(transferBlocker(nl({}, {}, { field_values: {} }), { now: NOW }), /אין תוכן/);
  assert.match(transferBlocker(nl({ content_id: null }), { now: NOW }), /אין תוכן משויך/);
  // בלי תבנית — גוף חופשי מספיק
  assert.equal(transferBlocker(nl({}, { body: '<p>היי</p>' }, { field_values: {} }), { now: NOW }), null);
  // שדה שאינו "תוכן" (התבנית קובעת את השמות) — גם תוכן
  assert.equal(transferBlocker(nl({}, {}, { field_values: { פתיח: 'שלום' } }), { now: NOW }), null);
});

test('publishBlocker לניוזלטר — אותו כלל תוכן כמו ההעברה', () => {
  assert.equal(publishBlocker(nl()), null);
  assert.match(publishBlocker(nl({}, {}, { field_values: {} })), /אין תוכן/);
});

test('hasNewsletterContent / cleanFieldValues — רק מחרוזות לא ריקות', () => {
  assert.deepEqual(cleanFieldValues({ a: 'x', b: ' ', c: 3, d: null }), { a: 'x' });
  assert.deepEqual(cleanFieldValues(null), {});
  assert.deepEqual(cleanFieldValues(['x']), {});
  assert.equal(hasNewsletterContent({ body: ' ', meta: { field_values: { a: ' ' } } }), false);
  assert.equal(hasNewsletterContent({ body: 'x' }), true);
});

test('alreadyTransferred — רק כשבידי ה-HUB', () => {
  assert.equal(alreadyTransferred({ external_id: 'c', status: 'publishing' }), true);
  assert.equal(alreadyTransferred({ external_id: 'c', status: 'published' }), true);
  assert.equal(alreadyTransferred({ external_id: 'c', status: 'failed' }), false);
  assert.equal(alreadyTransferred({ external_id: null, status: 'publishing' }), false);
});

/* ---------- אישור: ניוזלטר לא מאושר כאן ---------- */

test('weekApprovalReason — ניוזלטר מדולג עם הסבר "העבר ל-HUB"', () => {
  assert.equal(weekApprovalReason(nl(), NOW), NEWSLETTER_NO_APPROVE);
  assert.match(NEWSLETTER_NO_APPROVE, /העבר ל-HUB/);
});

/* ---------- המפתח ב-HUB ---------- */

test('nextHubRef — אותו מפתח, ומספר חדש רק אחרי כשל סופי', () => {
  assert.equal(nextHubRef(7, null), 'post-7');
  assert.equal(nextHubRef(7, null, 'missing'), 'post-7');
  assert.equal(nextHubRef(7, 'post-7', 'missing'), 'post-7');
  assert.equal(nextHubRef(7, 'post-7', 'failed'), 'post-7-2');
  assert.equal(nextHubRef(7, 'post-7-2', 'failed'), 'post-7-3');
  assert.equal(nextHubRef(7, 'post-7-3'), 'post-7-3');
});

test('reusableHubStatus / hubWaitState', () => {
  for (const s of ['draft', 'scheduled', 'sending', 'sent']) assert.equal(reusableHubStatus(s), true);
  assert.equal(reusableHubStatus('failed'), false);
  assert.equal(hubWaitState('draft'), 'draft');
  assert.equal(hubWaitState('scheduled'), 'active');
  assert.equal(hubWaitState('sending'), 'active');
  assert.equal(hubWaitState('sent'), null);
});

/* ---------- טביעת אצבע: שינוי אחרי ההעברה ---------- */

test('newsletterDigest — יציב לסדר השדות, משתנה עם התוכן/נושא/מועד', () => {
  const a = nl({}, {}, { field_values: { 'תוכן': 'שלום', פתיח: 'א' } });
  const b = nl({}, {}, { field_values: { פתיח: 'א', 'תוכן': 'שלום', ריק: '' } });
  assert.equal(newsletterDigest(a), newsletterDigest(b));
  assert.notEqual(newsletterDigest(a), newsletterDigest(nl({}, {}, { subject: 'אחר' })));
  assert.notEqual(newsletterDigest(a), newsletterDigest(nl({ scheduled_at: '2026-10-08T09:00:00+03:00' })));
});

test('hubStale — רק כשיש טביעה שמורה והיא שונה', () => {
  const p = nl();
  assert.equal(hubStale(p), false); // הועבר לפני שנשמרה טביעה — לא ידוע
  p.post.hub_digest = newsletterDigest(p);
  assert.equal(hubStale(p), false);
  p.variant.meta.subject = 'נושא אחר';
  assert.equal(hubStale(p), true);
});

test('טביעה "לא ידועה" — לא "השתנה", אלא "ייתכן שישן"', () => {
  const p = nl();
  p.post.hub_digest = DIGEST_UNVERIFIED;
  assert.equal(hubStale(p), false);
  assert.equal(hubUnverified(p.post), true);
  assert.equal(hubUnverified({ hub_digest: newsletterDigest(p) }), false);
});

/* ---------- תקיעה: השעון מתחיל מהמאוחר מבין ההעברה למועד ---------- */

test('newsletterClockStart', () => {
  assert.equal(newsletterClockStart({ started: '2026-10-01T00:00:00Z', scheduled: '2026-10-03T00:00:00Z' })
    .toISOString(), '2026-10-03T00:00:00.000Z');
  assert.equal(newsletterClockStart({ started: '2026-10-04T00:00:00Z', scheduled: '2026-10-03T00:00:00Z' })
    .toISOString(), '2026-10-04T00:00:00.000Z');
  assert.equal(newsletterClockStart({ started: '2026-10-04T00:00:00Z' }).toISOString(),
    '2026-10-04T00:00:00.000Z');
});

test('stuckPublishingError — ניוזלטר שהועבר ימים מראש לא "תקוע" לפני המועד', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const h = (n) => new Date(now.getTime() - n * 3600000).toISOString();
  // הועבר לפני 5 ימים, המועד מחר — ממתין לאישור, לא תקוע
  assert.equal(stuckPublishingError(
    { platform: 'newsletter', started: h(120), scheduled: h(-24), hub: 'draft' }, now), null);
  // ממתין לאישור יממה וחצי אחרי המועד — "לא אושר ב-HUB"
  assert.equal(stuckPublishingError(
    { platform: 'newsletter', started: h(120), scheduled: h(36), hub: 'draft' }, now), NOT_APPROVED_ERROR);
  // ה-HUB לא ענה יממה וחצי אחרי המועד
  assert.equal(stuckPublishingError(
    { platform: 'newsletter', started: h(120), scheduled: h(36), hub: null }, now), STUCK_NEWSLETTER_ERROR);
  // אושר ומתוזמן/נשלח — עד 72 שעות אחרי המועד
  assert.equal(stuckPublishingError(
    { platform: 'newsletter', started: h(120), scheduled: h(60), hub: 'active' }, now), null);
  assert.equal(stuckPublishingError(
    { platform: 'newsletter', started: h(120), scheduled: h(80), hub: 'active' }, now),
  STUCK_NEWSLETTER_CAP_ERROR);
});

test('stuckPublishingError — ניוזלטר ישן (נוצר ב-HUB לפני "העבר ל-HUB"): טיוטה = עד 72 שעות', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const h = (n) => new Date(now.getTime() - n * 3600000).toISOString();
  const old = (hours, hub) => stuckPublishingError(
    { platform: 'newsletter', started: h(hours), scheduled: h(hours), hub, legacy: true }, now);
  assert.equal(old(48, 'draft'), null);
  assert.equal(old(80, 'draft'), STUCK_NEWSLETTER_CAP_ERROR);
  // לא ענה — כמו קודם, יממה
  assert.equal(old(30, null), STUCK_NEWSLETTER_ERROR);
});

test('pollDue — טיוטה ופוסט שנכשל פעם ב-10 דקות; מתוזמן/נשלח בכל טיק', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ago = (m) => new Date(now.getTime() - m * 60000).toISOString();
  assert.equal(pollDue({ status: 'publishing', hub_status: 'draft', hub_polled_at: ago(3) }, now), false);
  assert.equal(pollDue({ status: 'publishing', hub_status: 'draft', hub_polled_at: ago(10) }, now), true);
  assert.equal(pollDue({ status: 'publishing', hub_status: 'draft', hub_polled_at: null }, now), true);
  assert.equal(pollDue({ status: 'failed', hub_status: 'scheduled', hub_polled_at: ago(3) }, now), false);
  assert.equal(pollDue({ status: 'publishing', hub_status: 'scheduled', hub_polled_at: ago(1) }, now), true);
  assert.equal(pollDue({ status: 'publishing', hub_status: 'sending', hub_polled_at: ago(1) }, now), true);
});

/* ---------- הזזה של ניוזלטר שהועבר ---------- */

test('moveBlocker — ניוזלטר שהועבר ל-HUB: משנים מועד שם', () => {
  const r = moveBlocker({ status: 'publishing', hub_transferred_at: '2026-10-05T09:00:00Z' },
    '2026-10-09T09:00:00+03:00', NOW);
  assert.equal(r.status, 409);
  assert.match(r.error, /הועבר ל-HUB/);
});

/* ---------- כתובות ה-HUB ---------- */

test('hubFillUrl / hubCampaignUrl — רק מהדשבורד (HUB_APP_URL), בלי נפילה ל-API', () => {
  assert.equal(hubFillUrl({ HUB_API_URL: 'https://app.hub.io/' }), null);
  assert.equal(hubFillUrl({ HUB_API_URL: 'https://app.hub.io', HUB_APP_URL: 'https://hub.io/' }),
    'https://hub.io/dashboard/mission-control/fill');
  assert.equal(hubFillUrl({}), null);
  assert.equal(hubAppMissing({ HUB_API_URL: 'https://x', HUB_API_KEY: 'k' }), true);
  assert.equal(hubAppMissing({ HUB_API_URL: 'https://x', HUB_API_KEY: 'k', HUB_APP_URL: 'https://y' }), false);
  assert.equal(hubAppMissing({}), false);
  assert.equal(hubCampaignUrl('c-1', { HUB_API_URL: 'https://app.hub.io', HUB_APP_URL: 'https://hub.io' }),
    'https://hub.io/dashboard/campaigns/c-1/edit');
  assert.equal(hubCampaignUrl(null, { HUB_API_URL: 'https://app.hub.io' }), null);
});

test('hubOrigins — רק מקור הדשבורד; בלי HUB_APP_URL או עם ערך פסול — ריק', () => {
  assert.deepEqual(hubOrigins({ HUB_API_URL: 'https://app.hub.io/x', HUB_APP_URL: 'https://hub.io/' }),
    ['https://hub.io']);
  assert.deepEqual(hubOrigins({ HUB_API_URL: 'https://hub.io' }), []);
  assert.deepEqual(hubOrigins({ HUB_APP_URL: 'not a url' }), []);
});

test('shapePost — ניוזלטר שהועבר נושא את מצב ה-HUB ללוח; פוסט רגיל לא', async () => {
  const { shapePost } = await import('../src/board.js');
  const base = { id: 1, scheduled_at: '2026-10-07T07:00:00Z', status: 'publishing' };
  assert.equal(shapePost({ ...base, hub_status: 'draft', hub_transferred_at: 'x' }).hub_status, 'draft');
  assert.equal('hub_status' in shapePost(base), false);
});
