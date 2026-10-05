import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one } from '../db.js';
import { clearSession, issueSession } from '../auth.js';
import { authUrl, exchangeCode, googleReady, signState, verifyState } from '../google-auth.js';
import { consumeSsoJti, hubSsoReady, ssoTenantCheck, verifyHubSsoClaims } from '../hub-sso.js';
import { mediaConfig } from '../media.js';
import { safeNext } from '../next-path.js';

const r = Router();

const G_STATE = 'g_state';

/**
 * נתיבים פתוחים — לפני שער ההתחברות.
 * requireAuth עצמו מופעל ב-api.js בין הראוטר הזה לשאר, כדי שסדר השער
 * יהיה גלוי במקום אחד ולא יסתמך על סדר הרישום בתוך ראוטר.
 *
 * התחברות שם-משתמש+סיסמה בוטלה — הכניסה היחידה היא דרך Google (או SSO מ-HUB).
 * מורשה להתחבר רק email שכבר קיים כמשתמש (מנהל המערכת מוסיף אותו מראש).
 */

r.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// media: האם ההעלאה ישירה ל-R2 זמינה ומה המגבלה — הלקוח בוחר לפיה מסלול
r.get('/me', (req, res) => res.json({ user: req.user, media: req.user ? mediaConfig() : null }));

/** לממשק — אילו שיטות התחברות זמינות (כדי להציג/להסתיר כפתור Google) */
r.get('/auth/config', (_req, res) => res.json({ google: googleReady() }));

/* ========================= התחברות דרך Google ========================= */

r.get('/auth/google', wrap(async (req, res) => {
  if (!googleReady()) return bad(res, 'התחברות Google לא מוגדרת', 503);
  // לאן לחזור אחרי הכניסה (חיבור שפג באמצע עבודה, קישור שהודבק) — בתוך ה-state החתום
  const state = signState(safeNext(req.query.next));
  // sameSite:lax (ולא strict) — ה-callback חוזר מגוגל כניווט חוצה-אתר,
  // וקוקי strict לא היה נשלח בו.
  res.cookie(G_STATE, state, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000,
  });
  res.redirect(authUrl(req, state));
}));

r.get('/auth/google/callback', wrap(async (req, res) => {
  const { code, state } = req.query;
  const cookieState = req.cookies?.[G_STATE];
  res.clearCookie(G_STATE);

  // state חייב להתאים לקוקי (אותו דפדפן) וגם להיות חתום ותקף
  const claims = code && state && state === cookieState ? verifyState(String(state)) : null;
  if (!claims) {
    console.warn(`[auth] Google callback — state נכשל (code=${!!code}, state=${!!state}, cookie=${!!cookieState})`);
    return res.redirect('/login.html?error=google');
  }

  let email, ok;
  try {
    ({ email, ok } = await exchangeCode(req, String(code)));
  } catch (e) {
    console.error('Google OAuth נכשל:', e.message);
    return res.redirect('/login.html?error=google');
  }
  if (!ok || !email) return res.redirect('/login.html?error=google');

  // ה-allowlist: רק email שכבר קיים כמשתמש (הבעלים אישר אותו).
  const user = await one('select * from users where lower(email) = $1', [email]);
  if (!user) {
    console.warn(`[auth] Google ${email} — לא קיים כמשתמש, נדחה`);
    return res.redirect('/login.html?error=not_approved');
  }

  issueSession(res, user);
  // נבדק שוב גם כאן — ה-state חתום, אבל הכלל על "לאן מותר" יושב במקום אחד
  res.redirect(safeNext(claims.next) ?? '/');
}));

/* ========================= כניסת SSO מ-HUB ========================= */

/**
 * ניווט שמגיע מכפתור "בקרת שיגור" ב-HUB עם טוקן חתום (20 שניות).
 * ?next= אופציונלי — נתיב יחסי באתר בלבד (safeNext), אחרת חוזרים לדף הבית.
 * אותו allowlist כמו Google: רק email שכבר קיים כמשתמש. הטוקן חד-פעמי
 * (jti) ונבדק מול הטננט של המשתמש (tid) — ראו hub-sso.js. הקוקי נקבע כאן,
 * וההפניה ל-'/' עובדת גם עם sameSite:strict כי הדף עצמו סטטי — האימות
 * בפועל קורה ב-fetch של /api/me מתוך הדף (בקשה same-site).
 */
r.get('/auth/sso', wrap(async (req, res) => {
  if (!hubSsoReady()) return bad(res, 'כניסת SSO לא מוגדרת', 503);

  const claims = verifyHubSsoClaims(String(req.query.token ?? ''));
  if (!claims) return res.redirect('/login.html?error=sso');

  // חד-פעמי: הניצול נרשם לפני כל בדיקה אחרת — גם ניסיון שנדחה "שורף" את הטוקן
  if (!(await consumeSsoJti(claims.jti, claims.exp))) {
    console.warn(`[auth] SSO — טוקן שכבר נוצל (jti חוזר) עבור ${claims.email}, נדחה`);
    return res.redirect('/login.html?error=sso');
  }

  const user = await one('select * from users where lower(email) = $1', [claims.email]);
  if (!user) return res.redirect('/login.html?error=not_approved');

  const tenant = ssoTenantCheck({ tid: claims.tid, userOrgId: user.org_id });
  if (tenant.warn) console.warn(`[auth] SSO — ${tenant.warn}`);
  if (!tenant.ok) {
    console.warn(`[auth] SSO — ${claims.email}: הטננט בטוקן (${claims.tid ?? 'חסר'}) לא מקושר לארגון של המשתמש, נדחה`);
    return res.redirect('/login.html?error=sso_tenant');
  }

  issueSession(res, user);
  res.redirect(safeNext(req.query.next) ?? '/');
}));

export default r;
