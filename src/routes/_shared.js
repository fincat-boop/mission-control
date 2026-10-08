import multer from 'multer';
import { currentOrg, one, query, rows } from '../db.js';
import {
  applyWeek, lockEngine, mergeLimits, notPlacedNotes, promoBlockedOf, withEngineLock,
} from '../engine.js';
import { weekMeta, ymd } from '../board.js';
import { relocateBlocked } from '../respace.js';
import { FILL_HORIZON_WEEKS } from '../capacity.js';
import { TYPE_ERROR, isAllowedMime } from '../media.js';

/**
 * עזרים שכל קובצי הנתיבים נשענים עליהם.
 *
 * הקובץ הזה לא מגדיר אף נתיב — הוא רק התשתית המשותפת, כדי ששום קובץ
 * נתיבים לא יצטרך לייבא מקובץ נתיבים אחר.
 */

/** עוטף handler אסינכרוני כך ששגיאה תגיע ל-error handler במקום להפיל את התהליך */
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/**
 * השבועות שהמילוי האוטומטי המלא עובר עליהם (סעיף 13, החלטה ה2): השבוע
 * הנוכחי והשבוע הבא, בשעון ישראל (התהליך רץ ב-TZ=Asia/Jerusalem) — לא משנה
 * איזה שבוע הלקוח מציג. תחילות שבוע, YYYY-MM-DD.
 */
export function nearWeeks(now = new Date()) {
  const start = weekMeta(now).start;
  // צהריים ולא חצות — שמעבר שעון לא יזיז את היום
  const next = new Date(`${start}T12:00:00`);
  next.setDate(next.getDate() + 7);
  return [start, ymd(next)];
}

/** מילוי מלא (לא מרוסן לקמפיין) של השבוע הנוכחי והבא, בתוך נעילת המנוע של הקורא */
async function fillNearWeeks(now = new Date()) {
  const results = [];
  for (const w of nearWeeks(now)) {
    results.push(await applyWeek(`${w}T12:00:00`, { holes: false, now }));
  }
  return mergeFillResults(results);
}

/**
 * מריץ מילוי אוטומטי של המנוע אחרי שינוי בקלט שלו (כלל, תוכן שוטף, נקודת
 * קצה, ערוץ) — על השבוע הנוכחי והבא (nearWeeks, סעיף 13). קודם המילוי רץ על
 * השבוע שהלקוח הציג: מי שדפדף לינואר ושינה ערוץ מילא את ינואר וצרך שם את
 * התוכן השוטף, והשבוע הנוכחי נשאר ריק. week — השבוע שהלקוח מציג; נשאר
 * בחתימה (הלקוח עדיין שולח אותו), ולא משפיע. התשובה מאוחדת על שני השבועות
 * (mergeFillResults), כך ש"בטל" מכסה את שניהם. לא נכשלת כשאין מה למלא, ולא
 * מפילה את הבקשה המקורית אם הריצה נתקלת בבעיה — המוטציה שכבר נשמרה
 * חשובה יותר מהמילוי האוטומטי שאחריה.
 *
 * מרוסן (docs/ux-overhaul.md, עיקרון 1): משבץ ומשייך רק תוכן קיים. פוסטים
 * חסרי תוכן ומשימות "לכתוב" נוצרים רק מחלון "מלא את השבוע". התשובה כוללת
 * את מזהי מה שנוצר/שויך, כדי שהלקוח יוכל להציע "בטל" (POST /engine/undo).
 *
 * savepoint: הבקשה כולה היא טרנזקציה אחת (withOrg). שגיאת SQL באמצע
 * המילוי הייתה משאירה את הטרנזקציה שבורה, וה-commit בסוף היה מתגלגל
 * אחורה בשקט — כולל השינוי שהמשתמש ביקש. ה-savepoint תוחם את הנזק למילוי.
 */
export function autoFill(week) {
  return guardedFill('autoFill', () => withEngineLock(() => fillNearWeeks()));
}

/**
 * נעילת המנוע של הארגון לפני כתיבה שמזיזה / מורידה פוסטים (הזזת קמפיין,
 * בדיקה מחדש מול הכללים) — עד ה-commit, יחד עם המילוי שאחריה. נלקחת לפני
 * כל כתיבה בבקשה: נעילה תפוסה עונה 503 בלי להשאיר שמירה חצויה.
 * @returns {Promise<boolean>} false — כבר נענה 503, הקורא יוצא
 */
