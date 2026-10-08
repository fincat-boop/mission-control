import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyPublishError } from '../src/publish/errors.js';
import { HubMailError } from '../src/hub-mail.js';
import {
  STUCK_NEWSLETTER_CAP_ERROR, STUCK_NEWSLETTER_ERROR, STUCK_SOCIAL_ERROR, stuckPublishingError,
} from '../src/publish/runner.js';

const graphErr = (message, code, subcode) => Object.assign(new Error(message), { code, subcode });
const noEnvNames = (m) => assert.doesNotMatch(m, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/);

/* ========================= friendlyPublishError ========================= */

test('הגדרה חסרה בשרת — למפתח, בלי שמות משתני סביבה', () => {
  for (const raw of [
    'חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY בשרת)',
    'הגשת מדיה ציבורית לא מוגדרת (R2_PUBLIC_*) — נדרשת לאינסטגרם',
    'הכתובת הציבורית של המדיה לא מוגדרת (R2_PUBLIC_BASE_URL) — אי אפשר לשלוח את הקבצים',
  ]) {
    const f = friendlyPublishError(raw);
    assert.equal(f.who, 'developer');
    assert.match(f.message, /חסרה הגדרה בשרת/);
    assert.match(f.message, /המפתח/);
    noEnvNames(f.message);
  }
  assert.match(friendlyPublishError('X (HUB_API_KEY)').message, /החיבור ל-HUB/);
  assert.match(friendlyPublishError('X (R2_PUBLIC_*)').message, /אחסון המדיה/);
});

test('ה-HUB לא זמין / 5xx — תקלה זמנית, מנסים שוב מאוחר יותר', () => {
  for (const err of [
    new HubMailError('ה-HUB לא זמין: fetch failed', 502),
    new HubMailError('שגיאת HUB (500)', 500),
    'שגיאת HUB (503)',
  ]) {
    const f = friendlyPublishError(err, { platform: 'newsletter' });
    assert.equal(f.who, 'owner');
    assert.match(f.message, /לא זמין כרגע/);
    assert.match(f.message, /מנסים שוב/);
    assert.doesNotMatch(f.message, /fetch failed|\(500\)/);
  }
});

test('ה-HUB דחה את המפתח (401/403) — למפתח; סירוב מנומק (4xx) — ההודעה של ה-HUB', () => {
  assert.equal(friendlyPublishError(new HubMailError('Unauthorized', 401)).who, 'developer');
  const refused = friendlyPublishError(new HubMailError('הניוזלטר נחסם: חסרה כתובת הסרה', 422));
  assert.equal(refused.who, 'owner');
  assert.equal(refused.message, 'ה-HUB סירב לשלוח: הניוזלטר נחסם: חסרה כתובת הסרה');
});

test('מטא — טוקן שפג (190): לחבר מחדש בניהול → ערוצי פרסום', () => {
  const f = friendlyPublishError(graphErr('Error validating access token: Session has expired', 190, 463),
    { platform: 'facebook' });
  assert.equal(f.who, 'owner');
  assert.match(f.message, /החיבור לפייסבוק פג או בוטל/);
  assert.match(f.message, /ניהול → ערוצי פרסום/);
  assert.doesNotMatch(f.message, /Session/);
});

test('מטא — הרשאות (10/200), הגבלת קצב (4/17/32/613), מדיניות (368)', () => {
  assert.match(friendlyPublishError(graphErr('(#200) Requires pages_manage_posts', 200), { platform: 'facebook' }).message,
    /חסרה הרשאה לפרסם/);
  assert.match(friendlyPublishError(graphErr('Application does not have permission', 10)).message, /חסרה הרשאה/);
  for (const code of [4, 17, 32, 613]) {
    assert.match(friendlyPublishError(graphErr('(#4) Application request limit reached', code),
      { platform: 'instagram' }).message, /אינסטגרם הגבילה זמנית/);
  }
  const policy = friendlyPublishError(graphErr('It looks like you were misusing this feature', 368));
  assert.match(policy.message, /מדיניות התוכן/);
});

