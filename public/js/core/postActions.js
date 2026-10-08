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
 * autopublish — מתג-העל של הארגון (state.autopublish). כבוי = אין פרסום
 * אוטומטי בכלל (8.10.26): autoReady תמיד false, ובלי "העבר ל-HUB" / "בטל אישור".
 * @param {object} post
 * @param {object|null} variant הגרסה של התוכן לערוץ של הפוסט
 * @param {{autopublish?: boolean}} [opts]
 */
export function postFacts(post, variant, { autopublish = true } = {}) {
  return {
    status: post.status,
    scheduled_at: post.scheduled_at,
    platform: post.platform,
    autopublish,
    autoReady: autopublish && autoReady(post),
    // ניוזלטר שהועבר ל-HUB (גם אם נכשל) — "פתח ב-HUB"
    externalUrl: post.external_url ?? null,
    hasContent: !!post.content_id,
    variantReady: variant?.status === 'ready',
    // ניוזלטר שהועבר ל-HUB מחכה לאישור ולמועד — "תקוע" נספר רק מהמועד
    // (המאוחר מבין ההעברה למועד), כמו resetClockStart בשרת
    publishingStartedAt: post.hub_transferred_at && post.publishing_started_at
      ? new Date(Math.max(new Date(post.publishing_started_at).getTime(),
        new Date(post.scheduled_at).getTime())).toISOString()
      : post.publishing_started_at ?? null,
    // ניוזלטר שבידי ה-HUB: הקישור למסך האישור שם
    hubUrl: post.platform === 'newsletter' && post.status === 'publishing' ? post.external_url ?? null : null,
  };
}

/** אחרי כמה זמן בפרסום מותר "שחרר פרסום תקוע" — כמו RESET_MIN_MS בשרת */
export const STUCK_AFTER_MS = 10 * 60000;

/** בפרסום מעל 10 דקות (או בלי זמן התחלה — שורה ישנה) */
export const publishingStuck = (f, now = new Date()) => f.status === 'publishing' &&
  (f.publishingStartedAt == null ||
   now.getTime() - new Date(f.publishingStartedAt).getTime() >= STUCK_AFTER_MS);

/** "קבע מועד חדש" גם מאשר מיד לפרסום אוטומטי? רק כשהאישור יעבור בשרת. */
export function rescheduleApproves(f, perms) {
  // ניוזלטר לא מאושר כאן — אחרי מועד חדש מעבירים אותו ל-HUB
  return f.platform !== 'newsletter' && ['scheduled', 'failed'].includes(f.status) && !!perms.approve &&
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
  // ניוזלטר שהועבר ל-HUB — האישור והשינויים שם
  if (f.status === 'publishing' && f.hubUrl) return only('openHub');
  // בפרסום — רק אחרי 10 דקות זה "תקוע"; לפני זה הוא כנראה עוד רץ
  if (f.status === 'publishing') {
    return perms.approve && publishingStuck(f, now) ? only('resetPublishing') : NONE;
  }
  if (f.status === 'pending_approval') {
    if (!perms.approve) return NONE;
    // המועד עבר — השרת לא יאשר; קודם מועד חדש (הרשאת תוכן), או דחייה
    if (past) return perms.content ? { primary: 'reschedule', secondary: 'reject' } : only('reject');
    return { primary: 'approvePending', secondary: 'reject' };
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

  // ניוזלטר עתידי עם תוכן מוכן: לא "מאשרים" כאן — מעבירים ל-HUB, ומאשרים שם.
  // פרסום אוטומטי כבוי — אין העברה: הניוזלטר נשלח ביד ומסומן "פורסם"
  if (f.platform === 'newsletter' && f.autopublish !== false && !past && f.hasContent && f.variantReady &&
      ['scheduled', 'approved', 'failed'].includes(f.status)) {
    return perms.approve ? only('transferHub') : NONE;
  }

  if (f.status === 'failed') {
    // פרסום אוטומטי כבוי: נכשל שנשאר נכשל אולי כבר יצא (runner.js maybeOutSql)
    // — בודקים ומסמנים "פורסם"; ניוזלטר שהועבר — בודקים ב-HUB
    if (f.autopublish === false) {
      if (!perms.content) return NONE;
      return { primary: 'markPublished',
               secondary: f.platform === 'newsletter' && f.externalUrl ? 'openHub' : null };
    }
    if (past) return perms.content ? only('reschedule') : NONE;
    // נכשל והוזז כבר למועד עתידי — נשאר רק לאשר שוב
    if (perms.approve && f.autoReady && f.hasContent && f.variantReady) return only('approve');
    return !f.hasContent && perms.content ? only('attach') : NONE;
  }

  if (!f.hasContent) return perms.content ? only('attach') : NONE;
  if (f.status === 'approved') return perms.approve && f.autopublish !== false ? only('unapprove') : NONE;

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
 * ברירת המחדל לשעה בחלון "מבצע דחוף": שעת הפרסום הרגילה של הערוץ (base,
 * channels.default_hour — בלעדיה 10:00, סעיף 12), או — כשזה כבר מאוחר מזה
 * היום — השעה העגולה הבאה (עד 21:00; אחר כך שוב השעה הרגילה, למחר).
 */
export function defaultUrgentTime(now = new Date(), base = 10) {
  const next = nextFullHour(now);
  const sameDay = next.getDate() === now.getDate();
  const h = next.getHours();
  return `${String(sameDay && h > base && h <= 21 ? h : base).padStart(2, '0')}:00`;
}

/** שעת הפרסום הרגילה של ערוץ בלקוח — כמו channelHour בשרת (סעיף 12) */
export const channelHour = (ch) => (ch?.default_hour == null ? 10 : Number(ch.default_hour));

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

/**
 * מה לשלוח ב-PATCH מלשונית העריכה: רק שדות ששונו מול מה שנטען לטופס
 * (snapshot), לא מול הפוסט — כך מועד עם שניות שלא נגעו בו לא "מתעגל",
 * אחראי שלא נגעו בו לא מתאפס, וערוץ ריק לא נשלח כ-0.
 * ערכים: מחרוזות כמו בטופס (date, time, channel, assignee, title, note).
 * @returns {{body: object} | {error: string}}
 */
export function editPatch(snap, v) {
  if (!v.title) return { error: 'צריך כותרת לפוסט' };
  const body = {};
  if (v.date !== snap.date || v.time !== snap.time) {
    const when = new Date(`${v.date}T${v.time}:00`);
    if (!v.date || !v.time || Number.isNaN(when.getTime())) return { error: 'צריך תאריך ושעה' };
    body.scheduled_at = when.toISOString();
  }
  if (v.channel !== snap.channel && Number(v.channel) > 0) body.channel_id = Number(v.channel);
  if (v.assignee !== snap.assignee) body.assignee_id = v.assignee ? Number(v.assignee) : null;
  if (v.title !== snap.title) body.title = v.title;
  if (v.note !== snap.note) body.note = v.note || null;
  return { body };
}