export async function lockEngineOr503(res) {
  try {
    await lockEngine();
    return true;
  } catch (e) {
    if (e?.code !== '55P03') throw e;
    bad(res, 'מילוי אחר של הלוח רץ ממש עכשיו — מנסים לשמור שוב בעוד רגע', 503);
    return false;
  }
}

/**
 * savepoint + fail-soft משותפים ל-autoFill, ל-autoFillCampaign ולמילוי היומי (ראו למעלה).
 * בתוך ה-savepoint — נעילת המנוע של הארגון (lockEngine) עד ה-commit של
 * הבקשה. מילוי אחר שמחזיק אותה יותר מ-5 שניות: המילוי הזה מוותר (תשובה
 * ריקה + לוג), והשינוי של המשתמש נשמר כרגיל. לפני withEngineLock, כדי
 * שבקשה שמחכה לנעילה של ארגון אחד לא תעכב בשרשרת מילויים של ארגונים אחרים.
 */
async function guardedFill(label, run) {
  const inTx = currentOrg() != null;
  try {
    if (inTx) {
      await query('savepoint auto_fill');
      await lockEngine();
    }
    const out = await run();
    if (inTx) await query('release savepoint auto_fill');
    return out;
  } catch (e) {
    if (inTx) await query('rollback to savepoint auto_fill').catch(() => {});
    if (e?.code === '55P03') {
      console.error(`${label}: מילוי אחר של הארגון מחזיק את המנוע — המילוי הזה דולג`);
    } else {
      console.error(`${label} נכשל:`, e);
    }
    return EMPTY_FILL;
  }
}

/** כמה שבועות לכל היותר ממלאים בשמירת קמפיין — חצי שנה (capacity.js, מקור אחד) */
export const CAMPAIGN_FILL_MAX_WEEKS = FILL_HORIZON_WEEKS;

/**
 * השבועות (תחילת שבוע, YYYY-MM-DD) שמילוי של קמפיין עובר עליהם: כל שבוע
 * שחופף ל-[max(היום, starts_on), ends_on], עד CAMPAIGN_FILL_MAX_WEEKS.
 * null — אין תקופה למלא: הקמפיין לא קיים, לא פעיל, מושהה, בלי תאריך סיום,
 * או שהתקופה כבר נגמרה.
 */
export function campaignFillWeeks(c, today = ymd(new Date())) {
  if (!c || !c.active || c.paused_at || !c.ends_on) return null;
  const end = String(c.ends_on).slice(0, 10);
  const starts = c.starts_on ? String(c.starts_on).slice(0, 10) : today;
  const from = starts > today ? starts : today;
  if (from > end) return null;
  const weeks = [];
  // צהריים ולא חצות — שמעבר שעון לא יזיז את היום
  const d = new Date(`${weekMeta(`${from}T12:00:00`).start}T12:00:00`);
  while (ymd(d) <= end && weeks.length < CAMPAIGN_FILL_MAX_WEEKS) {
    weeks.push(ymd(d));
    d.setDate(d.getDate() + 7);
  }
  return weeks;
}

/**
 * מאחד תוצאות applyWeek של כמה שבועות לתשובה אחת באותה צורה, כדי שההודעה
 * ו"בטל" של הלקוח יכסו את כולם. weeks — בכמה שבועות נכתב משהו;
 * limits — mergeLimits: לכל תוכן×ערוץ פעם אחת, ובלי מה שנכנס באחד השבועות
 * (placed_pairs); promo_blocked ו-limit_notes נבנים מחדש מהמאוחד.
 */
export function mergeFillResults(list) {
  const sum = (k) => list.reduce((s, r) => s + (r[k] ?? 0), 0);
  const cat = (k) => list.flatMap((r) => r[k] ?? []);
  // לפי התוכן, לא לפי שבוע: תוכן שנכנס בשבוע אחר לא "לא נכנס" (mergeLimits)
  const limits = mergeLimits(list.map((r) => r.limits), cat('placed_pairs'));
  return {
    placed: sum('placed'), attached: sum('attached'), holes: sum('holes'),
    skipped: sum('skipped'), dropped: cat('dropped'), promo_blocked: promoBlockedOf(limits),
    limits, limit_notes: notPlacedNotes(limits), placed_pairs: cat('placed_pairs'),
    created_ids: cat('created_ids'), created_items: cat('created_items'),
    attached_items: cat('attached_items'), summary: cat('summary'),
    weeks: list.filter((r) => r.placed || r.attached || r.holes).length,
    covered_weeks: [...new Set(cat('covered_weeks'))],
  };
}

