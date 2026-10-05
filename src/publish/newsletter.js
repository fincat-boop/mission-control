import { createHash } from 'node:crypto';

/**
 * ניוזלטר מול ה-HUB — הכללים הטהורים (בלי DB ובלי רשת), כדי שייבדקו בטסטים.
 *
 * הזרימה (החלטת בעלים, שלב 6):
 *   1. הניוזלטר נכתב ונשמר בלוח — טיוטה אצלנו, שום דבר לא נוצר ב-HUB.
 *   2. "העבר ל-HUB" (סמוך למועד) — רק אז נוצרת ב-HUB טיוטה שממתינה לאישור,
 *      עם המועד של הפוסט. הפוסט עובר ל-publishing ("בידי ה-HUB") ושומר את
 *      מזהה הקמפיין, הקישור למסך האישור והטביעה של מה שהועבר.
 *   3. בעל העסק מאשר ב-HUB; הלוח שואל על הסטטוס עד sent/failed.
 *   הרַנֶר לעולם לא יוצר ניוזלטר ב-HUB בעצמו. הגיע המועד ולא הועבר —
 *   משימה ברורה, לא שליחה.
 */

export const NOT_TRANSFERRED_ERROR =
  'הגיע המועד והניוזלטר לא הועבר ל-HUB, ולכן לא נשלח. קובעים מועד חדש ולוחצים "העבר ל-HUB".';
export const NOT_APPROVED_ERROR =
  'הניוזלטר עדיין ממתין לאישור ב-HUB יממה אחרי המועד — מאשרים אותו ב-HUB, או קובעים מועד חדש ומעבירים שוב';
export const HUB_MISSING_ERROR =
  'הקמפיין לא נמצא ב-HUB — כנראה נמחק שם. אם עדיין צריך לשלוח: קובעים מועד חדש ולוחצים "העבר ל-HUB"';
export const NEWSLETTER_NO_APPROVE =
  'ניוזלטר לא מאשרים כאן — לוחצים "העבר ל-HUB" סמוך למועד, ומאשרים את השליחה ב-HUB';

/** שדות-תוכן מוכרים בתבנית — לתצוגה בלבד (המילוי עצמו חופשי) */
export const CONTENT_FIELDS = ['תוכן', 'גוף הגיליון', 'גוף ההודעה'];

