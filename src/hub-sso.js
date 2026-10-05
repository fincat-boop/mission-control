import jwt from 'jsonwebtoken';
import { one, query } from './db.js';
import { isPlatformOrg } from './platform.js';

/**
 * כניסת SSO מ-HUB (חתול פיננסי) — HUB חותם JWT קצר-חיים (HS256, 20 שניות;
 * lib/mission-control/sso.ts שם) עם ה-email של המשתמש המחובר, ומפנה ל-
 * GET /api/auth/sso?token=...
 *
 * מי מורשה: בדיוק כמו התחברות Google — רק email שכבר קיים כמשתמש כאן.
 * ה-SSO מאמת זהות בלבד; הוא לא יוצר משתמשים ולא מרחיב הרשאות.
 *
 * שני claims שה-HUB מחייב את הצד שלנו לבדוק (docs/34 שם, החלטת בעלים ה9):
 *   jti — מזהה חד-פעמי. jti שכבר נוצל נדחה (טבלת sso_used_jti), כך שטוקן
 *         שדלף מלוג בחלון החיים שלו לא נכנס פעמיים.
 *   tid — הטננט ב-HUB שממנו המשתמש קפץ. משתמש כאן מקושר לטננט אחד: החיבור
 *         ל-HUB אחד לכל השרת ושייך לארגון הפלטפורמה (platform.js), ולכן
 *         HUB_TENANT_ID הוא הטננט של ארגון הפלטפורמה. כשהוא מוגדר — tid אחר,
 *         או משתמש מארגון אחר, נדחים. כשלא מוגדר — נכנסים כמו קודם, עם שורת
 *         אזהרה בלוג (מעבר רך: מגדירים אחרי שרואים בלוג מה ה-HUB שולח).
 *
 * משתני סביבה:
 *   HUB_SSO_SECRET — סוד משותף, זהה לסוד ה-SSO של הטננט ב-HUB. בלעדיו
 *                    הנתיב מחזיר 503 והכפתור ב-HUB נופל לקישור רגיל.
 *   HUB_TENANT_ID  — (מומלץ) מזהה הטננט ב-HUB של ארגון הפלטפורמה, למשל
 *                    00000000-0000-0000-0000-00000000fc01.
 */
export const hubSsoReady = () => !!(process.env.HUB_SSO_SECRET && process.env.HUB_SSO_SECRET.length >= 16);

/** גיל מקסימלי לטוקן (מ-iat), כולל מרווח לסטיית שעונים — ה-HUB מנפיק ל-20 שניות */
export const SSO_MAX_AGE = '60s';

/**
 * מאמת טוקן ומחזיר את ה-claims הרלוונטיים, או null אם הטוקן פסול/פג/לא
 * לתכלית הזו. אלגוריתם ננעל ל-HS256 — מונע בלבול-אלגוריתם; purpose ייעודי —
 * טוקן שנחתם לכל מטרה אחרת באותו סוד לא יעבוד כאן.
 * @returns {{email:string, jti:string|null, tid:string|null, exp:number}|null}
 */
export function verifyHubSsoClaims(token, secret = (process.env.HUB_SSO_SECRET ?? '').trim()) {
  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'], maxAge: SSO_MAX_AGE });
    if (claims.purpose !== 'hub-sso' || !claims.sub) return null;
    return {
      email: String(claims.sub).trim().toLowerCase(),
      jti: typeof claims.jti === 'string' && claims.jti ? claims.jti : null,
      tid: typeof claims.tid === 'string' && claims.tid.trim() ? claims.tid.trim().toLowerCase() : null,
      exp: Number(claims.exp),
    };
  } catch {
    return null;
  }
}

/** רק ה-email (או null) — לקוראים שלא צריכים את שאר ה-claims */
export const verifyHubSsoToken = (token, secret) => verifyHubSsoClaims(token, secret)?.email ?? null;

/**
 * האם הטננט שבטוקן מתאים למשתמש (טהורה).
 * @returns {{ok:boolean, warn?:string}} warn — לשורת לוג כשהבדיקה לא נאכפת
 */
export function ssoTenantCheck({ tid, userOrgId }, env = process.env) {
  const expected = String(env.HUB_TENANT_ID ?? '').trim().toLowerCase();
  if (!expected) {
    return { ok: true, warn: `HUB_TENANT_ID לא מוגדר — הטננט שבטוקן (${tid ?? 'חסר'}) לא נבדק` };
  }
  if (!tid || tid !== expected) return { ok: false };
  // הטננט הזה מקושר לארגון הפלטפורמה בלבד — משתמש מארגון אחר לא מגיע ממנו
  if (!isPlatformOrg(userOrgId, env)) return { ok: false };
  return { ok: true };
}

/**
 * מסמן jti כמנוצל. true — ניצול ראשון; false — כבר נוצל (replay).
 * שורות שפג תוקפן נמחקות על הדרך — הטבלה נשארת זעירה.
 */
export async function consumeSsoJti(jti, expSec) {
  await query('delete from sso_used_jti where expires_at < now()');
  const row = await one(
    `insert into sso_used_jti (jti, expires_at)
     values ($1, to_timestamp($2)) on conflict (jti) do nothing returning jti`,
    [jti, Number.isFinite(expSec) ? expSec : Math.floor(Date.now() / 1000) + 60]);
  return !!row;
}
