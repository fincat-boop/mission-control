import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error(
    'חסר DATABASE_URL. מקומית — קובץ .env; ב-Railway — מחברים את שירות Postgres למשתנה ${{Postgres.DATABASE_URL}}'
  );
}

// Railway מגיש Postgres עם תעודה עצמית, לכן rejectUnauthorized:false.
// מקומית (localhost) אין SSL בכלל.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

// עמודות date נשארות מחרוזת 'YYYY-MM-DD'. ברירת המחדל של node-postgres היא Date
// בחצות מקומית, ואז JSON.stringify מסובב אותה ל-UTC ומזיז את היום אחורה.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 8,
  // "פרסם עכשיו" מחזיק את חיבור הבקשה ופותח חיבור נוסף לכל שלב (runner.js).
  // כשכל החיבורים תפוסים כך — שגיאה אחרי חצי דקה, לא המתנה לנצח
  connectionTimeoutMillis: 30000,
});

/* ========================= הקשר טננט (מולטי-טננט) =========================
 *
 * כל בקשה רצה בתוך withOrg(orgId, ...) — שמוציא client מה-pool, פותח
 * טרנזקציה, ומגדיר את משתנה הסשן app.current_org. ה-client נשמר ב-
 * AsyncLocalStorage, וכל query/one/rows/tx מנתבים אליו אוטומטית. כך יש
 * צוואר בקבוק יחיד: אף קובץ נתיב לא צריך להזכיר org_id.
 *
 * מחוץ להקשר (עבודות רקע, מיגרציות) — הקריאות רצות על ה-pool כרגיל.
 *
 * שלב 2a: התשתית קיימת וה-GUC מוגדר, אבל RLS עדיין לא מופעל בסכימה, ולכן
 * ההתנהגות זהה לקודמת. הפעלת RLS (שלב 2b) הופכת את ה-GUC לאכיפה בפועל.
 */
export const tenantContext = new AsyncLocalStorage();

const activeClient = () => tenantContext.getStore()?.client ?? null;

/** ה-org הפעיל בהקשר הנוכחי, או null (רקע/מיגרציה) */
export const currentOrg = () => tenantContext.getStore()?.orgId ?? null;

export function query(text, params) {
  return (activeClient() ?? pool).query(text, params);
}

/** מחזיר את כל השורות */
export async function rows(text, params) {
  const r = await query(text, params);
  return r.rows;
}

/** מחזיר שורה אחת או null */
export async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0] ?? null;
}

/**
 * COMMIT שבודק שהוא באמת נשמר. Postgres לא זורק על COMMIT של טרנזקציה
 * שאחת השאילתות בה נכשלה (והשגיאה נתפסה בקוד) — הוא מגלגל אחורה בשקט
 * ומחזיר את הפקודה 'ROLLBACK'. בלי הבדיקה, כל מה שנכתב בטרנזקציה נעלם
 * והקורא חושב שהצליח (בטיק הפרסום: פוסטים שכבר יצאו חזרו ל-approved
 * ויצאו שוב בטיק הבא).
 */
export class CommitRolledBackError extends Error {
  constructor() {
    super('הטרנזקציה לא נשמרה: שאילתה בתוכה נכשלה, וה-COMMIT התגלגל אחורה');
    this.name = 'CommitRolledBackError';
  }
}

async function commitOrThrow(client) {
  const r = await client.query('commit');
  if (r.command !== 'COMMIT') throw new CommitRolledBackError();
}

/**
 * מריץ fn בתוך הקשר של ארגון: client ייעודי מה-pool, טרנזקציה, ו-
 * app.current_org מוגדר. משמש את ה-middleware לכל בקשה, ואת עבודות
 * הרקע כדי לרוץ per-org. COMMIT שהתגלגל אחורה — זורק (commitOrThrow).
 *
 * מקונן (withOrg בתוך withOrg או בתוך בקשה) — client חדש וטרנזקציה נפרדת
 * שנשמרת בעצמה; השאילתות בתוך fn הולכות אליו (tenantContext.run), ואחריו
 * חוזרות לחיצוני. אסור כשהטרנזקציה החיצונית מחזיקה נעילה על שורה שהפנימית
 * כותבת: הפנימית תחכה לחיצונית, שמחכה לה.
 */