test('מטא — המדיה לא התקבלה (9004 / 2207052 / הודעת עיבוד)', () => {
  assert.match(friendlyPublishError(graphErr('Only photo or video can be accepted as media type.', 9004),
    { platform: 'instagram' }).message, /לא הצליחה לקבל את התמונה או הסרטון/);
  assert.match(friendlyPublishError(graphErr('Media download has failed.', 9007, 2207052)).message,
    /התמונה או הסרטון/);
  assert.match(friendlyPublishError('אינסטגרם דחה את המדיה: ERROR').message, /פורמט/);
});

test('אינסטגרם לא סיים לעבד בזמן — הודעת זמן, לא "פורמט"', () => {
  const byKind = friendlyPublishError(Object.assign(new Error('x'), { kind: 'processing_timeout' }),
    { platform: 'instagram' });
  assert.match(byKind.message, /אינסטגרם לא סיים לעבד את התמונה או הסרטון בזמן/);
  assert.doesNotMatch(byKind.message, /פורמט/);
  assert.match(friendlyPublishError('אינסטגרם לא סיים לעבד את המדיה בזמן סביר', { platform: 'instagram' }).message,
    /עומס/);
});

test('תקלת רשת בפרסום לרשת — בודקים שלא עלה לפני שמנסים שוב', () => {
  const f = friendlyPublishError(new TypeError('fetch failed'), { platform: 'facebook' });
  assert.match(f.message, /לא הצלחנו להגיע לפייסבוק/);
  assert.match(f.message, /בודקים שהפוסט לא עלה/);
});

test('הודעה שלנו בעברית — כמו שהיא; לא מוכרת — כללית + הטקסט הגולמי בסוגריים', () => {
  const ours = 'אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום';
  assert.deepEqual(friendlyPublishError(ours), { who: 'owner', message: ours });
  const unknown = friendlyPublishError(graphErr('Some brand new weird failure', 999));
  assert.equal(unknown.who, 'owner');
  assert.match(unknown.message, /^הפרסום נכשל מסיבה שלא זיהינו/);
  assert.match(unknown.message, /\(Some brand new weird failure\)/);
  assert.match(friendlyPublishError('').message, /את הפרטים\.$/); // בלי סוגריים ריקים
});

/* ========================= פרסום שנתקע ========================= */

test('stuckPublishingError — רשתות אחרי 30 דקות, ניוזלטר אחרי יממה', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
  assert.equal(stuckPublishingError({ platform: 'facebook', started: ago(20) }, now), null);
  assert.equal(stuckPublishingError({ platform: 'instagram', started: ago(40) }, now), STUCK_SOCIAL_ERROR);
  assert.equal(stuckPublishingError({ platform: 'newsletter', started: ago(40) }, now), null);
  assert.equal(stuckPublishingError({ platform: 'newsletter', started: ago(25 * 60) }, now), STUCK_NEWSLETTER_ERROR);
  assert.equal(stuckPublishingError({ platform: 'facebook', started: null }, now), null);
});

test('stuckPublishingError — ניוזלטר שה-HUB עוד שולח נשאר עד 72 שעות; לא ענה — כשל אחרי יממה', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600000).toISOString();
  const nl = (h, hub) => stuckPublishingError({ platform: 'newsletter', started: hoursAgo(h), hub }, now);
  assert.equal(nl(30, 'active'), null);
  assert.equal(nl(30, 'unreachable'), STUCK_NEWSLETTER_ERROR);
  assert.equal(nl(30, null), STUCK_NEWSLETTER_ERROR); // לא נבדק (אין external_id / HUB לא מוגדר)
  assert.equal(nl(73, 'active'), STUCK_NEWSLETTER_CAP_ERROR);
  assert.equal(nl(10, 'unreachable'), null);
});

