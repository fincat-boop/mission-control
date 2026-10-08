/**
 * מפתחות API במסד: טבלת api_keys (מפתח לכל שורה, רק גיבוב) ו-api_requests
 * (יומן בקשות, 90 יום).
 *
 * שני סוגי קריאות:
 *  - מהשער (לפני שיש ארגון): חיפוש לפי קידומת, חותמת "שימוש אחרון" ויומן
 *    הבקשות. רצים מחוץ להקשר הטננט (tenantContext.exit) — על ה-pool, שעוקף
 *    RLS. החיפוש הוא שמגלה לאיזה ארגון המפתח שייך, בדיוק כמו loadUser.
 *  - מהממשק (בעלים מחובר): רצים בתוך הקשר הבקשה, ו-RLS מסנן לארגון.
 */

import { isIP } from 'node:net';
import { one, query, rows, tenantContext } from '../db.js';
import { currentKeyEnv, generateApiKey } from './secret.js';
import { parseScopes } from './scopes.js';

export const API_REQUESTS_RETENTION_DAYS = 90;
const MAX_ISSUE_ATTEMPTS = 3;
const UNIQUE_VIOLATION = '23505';

const outsideTenant = (fn) => tenantContext.exit(fn);

/* ========================= מהשער ========================= */

export function lookupByPrefix(prefix) {
  return outsideTenant(() => one(
    `select id, org_id, name, key_hash, scopes, expires_at, revoked_at
       from api_keys where key_prefix = $1`, [prefix]));
}

/** בלי await: חותמת שימוש לא מעכבת את הבקשה, וכישלון בה לא מפיל אותה */
export function touchLastUsed(id) {
  outsideTenant(() => query('update api_keys set last_used_at = now() where id = $1', [id]))
    .catch((e) => console.error('[agent-api] עדכון שימוש אחרון נכשל:', e.message));
}

