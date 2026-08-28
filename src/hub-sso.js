import jwt from 'jsonwebtoken';

/**
 * כניסת SSO מ-HUB (חתול פיננסי) — HUB חותם JWT קצר-חיים (HS256, 60 שניות)
 * עם ה-email של המשתמש המחובר שם, ומפנה ל-GET /api/auth/sso?token=...
 *
 * מי מורשה: בדיוק כמו התחברות Google — רק email שכבר קיים כמשתמש כאן.
 * ה-SSO מאמת זהות בלבד; הוא לא יוצר משתמשים ולא מרחיב הרשאות.
 *
 * משתנה סביבה: HUB_SSO_SECRET — סוד משותף, זהה ל-MISSION_CONTROL_SSO_SECRET
 * שמוגדר ב-HUB. בלעדיו הנתיב מחזיר 503 והכפתור ב-HUB נופל לקישור רגיל.
 */
export const hubSsoReady = () => !!(process.env.HUB_SSO_SECRET && process.env.HUB_SSO_SECRET.length >= 16);

/**
 * מאמת טוקן ומחזיר את ה-email, או null אם הטוקן פסול/פג/לא לתכלית הזו.
 * אלגוריתם ננעל ל-HS256 — מונע בלבול-אלגוריתם; purpose ייעודי — טוקן
 * שנחתם לכל מטרה אחרת באותו סוד לא יעבוד כאן.
 */
export function verifyHubSsoToken(token, secret = process.env.HUB_SSO_SECRET) {
  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (claims.purpose !== 'hub-sso' || !claims.sub) return null;
    return String(claims.sub).trim().toLowerCase();
  } catch {
    return null;
  }
}