/** LIKE של SQL (רק %) → RegExp, לבדיקה שהתבניות תואמות את ההודעות האמיתיות */
const likeRe = (pat) => new RegExp(`^${pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');

test('MAYBE_OUT_PATTERNS — תופסות בדיוק את ההודעות של "אולי עלה", ולא שגיאה ידועה', async () => {
  const { MAYBE_OUT_PATTERNS } = await import('../src/publish/runner.js');
  const maybe = (m) => MAYBE_OUT_PATTERNS.some((p) => likeRe(p).test(m));
  const timeout = (maybeLive) => friendlyPublishError(
    Object.assign(new Error('timeout'), { kind: 'graph_timeout', maybeLive }), { platform: 'facebook' }).message;
  assert.ok(maybe(timeout(true)), 'מטא לא ענתה אחרי השליחה');
  assert.ok(!maybe(timeout(false)), 'מטא לא ענתה לפני השליחה — לא עלה');
  assert.ok(maybe(friendlyPublishError(new Error('fetch failed'), { platform: 'facebook' }).message), 'תקלת רשת');
  assert.ok(maybe(friendlyPublishError(new Error('weird thing xyz'), { platform: 'facebook' }).message), 'לא זיהינו');
  assert.ok(maybe('הפרסום סומן כתקוע ידנית על ידי דנה — בודקים בעמוד אם הפוסט עלה'), 'שחרור ידני');
  assert.ok(!maybe(friendlyPublishError(graphErr('Error validating access token', 190), { platform: 'facebook' }).message),
    'טוקן פג — בוודאות לא עלה');
});

/* ---------- סעיף 32: מה חוזר לבד ומה מתרכז ---------- */

test('retryableRejection — רק דחייה מפורשת וזמנית; לעולם לא "אולי עלה"', async () => {
  const { retryableRejection } = await import('../src/publish/errors.js');
  const g = (code, extra = {}) => Object.assign(new Error('x'), { code, status: 400, ...extra });
  for (const code of [4, 17, 32, 341, 613]) assert.equal(retryableRejection(g(code, { live: true })), true, String(code));
  assert.equal(retryableRejection(g(2)), true);
  assert.equal(retryableRejection(g(1, { live: true })), false, 'תקלה לא צפויה בקריאה שמעלה — אולי עלה');
  assert.equal(retryableRejection(g(190)), false);
  assert.equal(retryableRejection(g(368)), false);
  assert.equal(retryableRejection(Object.assign(new Error('t'), { kind: 'graph_timeout', maybeLive: false })), false);
  assert.equal(retryableRejection(Object.assign(new Error('t'), { kind: 'processing_timeout' })), false);
  assert.equal(retryableRejection(new TypeError('fetch failed')), false);
  assert.equal(retryableRejection(Object.assign(new Error('x'), { code: 4 })), false, 'בלי status — לא תשובה של מטא');
  assert.equal(retryableRejection('rate limit'), false);
  const hub = (status, answered) => Object.assign(new Error('h'), { name: 'HubMailError', status, answered });
  assert.equal(retryableRejection(hub(503, true)), true);
  assert.equal(retryableRejection(hub(502, false)), false);
  assert.equal(retryableRejection(hub(400, true)), false);
});

test('configErrorKind — לפי ההודעה הידידותית; פייסבוק ואינסטגרם נפרדים', async () => {
  const { configErrorKind } = await import('../src/publish/errors.js');
  const msg = (err, platform) => friendlyPublishError(err, { platform }).message;
  assert.equal(configErrorKind(msg('R2_PUBLIC_BASE_URL לא מוגדר', 'instagram'), 'instagram'), 'env:אחסון המדיה');
  assert.equal(configErrorKind(msg(Object.assign(new Error('x'), { code: 190 }), 'facebook'), 'facebook'), 'token:facebook');
  assert.equal(configErrorKind(msg(Object.assign(new Error('x'), { code: 190 }), 'instagram'), 'instagram'), 'token:instagram');
  assert.equal(configErrorKind(msg(Object.assign(new Error('x'), { code: 10 }), 'facebook'), 'facebook'), 'permission:facebook');
  assert.equal(configErrorKind(msg('אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום', 'facebook'), 'facebook'),
    'connection:facebook');
  assert.equal(configErrorKind(msg(Object.assign(new Error('x'), { name: 'HubMailError', status: 401 }))), 'hub_auth');
  assert.equal(configErrorKind(msg(Object.assign(new Error('x'), { code: 4 }), 'facebook'), 'facebook'), null);
  assert.equal(configErrorKind(msg('fetch failed', 'facebook'), 'facebook'), null);
});
