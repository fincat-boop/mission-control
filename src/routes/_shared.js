import multer from 'multer';
import { one } from '../db.js';
import { applyWeek, withEngineLock } from '../engine.js';
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
 */
export async function autoFill(week) {
  try {
    return await withEngineLock(() => applyWeek(week));
  } catch (e) {
    console.error('autoFill נכשל:', e);
    return { placed: 0, holes: 0 };
  }
}

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