/**
 * מילוי אוטומטי של כל התקופה של קמפיין — אחרי שינוי במה שהקמפיין צריך או
 * מתי (יצירה, עריכה, שכפול, מוכן/פתיחה מחדש, המרה, הרצה מחזורית, חזרה
 * מהשהיה, תוכן חדש בו). קודם רק השבוע שהלקוח הציג התמלא, וקמפיין של שלושה
 * שבועות התמלא רק בשבועות שמישהו במקרה פתח.
 *
 * אותו ריסון כמו autoFill (holes:false — רק תוכן קיים), אותו savepoint
 * ואותה התנהגות בכשל. נעילת מנוע אחת לכל השבועות: withEngineLock היא שרשרת
 * הבטחות, וקריאה מקוננת בתוכה הייתה מחכה לעצמה — ולכן applyWeek ישירות.
 * השבועות לפי הסדר, באותה טרנזקציה: כל שבוע רואה את מה שנכתב בקודמים
 * (ותק, מרווח, תוכן חד-פעמי שכבר שובץ).
 *
 * מרוסן לקמפיין (onlyCampaignId): בשבועות הרחוקים משובץ ומשויך רק התוכן
 * של הקמפיין הזה — שמירת קמפיין לא צורכת תוכן שוטף של נקודות אחרות לחודשים
 * קדימה. השבוע הנוכחי והבא (nearWeeks, סעיף 13) מתמלאים במלואם, כמו
 * autoFill — גם כשהם מחוץ לתקופת הקמפיין. קודם — השבוע שהלקוח הציג.
 *
 * קמפיין בלי תקופה למלא (campaignFillWeeks → null) — רק השבוע הנוכחי והבא,
 * כמו autoFill: למשל השהיה/השבתה מפנה מקום שאחרים יכולים לתפוס.
 * viewedWeek — השבוע שהלקוח מציג; נשאר בחתימה ולא משפיע (סעיף 13).
 */
export function autoFillCampaign(campaignId, viewedWeek) {
  return guardedFill('autoFillCampaign', async () => {
    const c = campaignId
      ? await one('select id, starts_on, ends_on, active, paused_at from campaigns where id = $1',
        [campaignId])
      : null;
    const weeks = campaignFillWeeks(c);
    if (!weeks) return withEngineLock(() => fillNearWeeks());
    const near = nearWeeks();
    const all = [...new Set([...weeks, ...near])].sort();
    return withEngineLock(async () => {
      const results = [];
      for (const w of all) {
        results.push(await applyWeek(`${w}T12:00:00`,
          { holes: false, onlyCampaignId: near.includes(w) ? null : c.id }));
      }
      return mergeFillResults(results);
    });
  });
}

/**
 * המילוי היומי (סעיף 13): השבוע הנוכחי והבא של הארגון הנוכחי, כך שהשבועות
 * הקרובים מתמלאים גם כשאף אחד לא פותח אותם. אותו מסלול כמו autoFill (savepoint,
 * נעילת המנוע, מרוסן — רק תוכן קיים). המנוע ממלא רק מקום פנוי: ריצה חוזרת
 * באותו יום לא מוסיפה כלום, אבל ריצה ביום אחר באמצע השבוע יכולה להוסיף
 * לימים שנשארו (לכל היותר פוסט לנקודה×ערוץ ביום, ועד התקציב השבועי של
 * הערוץ) — למשל תוכן שנכתב מאז. בלי "בטל": הפוסטים שלו הם פוסטים רגילים של
 * המנוע. רץ בתוך withOrg (forEachOrg). now — לבדיקות.
 */
export function dailyFill({ now = new Date() } = {}) {
  return guardedFill('dailyFill', () => withEngineLock(() => fillNearWeeks(now)));
}

/** תשובת מילוי ריקה — אותה צורה כמו applyWeek, כדי שהלקוח לא יצטרך לבדוק */
export const EMPTY_FILL = Object.freeze({
  placed: 0, attached: 0, holes: 0, skipped: 0, dropped: [], limits: [], limit_notes: [],
  placed_pairs: [],
  created_ids: [], created_items: [], attached_items: [], summary: [],
});

