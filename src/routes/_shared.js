import multer from 'multer';
import { currentOrg, one, query } from '../db.js';
import { applyWeek, lockEngine, withEngineLock } from '../engine.js';
import { weekMeta, ymd } from '../board.js';
import { relocateBlocked } from '../respace.js';

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
 * מריץ מילוי אוטומטי של המנוע לשבוע שהלקוח מציג, אחרי שינוי בקלט שלו
 * (כלל, קמפיין, תוכן, נקודת קצה, ערוץ). לא נכשלת כשאין מה למלא, ולא
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
  return guardedFill('autoFill',
    () => withEngineLock(() => applyWeek(week, { holes: false })));
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
 * savepoint + fail-soft משותפים ל-autoFill ול-autoFillCampaign (ראו למעלה).
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

/** כמה שבועות לכל היותר ממלאים בשמירת קמפיין — חצי שנה */
export const CAMPAIGN_FILL_MAX_WEEKS = 26;

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
 * promo_blocked — מכירתיים שלא שובצו בשער היחס, בכל השבועות.
 */
export function mergeFillResults(list) {
  const sum = (k) => list.reduce((s, r) => s + (r[k] ?? 0), 0);
  const cat = (k) => list.flatMap((r) => r[k] ?? []);
  return {
    placed: sum('placed'), attached: sum('attached'), holes: sum('holes'),
    skipped: sum('skipped'), dropped: cat('dropped'), promo_blocked: sum('promo_blocked'),
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
 * מרוסן לקמפיין (onlyCampaignId): בשבועות שהמשתמש לא מסתכל עליהם משובץ
 * ומשויך רק התוכן של הקמפיין הזה — שמירת קמפיין לא צורכת תוכן שוטף של
 * נקודות אחרות לחודשים קדימה. השבוע שהלקוח מציג (viewedWeek) מתמלא במלואו,
 * כמו autoFill — גם כשהוא מחוץ לתקופת הקמפיין, כדי שלא יאבד שום דבר
 * ממה שהמילוי של השבוע המוצג עשה עד עכשיו.
 *
 * קמפיין בלי תקופה למלא (campaignFillWeeks → null) — רק השבוע שהלקוח
 * הציג, כמו קודם: למשל השהיה/השבתה מפנה מקום שאחרים יכולים לתפוס.
 */
export function autoFillCampaign(campaignId, viewedWeek) {
  return guardedFill('autoFillCampaign', async () => {
    const c = campaignId
      ? await one('select id, starts_on, ends_on, active, paused_at from campaigns where id = $1',
        [campaignId])
      : null;
    const weeks = campaignFillWeeks(c);
    if (!weeks) return withEngineLock(() => applyWeek(viewedWeek, { holes: false }));
    const viewed = viewedWeekStart(viewedWeek);
    const all = [...new Set([...weeks, ...(viewed ? [viewed] : [])])].sort();
    return withEngineLock(async () => {
      const results = [];
      for (const w of all) {
        results.push(await applyWeek(`${w}T12:00:00`,
          { holes: false, onlyCampaignId: w === viewed ? null : c.id }));
      }
      return mergeFillResults(results);
    });
  });
}

/** תחילת השבוע שהלקוח מציג, או null — בלי שבוע, או שבוע שבור (לא מפיל את המילוי) */
function viewedWeekStart(week) {
  if (week == null || week === '') return null;
  try {
    return weekMeta(week).start;
  } catch {
    return null;
  }
}

/** תשובת מילוי ריקה — אותה צורה כמו applyWeek, כדי שהלקוח לא יצטרך לבדוק */
export const EMPTY_FILL = Object.freeze({
  placed: 0, attached: 0, holes: 0, skipped: 0, dropped: [],
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
 * נקודה / ערוץ שהופעלו מחדש (סעיף 16): פוסט מאושר שהמועד שלו עבר בזמן שהיה
 * מוחזק חוזר ל"מתוכנן" בלי אישור — אחרת הטיק הבא היה מפרסם בבת אחת את כל
 * מה שהצטבר (עד MAX_LATE_HOURS אחורה). מכאן הוא עובר במסלול הרגיל: "לא סומן
 * כפורסם" (unconfirmed.js) — מי שרוצה שיצא, משבץ אותו מחדש ומאשר שוב.
 * where — תנאי SQL פנימי על posts p (לא מקלט משתמש). מחזיר כמה חזרו.
 */
export async function resetMissedApprovals(where, params) {
  const r = await query(
    `update posts p set status = 'scheduled', approved_by = null, approved_at = null
      where p.status = 'approved' and p.scheduled_at < now() and ${where}
      returning p.id`,
    params);
  return r.rowCount;
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
