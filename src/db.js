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
 * מריץ fn בתוך הקשר של ארגון: client ייעודי מה-pool, טרנזקציה, ו-
 * app.current_org מוגדר. משמש את ה-middleware לכל בקשה, ואת עבודות
 * הרקע כדי לרוץ per-org.
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
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* החיבור כבר שבור */ }
    throw err;
  } finally {
    client.release();
  }
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
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