/**
 * מפנה פוסטים שיושבים על ימים שנחסמו לערוץ שלהם. רץ אחרי שינוי הגדרות
 * ערוץ, כי חסימת יום היא הצהרה על כל הלוח ולא רק על שיבוצים עתידיים —
 * בלי זה פוסט שכבר שובץ נשאר על היום החסום לנצח.
 *
 * fail-soft כמו autoFill: השמירה עצמה חשובה יותר מהפינוי שאחריה. פוסט
 * שלא נמצא לו יום חוקי חוזר ב-stuck, וגם מופיע כהתראה קבועה ב-alerts.js.
 */
export async function evictBlocked() {
  try {
    const { moved, stuck } = await relocateBlocked();
    return {
      moved,
      stuck: stuck.map((p) => ({
        id: p.id, title: p.title,
        channel_name: p.channel_name, scheduled_at: p.scheduled_at,
      })),
    };
  } catch (e) {
    console.error('פינוי ימים חסומים נכשל:', e);
    return { moved: 0, stuck: [] };
  }
}

/**
 * החזקה שהסתיימה (סעיף 16): פוסט מאושר שהמועד שלו עבר בזמן שהיה מוחזק חוזר
 * ל"מתוכנן" בלי אישור — אחרת הטיק הבא היה מפרסם בבת אחת את כל מה שהצטבר
 * (עד MAX_LATE_HOURS אחורה). מכאן הוא עובר במסלול הרגיל: "לא סומן כפורסם"
 * (unconfirmed.js) — מי שרוצה שיצא, משבץ אותו מחדש ומאשר שוב.
 * where — תנאי SQL פנימי על posts p (לא מקלט משתמש), params — שלו.
 * since — מתי ההחזקה התחילה (paused_at / disabled_at): רק מה שהמועד שלו אחרי
 * הרגע הזה פוספס בגללה. null — לא ידוע (הושבת לפני העמודה): כל מה שעבר.
 * מחזיר כמה חזרו.
 */
export async function resetMissedApprovals(where, params, { since = null } = {}) {
  const n = params.length + 1;
  const r = await query(
    `update posts p set status = 'scheduled', approved_by = null, approved_at = null
      where p.status = 'approved' and p.scheduled_at < now() and ${where}
        and ($${n}::timestamptz is null or p.scheduled_at >= $${n}::timestamptz)
      returning p.id`,
    [...params, since]);
  return r.rowCount;
}

/**
 * מה "מוחזק" לכל סוג החזקה — תנאי SQL על פוסט בכינוי a, כשהמזהה הוא $1:
 * קמפיין מושהה (התוכן שלו), נקודה מושבתת, ערוץ מושבת.
 */
export const HELD_SCOPE = {
  campaign: (a) => `exists (select 1 from content_items hci
                             where hci.id = ${a}.content_id and hci.campaign_id = $1)`,
  endpoint: (a) => `${a}.endpoint_id = $1`,
  channel: (a) => `${a}.channel_id = $1`,
};

/**
 * חזרה מהחזקה — קמפיין שחזר מהשהיה, נקודה או ערוץ שהופעלו מחדש (סעיף 16).
 * לשלושתם: מאושר שהמועד שלו עבר בזמן ההחזקה חוזר לאישור (resetMissedApprovals)
 * — בלי פרץ פרסומים בטיק הבא.
 *
 * נקודה / ערוץ (החלטת מוצר: "לא מאבדים עבודה" — נקודה יכולה לשאת הרבה
 * פוסטים ששובצו ביד עם תוכן): שום דבר לא נמחק. הפוסטים חוזרים בדיוק למקום
 * שלהם, והמילוי שאחרי (refillCampaigns) רק ממלא מקום פנוי. שבוע שעבר את
 * התקרה בגלל מה שהמנוע מילא בזמן ההשבתה — אזהרות המכסות בלוח מראות אותו.
 * back — כמה פוסטים עתידיים חזרו ללוח.
 *
 * קמפיין (כמו תמיד): המשבצות העתידיות קפאו, ובינתיים המנוע כבר יכול היה
 * למלא את המקום במשהו אחר. במקום להחזיר לאותו מקום (התנגשות / חריגה),
 * מנקים את מה שעוד לא יצא ולא אושר, והמנוע ממקם מחדש. מאושר עתידי נשאר —
 * מישהו בדק ואישר אותו במועד הזה — אלא אם בזמן ההחזקה פוסט אחר (מחוץ
 * להחזקה) תפס את אותה נקודה+ערוץ+יום: היו יוצאים שניים, ולכן הוא מתפנה.
 * kind — מפתח ב-HELD_SCOPE; id — המזהה שלו; since — מתי ההחזקה התחילה
 * (paused_at / disabled_at, נקרא לפני העדכון), ראו resetMissedApprovals.
 * @returns {Promise<{reset:number, cleared:number, back:number}>}
 */
