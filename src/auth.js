import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one, query } from './db.js';

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  throw new Error('חסר SESSION_SECRET (מחרוזת אקראית ארוכה). ב-Railway מוסיפים אותו כמשתנה סביבה.');
}

const COOKIE = 'mb_session';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 יום

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  });
}

const PUBLIC_USER_COLS = `
  id, name, email, is_owner, org_id,
  perm_content, perm_settings, perm_approve, perm_users
`;

/** טוען את המשתמש מהקוקי לתוך req.user (או null). לא חוסם. */
export async function loadUser(req, _res, next) {
  req.user = null;
  req.org = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const { uid } = jwt.verify(token, SECRET);
      // רץ על ה-pool (מחוץ להקשר טננט) — bootstrap שמגלה לאיזה org המשתמש שייך.
      // מצרף את שם הארגון להצגה בממשק.
      req.user = await one(
        `select u.id, u.name, u.email, u.is_owner, u.org_id,
                u.perm_content, u.perm_settings, u.perm_approve, u.perm_users,
                o.name as org_name
           from users u left join orgs o on o.id = u.org_id
          where u.id = $1`,
        [uid]
      );
      req.org = req.user?.org_id ?? null;
    } catch {
      /* טוקן פג או לא תקין — נשארים אנונימיים */
    }
  }
  next();
}

/* ========================= הגבלת קצב בהתחברות ========================= */

/**
 * מגן מפני brute-force על הסיסמאות. סופר *כישלונות* לפי אימייל בחלון זמן;
 * מעל התקרה — 429 עד שהחלון נגמר. התחברות מוצלחת מאפסת את המונה.
 *
 * מבוסס-DB ולא מונה בזיכרון: req.ip לא יציב מאחורי הפרוקסי של Railway, ומונה
 * בזיכרון גם לא היה שורד ריבוי instances. ממופתח לפי אימייל — היעד של המתקפה
 * (המחיר: אפשר לנעול חשבון ידוע ע"י הצפה, מקובל בכלי פנימי קטן).
 */
const LOGIN_WINDOW = '15 minutes';
const LOGIN_MAX_FAILS = 5;

const emailOf = (req) => String(req.body?.email ?? '').trim().toLowerCase();

export async function loginLimiter(req, res, next) {
  const email = emailOf(req);
  if (!email) return next();
  const row = await one(
    `select count(*)::int as n from login_attempts
      where email = $1 and at > now() - interval '${LOGIN_WINDOW}'`,
    [email]
  );
  if (row.n >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: 'יותר מדי ניסיונות התחברות. נסה שוב בעוד כמה דקות.' });
  }
  next();
}

export async function recordLoginFailure(req) {
  await query('insert into login_attempts (email, ip) values ($1, $2)', [emailOf(req), req.ip ?? null]);
  // ניקוי גורף של רשומות ישנות — נדיר וזול, שומר את הטבלה קטנה
  await query(`delete from login_attempts where at < now() - interval '${LOGIN_WINDOW}'`);
}

export async function resetLoginAttempts(req) {
  await query('delete from login_attempts where email = $1', [emailOf(req)]);
}

/** חוסם בקשות ללא התחברות */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'נדרשת התחברות' });
  next();
}

/**
 * חוסם לפי הרשאה. בעלים עוקף הכול.
 * @param {'content'|'settings'|'approve'|'users'} perm
 */
export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'נדרשת התחברות' });
    if (req.user.is_owner || req.user[`perm_${perm}`]) return next();
    return res.status(403).json({ error: 'אין לך הרשאה לפעולה הזו' });
  };
}

export { PUBLIC_USER_COLS };
