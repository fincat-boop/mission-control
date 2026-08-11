import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one } from './db.js';

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
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

const PUBLIC_USER_COLS = `
  id, name, email, is_owner,
  perm_content, perm_settings, perm_approve, perm_users
`;

/** טוען את המשתמש מהקוקי לתוך req.user (או null). לא חוסם. */
export async function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const { uid } = jwt.verify(token, SECRET);
      req.user = await one(`select ${PUBLIC_USER_COLS} from users where id = $1`, [uid]);
    } catch {
      /* טוקן פג או לא תקין — נשארים אנונימיים */
    }
  }
  next();
}

/* ========================= הגבלת קצב בהתחברות ========================= */

/**
 * מגן מפני brute-force על הסיסמאות. סופר *כישלונות* בלבד לפי IP+אימייל
 * בחלון זמן; מעל התקרה — 429 עד שהחלון נגמר. התחברות מוצלחת מאפסת את המונה.
 * בזיכרון התהליך, כמו שאר המצב הרץ (טיימרים, הצעות העוזר) — מספיק כל עוד יש
 * instance אחד.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const loginFails = new Map(); // key -> { count, first }

const loginKey = (req) =>
  `${req.ip}|${String(req.body?.email ?? '').trim().toLowerCase()}`;

export function loginLimiter(req, res, next) {
  const rec = loginFails.get(loginKey(req));
  if (rec && Date.now() - rec.first < LOGIN_WINDOW_MS && rec.count >= LOGIN_MAX_FAILS) {
    const mins = Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 60000);
    return res.status(429).json({ error: `יותר מדי ניסיונות התחברות. נסה שוב בעוד ${mins} דקות.` });
  }
  next();
}

export function recordLoginFailure(req) {
  const key = loginKey(req);
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.first >= LOGIN_WINDOW_MS) {
    loginFails.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
  // ניקוי עצל של רשומות שפג תוקפן, כדי שהמפה לא תגדל בלי גבול
  if (loginFails.size > 500) {
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - v.first >= LOGIN_WINDOW_MS) loginFails.delete(k);
  }
}

export function resetLoginAttempts(req) {
  loginFails.delete(loginKey(req));
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