export async function releaseHeld(kind, id, { since = null } = {}) {
  const scope = HELD_SCOPE[kind];
  const reset = await resetMissedApprovals(scope('p'), [id], { since });
  if (kind !== 'campaign') {
    const { n } = await one(
      `select count(*)::int as n from posts p
        where ${scope('p')}
          and p.status in ('scheduled','approved','failed','pending_approval','hole')
          and p.scheduled_at >= now()`, [id]);
    return { reset, cleared: 0, back: n };
  }
  const cleared = await rows(
    `delete from posts p
      where ${scope('p')}
        and p.status in ('scheduled','failed','pending_approval','hole')
        and p.scheduled_at >= now()
      returning p.id`,
    [id]
  );
  const clashed = await rows(
    `delete from posts p
      where ${scope('p')}
        and p.status = 'approved' and p.scheduled_at >= now()
        and exists (select 1 from posts o
                     where o.id <> p.id and o.endpoint_id = p.endpoint_id
                       and o.channel_id = p.channel_id
                       and (o.scheduled_at at time zone 'Asia/Jerusalem')::date
                         = (p.scheduled_at at time zone 'Asia/Jerusalem')::date
                       and not (${scope('o')}))
      returning p.id`,
    [id]
  );
  return { reset, cleared: cleared.length + clashed.length, back: 0 };
}

/**
 * שיבוץ מחדש אחרי releaseHeld: כל תקופת הקמפיינים שהשתחררו (autoFillCampaign,
 * כולל השבוע שהלקוח מציג), ובלי קמפיינים — רק השבוע המוצג (autoFill).
 */
export async function refillCampaigns(campaignIds, week) {
  if (!campaignIds.length) return autoFill(week);
  const results = [];
  for (const id of campaignIds) results.push(await autoFillCampaign(id, week));
  return mergeFillResults(results);
}

// המסלול הישן (multipart → bytea): פעיל מקומית ולפני שאחסון המדיה ב-R2
// מוגדר (ראו src/media.js — שם ההעלאה ישירה מהדפדפן, עד MAX_MEDIA_MB).
// הקבצים נשמרים במסד, לכן הם עוברים דרך הזיכרון ולא נכתבים לדיסק.
// ה-volume של Postgres מוגבל, ולכן יש התראת אחסון ב-alerts.js.
export const MAX_FILE_MB = 50;
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
});

/**
 * העלאת מדיה במסלול הישן — אותה רשימת סוגים כמו ב-R2 (media.js). בלעדיה
 * נשמר כל סוג שהדפדפן הצהיר (text/html, JS) והוגש מהדומיין שלנו: מי שיש
 * לו הרשאת תוכן יכול היה להריץ קוד בשם הבעלים שפותח את הקובץ. קובץ פסול
 * אחד עוצר את כל הבקשה (415 — server.js). `upload` הרגיל נשאר לייבוא
 * טבלאות (CSV/Excel), שאינו מדיה ולא מוגש.
 */
export function mediaFileFilter(_req, file, cb) {
  if (isAllowedMime(file.mimetype)) return cb(null, true);
  return cb(Object.assign(new Error(`"${file.originalname}": ${TYPE_ERROR}`), { code: 'UNSUPPORTED_MEDIA_TYPE' }));
}
export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
  fileFilter: mediaFileFilter,
});

/** שם קובץ בלי הסיומת — משמש ככותרת ברירת מחדל בהעלאה מרוכזת */
export const titleFromFilename = (name) =>
  name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;

/** מקבל מערך, מחרוזת JSON או רשימה מופרדת בפסיקים */
export function parseIdList(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Boolean);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(Number).filter(Boolean);
  } catch { /* לא JSON — ננסה כרשימה מופרדת בפסיקים */ }
  return v.split(',').map(Number).filter(Boolean);
}

/**
 * עדכון חלקי בטוח: רק שדות מהרשימה הלבנה נכנסים ל-SQL,
 * והערכים תמיד עוברים כפרמטרים.
 */
export async function updateById(table, allowed, id, body, returning = '*') {
  const entries = Object.entries(body ?? {}).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) {
    return one(`select ${returning} from ${table} where id = $1`, [id]);
  }
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = entries.map(([, v]) => v);
  return one(
    `update ${table} set ${sets} where id = $1 returning ${returning}`,
    [id, ...values]
  );
}