export async function withOrg(orgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // role בלי superuser — הכרחי כדי ש-RLS ייאכף (superuser עוקף גם עם FORCE).
    // מקומי לטרנזקציה, ולכן חוזר ל-role המקורי בסופה.
    await client.query('set local role app_user');
    // set_config עם is_local=true — תחום לטרנזקציה, מתאפס בסופה ולכן לא
    // דולף לבקשה הבאה שתקבל את אותו חיבור מה-pool.
    await client.query("select set_config('app.current_org', $1, true)", [String(orgId)]);
    const out = await tenantContext.run({ client, orgId }, () => fn(client));
    await commitOrThrow(client);
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* החיבור כבר שבור */ }
    throw err;
  } finally {
    client.release();
  }
}

/** כמה מחכים לנתיב שעוד רץ אחרי שהדפדפן התנתק, לפני שסוגרים את הטרנזקציה בכוח */
export const HANDLER_GRACE_MS = 10 * 60000;

/**
 * middleware: כל בקשה מאומתת רצה בתוך הקשר הטננט של המשתמש (withOrg): set
 * role app_user + app.current_org, וכל השאילתות בבקשה מסוננות ע"י RLS.
 * בקשות אנונימיות (login/logout/me — req.org ריק) רצות על ה-pool כרגיל,
 * וזה גם ה-bootstrap שמגלה את הארגון של המשתמש.
 *
 * מתי הטרנזקציה נסגרת (commit + החיבור חוזר ל-pool): ב-'finish' — התשובה
 * נשלחה, הנתיב סיים. 'close' לבדו (הדפדפן התנתק באמצע) לא מספיק: הנתיב עוד
 * רץ ומשתמש בחיבור — למשל "פרסם עכשיו" לאינסטגרם שמחכה דקות לוידאו. קודם
 * הטרנזקציה נסגרה שם, החיבור חזר ל-pool, והכתיבות שאחרי זה של הנתיב נחתו
 * על חיבור של בקשה אחרת (ארגון אחר — RLS מסתיר את השורה, העדכון פוגע ב-0
 * שורות, ופוסט שעלה מסומן אחר כך כנכשל ומתפרסם שוב). עכשיו: 'close' לפני
 * שהתשובה הסתיימה — מחכים שהנתיב יקרא ל-res.end (עטיפה חד-פעמית שלו; כל
 * תשובה, כולל שגיאה דרך ה-error handler, עוברת שם). 'finish' כבר לא יגיע
 * על חיבור סגור, ולכן העטיפה היא שסוגרת. רשת ביטחון: נתיב שלא סיים תוך
 * HANDLER_GRACE_MS — נרשם בלוג, והטרנזקציה נסגרת בכל זאת (אחרת החיבור תקוע
 * לנצח).
 */
export function tenantScope(req, res, next) {
  if (!req.org) return next();
  withOrg(req.org, () => new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    res.on('finish', done);
    res.on('close', () => {
      // התשובה כבר הסתיימה (res.end נקרא) — הנתיב סיים, אפשר לסגור
      if (res.writableEnded) return done();
      const end = res.end;
      res.end = function endAfterDisconnect(...args) {
        res.end = end;
        try {
          return end.apply(this, args);
        } finally {
          done();
        }
      };
      timer = setTimeout(() => {
        console.error(`חמור: ${req.method} ${req.originalUrl} עדיין רץ ${HANDLER_GRACE_MS / 60000} דקות ` +
          'אחרי שהדפדפן התנתק — הטרנזקציה נסגרת; כתיבות מאוחרות של הנתיב לא בטוחות');
        done();
      }, HANDLER_GRACE_MS);
    });
    next();
  })).catch((err) => {
    // ה-commit רץ אחרי שהתשובה כבר יצאה, ולכן COMMIT שהתגלגל אחורה
    // (CommitRolledBackError) כבר לא יכול להפוך ל-500 — לפחות לא בשקט
    if (res.headersSent) {
      console.error(`הבקשה ${req.method} ${req.originalUrl} לא נשמרה במסד:`, err);
      return;
    }
    next(err);
  });
}

/** מריץ את schema.sql. בטוח להרצה חוזרת. */
export async function migrate() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/** טרנזקציה */
export async function tx(fn) {
  // כבר בתוך הקשר בקשה? משתמשים באותו client — הבקשה כבר בטרנזקציה אחת,
  // ופתיחת טרנזקציה מקוננת הייתה שגיאה. ה-commit/rollback באחריות withOrg.
  const ctxClient = activeClient();
  if (ctxClient) return fn(ctxClient);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await commitOrThrow(client);
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
