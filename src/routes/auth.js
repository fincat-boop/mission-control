import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one } from '../db.js';
import {
  checkPassword, clearSession, issueSession,
  loginLimiter, recordLoginFailure, resetLoginAttempts,
} from '../auth.js';
import { authUrl, exchangeCode, googleReady, signState, verifyState } from '../google-auth.js';

const r = Router();

const G_STATE = 'g_state';

/**
 * נתיבים פתוחים — לפני שער ההתחברות.
 * requireAuth עצמו מופעל ב-api.js בין הראוטר הזה לשאר, כדי שסדר השער
 * יהיה גלוי במקום אחד ולא יסתמך על סדר הרישום בתוך ראוטר.
 */

r.post('/auth/login', wrap(loginLimiter), wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return bad(res, 'צריך אימייל וסיסמה');

  const user = await one('select * from users where lower(email) = $1', [email]);
  if (!user || !(await checkPassword(password, user.password_hash))) {
    await recordLoginFailure(req);
    return bad(res, 'אימייל או סיסמה לא נכונים', 401);
  }
  await resetLoginAttempts(req);
  issueSession(res, user);
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
}));

r.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => res.json({ user: req.user }));

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
  if (!user) return res.redirect('/login.html?error=not_approved');

  issueSession(res, user);
  res.redirect('/');
}));

export default r;
