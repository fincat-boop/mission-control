/**
 * השער של ה-API לסוכנים: מי המפתח, האם הוא תקף, והאם מותר לו הנתיב הזה.
 * מודול טהור — הגישה למסד מוזרקת (deps), כדי שהטסטים יריצו את הלוגיקה
 * האמיתית. הועתק מ-Backbone (lib/auth/api-key-authenticate.ts).
 *
 * סדר הבדיקות (וכל שלב לפני שנוגעים במסד, ככל האפשר):
 *   1. כותרת Origin → 403. ה-API נועד לשרת-לשרת; דפדפן תמיד שולח Origin
 *      בבקשה חוצת-מקור, וכך אתר זר לא יכול לנצל מפתח שנשמר בדפדפן.
 *   2. הגבלת קצב לפי IP → 429 (לפני המסד — ניחוש מפתחות לא מעמיס עליו).
 *   3. Authorization: Bearer, צורת מפתח, חיפוש לפי קידומת, גיבוב, ביטול,
 *      תפוגה — כל כישלון כאן מחזיר אותו 401 בדיוק. הסיבה רק בלוג השרת.
 *   4. מכאן המפתח מזוהה: הגבלת קצב לפי מפתח, מפתח בדיקה בפרודקשן, נתיב
 *      שלא פתוח לסוכנים (404), הרשאה חסרה (403 עם שם ההרשאה).
 */

import { prefixOf, verifyApiKey } from './secret.js';
import { API_SCOPE_REGISTRY, expandScopes, matchRoute, parseScopes } from './scopes.js';
import { isRateLimited } from './rate-limit.js';

export const PER_IP_PER_MINUTE = 120;
export const PER_KEY_PER_MINUTE = 600;

const UNAUTHENTICATED = 'לא מאומת';

export function bearerFrom(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim());
  return m ? m[1].trim() : null;
}

/** תחילת מפתח לא תקין ללוג — רק אם היא נראית כמו קידומת שלנו */
const safeHead = (s) => (/^mc_(live|test)_/.test(s) ? s.slice(0, 12) : '');

/**
 * @param {{method:string, path:string, origin?:string, authorization?:string, ip:string}} req
 * @param {{lookupByPrefix:(p:string)=>Promise<object|null>, touchLastUsed:(id:number)=>void,
 *          environment:()=>'production'|'other', now:()=>number,
 *          log?:(line:string)=>void}} deps
 * @returns {Promise<{key:object, route:object} | {status:number, error:string, identified?:object}>}
 */
export async function authenticateApiKey(req, deps) {
  const log = deps.log ?? ((line) => console.warn(line));
  const rejected = (reason, extra = '') => {
    log(`[agent-api] 401 reason=${reason}${extra} ip=${req.ip}`);
    return { status: 401, error: UNAUTHENTICATED };
  };

  if (req.origin) {
    return { status: 403, error: 'ה-API נועד לקריאה מהשרת בלבד. אין לקרוא לו מדפדפן.' };
  }
  if (isRateLimited(`agent-api-ip:${req.ip}`, PER_IP_PER_MINUTE, 60_000, deps.now())) {
    return { status: 429, error: 'יותר מדי בקשות' };
  }

  const bearer = bearerFrom(req.authorization);
  if (!bearer) return rejected(req.authorization ? 'not_bearer' : 'no_header');
  const parsed = prefixOf(bearer);
  if (!parsed) {
    const head = safeHead(bearer);
    return rejected('malformed', ` len=${bearer.length}${head ? ` head=${head}` : ''}`);
  }
  const { prefix, env } = parsed;

  const row = await deps.lookupByPrefix(prefix);
  if (!row) return rejected('not_found', ` prefix=${prefix}`);
  if (!verifyApiKey(bearer, row.key_hash)) return rejected('hash_mismatch', ` prefix=${prefix}`);
  if (row.revoked_at) return rejected('revoked', ` prefix=${prefix}`);
  if (row.expires_at && new Date(row.expires_at).getTime() <= deps.now()) {
    return rejected('expired', ` prefix=${prefix}`);
  }

  const identified = { id: row.id, orgId: row.org_id };
  if (isRateLimited(`agent-api-key:${prefix}`, PER_KEY_PER_MINUTE, 60_000, deps.now())) {
    return { status: 429, error: 'יותר מדי בקשות', identified };
  }
  if (env === 'test' && deps.environment() === 'production') {
    return { status: 403, error: 'מפתח בדיקה אינו תקף בסביבת הפרודקשן', identified };
  }

  const route = matchRoute(req.method, req.path);
  if (!route) return { status: 404, error: 'הנתיב לא קיים ב-API לסוכנים', identified };

  const granted = parseScopes(row.scopes);
  const scopes = expandScopes(granted);
  if (route.scope !== null && !scopes.includes(route.scope)) {
    const label = API_SCOPE_REGISTRY[route.scope].label;
    return { status: 403, error: `למפתח אין את ההרשאה "${label}" (${route.scope})`, identified };
  }

  deps.touchLastUsed(row.id);
  return {
    key: { id: row.id, name: row.name, prefix, orgId: row.org_id, env, scopes, granted },
    route,
  };
}
