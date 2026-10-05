/**
 * איזו פעולה היא "הפעולה הראשית" של פוסט, לפי המצב שלו. שכבה 0 — פונקציות
 * טהורות בלבד (בלי DOM ובלי state), ולכן נבדקות בטסטים
 * (test/post-actions.test.js). חלון הפוסט מציג את הראשית (ולפעמים משנית)
 * בפוטר, וכל השאר נשאר בתפריט "עוד".
 */

/** פלטפורמות שיש להן פרסום אוטומטי בכלל */
export const AUTO_PLATFORMS = ['facebook', 'instagram', 'newsletter'];

/**
 * פוסט מאושר שהמועד שלו עבר עוד יכול להיתפס בטיק הקרוב (כל דקה) — רק
 * אחרי מרווח כזה הוא "עבר המועד" ולא "עומד לצאת".
 */
export const APPROVED_GRACE_MS = 15 * 60000;

const time = (p) => new Date(p.scheduled_at).getTime();

/**
 * פוסט שהמועד שלו עבר והוא לא יצא: מתוכנן שהמועד עבר, או מאושר שהטיק לא
 * תפס אחרי APPROVED_GRACE_MS. נכשל וממתין לאישור — מצבים משלהם, לא "עבר".
 */
export function isMissed(post, now = new Date()) {
  if (post.status === 'scheduled') return time(post) < now.getTime();
  if (post.status === 'approved') return time(post) < now.getTime() - APPROVED_GRACE_MS;
  return false;
}

/**
 * האם הפוסט יכול לצאת בפרסום אוטומטי: פלטפורמה עם אינטגרציה, חיבור קיים
 * ופרסום אוטומטי דלוק לערוץ (ניוזלטר: השרת מחזיר את שניהם לפי HUB_API_*).
 * בלי autopub_enabled אישור נכשל בשרת — אז לא מציעים אותו בכלל.
 */
export const autoReady = (post) =>
  AUTO_PLATFORMS.includes(post.platform) && !!post.autopub_connected && !!post.autopub_enabled;

/**
 * העובדות שהבחירה נשענת עליהן, מתוך תשובת /posts/:id/preview.
 * @param {object} post
 * @param {object|null} variant הגרסה של התוכן לערוץ של הפוסט
 */
export function postFacts(post, variant) {
  return {
    status: post.status,
    scheduled_at: post.scheduled_at,
    platform: post.platform,
    autoReady: autoReady(post),
    hasContent: !!post.content_id,
    variantReady: variant?.status === 'ready',
  };
}

/** "קבע מועד חדש" גם מאשר מיד לפרסום אוטומטי? רק כשהאישור יעבור בשרת. */
export function rescheduleApproves(f, perms) {
  return f.status !== 'approved' && !!perms.approve &&
    f.autoReady && f.hasContent && f.variantReady;
}

const NONE = Object.freeze({ primary: null, secondary: null });
const only = (primary) => ({ primary, secondary: null });

/**
 * הפעולה הראשית (ולפעמים משנית) לפי מצב הפוסט, יכולת הערוץ, תוכן, זמן והרשאות.
 * מחזיר מפתחות מתוך ACT בחלון הפוסט; null = אין פעולה ראשית.
 *
 * @param {ReturnType<typeof postFacts>} f
 * @param {{content?: boolean, approve?: boolean}} perms
 */
