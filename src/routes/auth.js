import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one } from '../db.js';
import { clearSession, issueSession } from '../auth.js';
import { authUrl, exchangeCode, googleReady, signState, verifyState } from '../google-auth.js';
import { hubSsoReady, verifyHubSsoToken } from '../hub-sso.js';

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

r.get('/me', (req, res) => {
  if (!req.user) {
    console.log(`[auth] /me בלי session — cookies שהגיעו: [${Object.keys(req.cookies ?? {}).join(', ')}] · UA: ${String(req.headers['user-agent'] ?? '').slice(0, 60)}`);
  } else {
    console.log(`[auth] /me תקין — user ${req.user.id}`);
  }
  res.json({ user: req.user });
});

/** לממשק — אילו שיטות התחברות זמינות (כדי להציג/להסתיר כפתור Google) */
r.get('/auth/config', (_req, res) => res.json({ google: googleReady() }));

/* ========================= התחברות דרך Google ========================= */

r.get('/auth/google', wrap(async (req, res) => {
  if (!googleReady()) return bad(res, 'התחברות Google לא מוגדרת', 503);
  const state = signState();
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
  if (!code || !state || state !== cookieState || !verifyState(String(state))) {
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

  console.log(`[auth] Google ${email} — session הונפק (user ${user.id})`);
  issueSession(res, user);
  res.redirect('/');
}));

/* ========================= כניסת SSO מ-HUB ========================= */

/**
 * ניווט שמגיע מכפתור "בקרת שיגור" ב-HUB עם טוקן חתום (60 שניות).
 * אותו allowlist כמו Google: רק email שכבר קיים כמשתמש. הקוקי נקבע כאן,
 * וההפניה ל-'/' עובדת גם עם sameSite:strict כי הדף עצמו סטטי — האימות
 * בפועל קורה ב-fetch של /api/me מתוך הדף (בקשה same-site).
 */
r.get('/auth/sso', wrap(async (req, res) => {
  if (!hubSsoReady()) return bad(res, 'כניסת SSO לא מוגדרת', 503);

  const email = verifyHubSsoToken(String(req.query.token ?? ''));
  if (!email) return res.redirect('/login.html?error=sso');

  const user = await one('select * from users where lower(email) = $1', [email]);
  if (!user) return res.redirect('/login.html?error=not_approved');

  issueSession(res, user);
  res.redirect('/');
}));

export default r;