/** שורה ביומן הבקשות. path בלי query string — שם עלולים להיות פרטים אישיים */
export function logRequest({ orgId, keyId, method, path, status, ip, durationMs }) {
  outsideTenant(() => query(
    `insert into api_requests (org_id, api_key_id, method, path, status, ip, duration_ms)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, keyId, method, String(path).slice(0, 300), status ?? null,
     isIP(String(ip ?? '')) ? ip : null, durationMs ?? null]
  )).catch((e) => console.error('[agent-api] רישום בקשה נכשל:', e.message));
}

export async function pruneApiRequests() {
  const r = await outsideTenant(() => query(
    `delete from api_requests where created_at < now() - make_interval(days => $1)`,
    [API_REQUESTS_RETENTION_DAYS]));
  return r.rowCount;
}

/* ========================= מהממשק (בהקשר הארגון) ========================= */

const PUBLIC_COLS = `id, name, key_prefix, env, scopes, created_at, last_used_at, expires_at,
  revoked_at, (select name from users u where u.id = api_keys.created_by) as created_by_name`;

export async function listKeys() {
  const keys = await rows(`select ${PUBLIC_COLS} from api_keys order by revoked_at is not null, created_at desc`);
  // בקשות ב-24 השעות האחרונות, לכל מפתח, בשאילתה אחת
  const counts = await rows(
    `select api_key_id, count(*)::int as n from api_requests
      where created_at > now() - interval '24 hours' group by api_key_id`);
  const byKey = new Map(counts.map((c) => [c.api_key_id, c.n]));
  return keys.map((k) => ({ ...k, scopes: parseScopes(k.scopes), requests_24h: byKey.get(k.id) ?? 0 }));
}

export const getKey = (id) => one(`select ${PUBLIC_COLS} from api_keys where id = $1`, [id]);

/**
 * תאריך תפוגה מהטופס (YYYY-MM-DD) → סוף היום בשעון ישראל. ריק = בלי תפוגה.
 * @returns {{value:string|null} | {error:string}}
 */
export function parseExpiry(input, now = new Date()) {
  if (input == null || input === '') return { value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input))) return { error: 'תאריך התפוגה לא תקין' };
  // היום האחרון שבו המפתח תקף — כולו. ההמרה לשעון ישראל במסד.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
  if (String(input) < today) return { error: 'תאריך התפוגה כבר עבר' };
  return { value: String(input) };
}

const EXPIRES_SQL = (p) => `case when ${p}::date is null then null
  else ((${p}::date)::timestamp + time '23:59:59') at time zone 'Asia/Jerusalem' end`;

/**
 * הנפקה עם ניסיון חוזר על התנגשות קידומת (23505 על האינדקס הייחודי).
 * כל ניסיון ב-savepoint: הבקשה כולה טרנזקציה אחת, ושגיאה בלי savepoint
 * הייתה מבטלת אותה.
 */
async function insertWithRetry(insert) {
  let lastMessage = 'אין תשובה';
  for (let attempt = 1; attempt <= MAX_ISSUE_ATTEMPTS; attempt++) {
    const generated = generateApiKey(currentKeyEnv());
    await query('savepoint api_key_issue');
    try {
      const row = await insert(generated);
      await query('release savepoint api_key_issue');
      return { generated, row };
    } catch (e) {
      await query('rollback to savepoint api_key_issue');
      lastMessage = e.message;
      if (e.code !== UNIQUE_VIOLATION) break;
    }
  }
  throw new Error(`יצירת המפתח נכשלה: ${lastMessage}`);
}

/** @returns {{key:object, secret:string}} — הסוד מוחזר כאן בלבד, ולא נשמר */
export async function issueKey({ name, scopes, expires, userId }) {
  const { generated, row } = await insertWithRetry((g) => one(
    `insert into api_keys (name, key_prefix, key_hash, env, scopes, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6, ${EXPIRES_SQL('$7')}) returning id`,
    [name, g.prefix, g.hash, g.env, scopes, userId, expires]));
  return { key: await getKey(row.id), secret: generated.secret };
}

/** ביטול. חוזר על עצמו בלי נזק, ושומר את זמן הביטול המקורי */
export async function revokeKey(id) {
  await query('update api_keys set revoked_at = now() where id = $1 and revoked_at is null', [id]);
  return getKey(id);
}

/** עריכת הרשאות — רק למפתח פעיל. חלה מיד, בלי סוד חדש */
export async function updateScopes(id, scopes) {
  const r = await one(
    'update api_keys set scopes = $2 where id = $1 and revoked_at is null returning id', [id, scopes]);
  return r ? getKey(id) : null;
}

/**
 * סוד חדש לאותו מפתח (אותו שם, הרשאות ויומן). הסוד הקודם מת מיד.
 * מפתח מבוטל חוזר לפעולה רק כך — הסוד שבוטל לא חוזר לעולם.
 */
export async function renewKey(id, { expires, userId }) {
  const before = await one('select key_prefix, revoked_at, expires_at from api_keys where id = $1 for update', [id]);
  if (!before) return null;
  const { generated } = await insertWithRetry((g) => one(
    `update api_keys set key_prefix = $2, key_hash = $3, env = $4, created_at = now(),
            created_by = $5, expires_at = ${EXPIRES_SQL('$6')}, last_used_at = null, revoked_at = null
      where id = $1 returning id`,
    [id, g.prefix, g.hash, g.env, userId, expires]));
  return { key: await getKey(id), secret: generated.secret, before };
}

/** מחיקה — רק של מפתח מבוטל. יומן הבקשות שלו נמחק איתו (cascade) */
export async function deleteKey(id) {
  const r = await one('delete from api_keys where id = $1 and revoked_at is not null returning id', [id]);
  return Boolean(r);
}

export const recentRequests = (id) => rows(
  `select method, path, status, host(ip) as ip, duration_ms, created_at
     from api_requests where api_key_id = $1 order by created_at desc limit 20`, [id]);