export function choosePrimary(f, perms, now = new Date()) {
  const past = time(f) < now.getTime();

  if (f.status === 'published') return NONE;
  if (f.status === 'publishing') return perms.approve ? only('resetPublishing') : NONE;
  if (f.status === 'pending_approval') {
    return perms.approve ? { primary: 'approvePending', secondary: 'reject' } : NONE;
  }
  if (!perms.content && !perms.approve) return NONE;

  // עבר המועד ולא יצא
  if (isMissed(f, now)) {
    if (!perms.content) return NONE;
    // מאושר שלא נתפס — מועד חדש, והאישור נשאר
    if (f.status === 'approved') return only('reschedule');
    // ערוץ ידני (וואטסאפ, ידני, או שהפרסום האוטומטי כבוי) — כנראה יצא ביד
    return only(f.autoReady ? 'reschedule' : 'markPublished');
  }

  if (f.status === 'failed') {
    if (past) return perms.content ? only('reschedule') : NONE;
    // נכשל והוזז כבר למועד עתידי — נשאר רק לאשר שוב
    if (perms.approve && f.autoReady && f.hasContent && f.variantReady) return only('approve');
    return !f.hasContent && perms.content ? only('attach') : NONE;
  }

  if (!f.hasContent) return perms.content ? only('attach') : NONE;
  if (f.status === 'approved') return perms.approve ? only('unapprove') : NONE;

  // מתוכנן, עתידי, עם תוכן
  if (perms.approve && f.autoReady && f.variantReady) return only('approve');
  if (!f.variantReady && perms.content) return only('openContent');
  return NONE;
}

/** השעה העגולה הבאה, לפחות רבע שעה מעכשיו (10:40 → 11:00, 10:50 → 12:00) */
export function nextFullHour(now = new Date()) {
  const d = new Date(now.getTime() + 15 * 60000);
  if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

/**
 * ברירת המחדל לשעה בחלון "מבצע דחוף": 10:00, או — כשזה כבר מאוחר מזה
 * היום — השעה העגולה הבאה (עד 21:00; אחר כך שוב 10:00, למחר).
 */
export function defaultUrgentTime(now = new Date()) {
  const next = nextFullHour(now);
  const sameDay = next.getDate() === now.getDate();
  const h = next.getHours();
  return sameDay && h > 10 && h <= 21 ? `${String(h).padStart(2, '0')}:00` : '10:00';
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const hourKey = (d) => `${dayKey(d)} ${d.getHours()}`;

/**
 * ברירת המחדל ל"קבע מועד חדש": השעה העגולה הפנויה הבאה בערוץ — לפחות רבע
 * שעה מעכשיו, בשעות הפעילות, לא ביום חסום לערוץ, לא בשעה שכבר יש בה פוסט
 * בערוץ, ולא ביום שבו לאותה נקודת קצה כבר יש פוסט בערוץ (השרת דוחה את זה).
 * לא נמצא בתוך `days` ימים — השעה העגולה הבאה, והשרת יגיד מה לא מתאים.
 *
 * @param {{now?: Date, busy?: {at: string|Date, endpoint_id?: number|null}[],
 *          blockedDays?: number[], endpointId?: number|null,
 *          firstHour?: number, lastHour?: number, days?: number}} o
 */
export function nextFreeSlot({
  now = new Date(), busy = [], blockedDays = [], endpointId = null,
  firstHour = 9, lastHour = 20, days = 14,
} = {}) {
  const taken = new Set(busy.map((b) => hourKey(new Date(b.at))));
  const epDays = new Set(endpointId
    ? busy.filter((b) => b.endpoint_id === endpointId).map((b) => dayKey(new Date(b.at))) : []);
  const limit = now.getTime() + days * 86400000;
  const t = nextFullHour(now);
  while (t.getTime() < limit) {
    if (t.getHours() < firstHour) {
      t.setHours(firstHour, 0, 0, 0);
    } else if (t.getHours() > lastHour) {
      t.setDate(t.getDate() + 1);
      t.setHours(firstHour, 0, 0, 0);
      continue;
    }
    if (blockedDays.includes(t.getDay()) || epDays.has(dayKey(t))) {
      t.setDate(t.getDate() + 1);
      t.setHours(firstHour, 0, 0, 0);
      continue;
    }
    if (!taken.has(hourKey(t))) return new Date(t);
    t.setHours(t.getHours() + 1, 0, 0, 0);
  }
  return nextFullHour(now);
}
