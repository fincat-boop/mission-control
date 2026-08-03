import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one } from '../db.js';
import { checkPassword, clearSession, issueSession } from '../auth.js';

const r = Router();

/**
 * נתיבים פתוחים — לפני שער ההתחברות.
 * requireAuth עצמו מופעל ב-api.js בין הראוטר הזה לשאר, כדי שסדר השער
 * יהיה גלוי במקום אחד ולא יסתמך על סדר הרישום בתוך ראוטר.
 */

r.post('/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return bad(res, 'צריך אימייל וסיסמה');

  const user = await one('select * from users where lower(email) = $1', [email]);
  if (!user || !(await checkPassword(password, user.password_hash))) {
    return bad(res, 'אימייל או סיסמה לא נכונים', 401);
  }
  issueSession(res, user);
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
}));

r.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => res.json({ user: req.user }));

export default r;