/** ערכי המילוי שיש בהם משהו (מחרוזות לא ריקות) — מה שנשמר ונשלח ל-HUB */
export function cleanFieldValues(values) {
  const out = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * יש למייל תוכן? גוף חופשי (בלי תבנית), או שדה כלשהו שמולא בעורך של
 * ה-HUB — עם תבנית, ה-HUB ממלא בעצמו כותרת ותאריך, והתבנית לא ריקה לעולם.
 */
export const hasNewsletterContent = (variant) =>
  !!variant?.body?.trim() || Object.keys(cleanFieldValues(variant?.meta?.field_values)).length > 0;

/**
 * מה חוסם ניוזלטר מלעבור ל-HUB, מבחינת התוכן שלו (null = כלום).
 * hubReady — האם HUB_API_* מוגדרים (הזרקה, לטסטים).
 */
export function newsletterBlocker({ post, variant }, hubReady) {
  if (!hubReady) return 'חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY בשרת)';
  if (!post.content_id) return 'אין תוכן משויך לפוסט';
  if (!variant || variant.status !== 'ready') return 'הגרסה לערוץ הזה עוד לא מסומנת "מוכן"';
  if (!hasNewsletterContent(variant)) {
    return 'אין תוכן למייל — ממלאים בעורך המייל של ה-HUB (או בשדה התוכן)';
  }
  if (!variant.meta?.subject?.trim()) return 'חסר נושא למייל — ממלאים בעריכת הגרסה של ערוץ המייל';
  // בלי רשימה — ה-HUB שולח לרשימת העל (ברירת המחדל שלו); אין חסימה.
  return null;
}

/** סטטוסים שמהם מותר "העבר ל-HUB" (פוסט שעוד לא יצא מהידיים שלנו) */
export const TRANSFER_FROM = ['scheduled', 'approved', 'failed'];

/**
 * האם "העבר ל-HUB" מותר עכשיו — null, או הודעה למשתמש. פוסט שכבר הועבר
 * (publishing/published עם external_id) לא מגיע לכאן: הנתיב מחזיר אותו
 * כמו שהוא (idempotent).
 */
export function transferBlocker(payload, { now = new Date(), hubReady = true } = {}) {
  const { post } = payload;
  if (post.platform !== 'newsletter') return 'רק ניוזלטר עובר ל-HUB';
  if (!TRANSFER_FROM.includes(post.status)) {
    return post.status === 'pending_approval'
      ? 'הפוסט ממתין לאישור כאן — קודם מאשרים אותו'
      : 'אפשר להעביר ל-HUB רק ניוזלטר שעוד לא יצא';
  }
  if (new Date(post.scheduled_at).getTime() <= now.getTime()) {
    return 'המועד עבר — קובעים מועד חדש ואז מעבירים ל-HUB';
  }
  return newsletterBlocker(payload, hubReady);
}

/** פוסט שכבר נמצא בידי ה-HUB — "העבר" שני מחזיר אותו כמו שהוא */
export const alreadyTransferred = (post) =>
  !!post.external_id && ['publishing', 'published'].includes(post.status);

/**
 * המפתח (external_ref) ליצירה ב-HUB. ה-HUB מחזיר קמפיין קיים לאותו
 * מפתח ולא יוצר שני — זו ההגנה מפני לחיצה כפולה ומפני ניסיון חוזר.
 * prior — מה ה-HUB אמר על הקמפיין הקודם של הפוסט (אם היה):
 *   'failed' — נכשל סופית: אותו מפתח היה מחזיר את הכושל, אז מספר חדש
 *   כל השאר (נמחק / אין קודם) — אותו מפתח; קמפיין שנמחק משחרר אותו.
 * דטרמיניסטי: אם הכתיבה אצלנו נפלה אחרי שה-HUB יצר, הניסיון הבא מגיע
 * לאותו מפתח ומקבל את מה שכבר נוצר — לא טיוטה כפולה.
 */
export function nextHubRef(postId, hubRef, prior = null) {
  const base = `post-${postId}`;
  const cur = hubRef || base;
  if (prior !== 'failed') return cur;
  const m = cur.match(/^post-\d+-(\d+)$/);
  return `${base}-${m ? Number(m[1]) + 1 : 2}`;
}

/** קמפיין קודם ב-HUB שאפשר לחזור אליו ("העבר" אחרי שחרור/כשל אצלנו) */
export const reusableHubStatus = (status) => ['draft', 'scheduled', 'sending', 'sent'].includes(status);

/**
 * מה הסטטוס ב-HUB אומר לפוסט שממתין: 'draft' — מחכה לאישור בעל העסק,
 * 'active' — אושר ומתוזמן/נשלח, null — סטטוס סופי (מטופל בנפרד) או לא מוכר.
 */
export function hubWaitState(status) {
  if (status === 'draft') return 'draft';
  if (['scheduled', 'sending'].includes(status)) return 'active';
  return null;
}

/**
 * מאיזה רגע סופרים "תקוע" לניוזלטר: המאוחר מבין ההעברה ל-HUB לבין המועד
 * (של ה-HUB אם ידוע, אחרת שלנו). ניוזלטר שהועבר שלושה ימים מראש לא תקוע.
 */
export function newsletterClockStart({ started, scheduled }) {
  const a = started ? new Date(started).getTime() : NaN;
  const b = scheduled ? new Date(scheduled).getTime() : NaN;
  if (Number.isNaN(a)) return Number.isNaN(b) ? null : new Date(b);
  return new Date(Number.isNaN(b) ? a : Math.max(a, b));
}

/**
 * טביעת אצבע של מה שהועבר ל-HUB: נושא, גוף, ערכי מילוי, תבנית, רשימות,
 * שם ומועד. נשמרת על הפוסט בהעברה; שינוי בלוח אחרי ההעברה משנה אותה,
 * והחלון מזהיר ש"השינוי לא יגיע ל-HUB" (ל-HUB אין נתיב עדכון).
 */
export function newsletterDigest({ post, variant }) {
  const m = variant?.meta ?? {};
  const fv = cleanFieldValues(m.field_values);
  const sorted = Object.fromEntries(Object.keys(fv).sort().map((k) => [k, fv[k]]));
  const payload = JSON.stringify([
    m.subject ?? '', variant?.body ?? '', sorted, m.template_id ?? null,
    [...(m.list_ids ?? [])].sort(), [...(m.segment_ids ?? [])].sort(),
    post.title ?? '', new Date(post.scheduled_at).toISOString(),
  ]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** השתנה משהו בלוח מאז ההעברה? (פוסט שהועבר לפני שהטביעה נשמרה — לא ידוע, false) */
export const hubStale = (payload) =>
  !!payload.post.hub_digest && newsletterDigest(payload) !== payload.post.hub_digest;
