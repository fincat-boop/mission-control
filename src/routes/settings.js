import { Router } from 'express';
import { autoFill, bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { PUBLIC_USER_COLS, hashPassword, requirePerm } from '../auth.js';

const r = Router();

/* ========================= כללי המנוע ========================= */

r.get('/settings', wrap(async (_req, res) => {
  res.json({ settings: await one('select * from engine_settings limit 1') });
}));

r.patch('/settings', requirePerm('settings'), wrap(async (req, res) => {
  // שורת engine_settings אחת לכל ארגון, ו-RLS כבר מסנן אליה — אין צורך ב-where.
  const allowed = ['min_gap_days', 'max_promo_per_day', 'hybrid_weight',
    'content_alert_hours', 'min_value_per_promo', 'use_performance'];
  const entries = Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k));
  let s;
  if (entries.length === 0) {
    s = await one('select * from engine_settings limit 1');
  } else {
    const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    s = await one(`update engine_settings set ${sets} returning *`, entries.map(([, v]) => v));
  }
  const engine = await autoFill(req.body?.week);
  res.json({ settings: s, engine });
}));

/* ========================= גיבויים ========================= */

/** מטא-דאטה בלבד — בלי ה-payload עצמו, כדי שהרשימה תהיה קלה */
r.get('/backups', requirePerm('settings'), wrap(async (_req, res) => {
  const list = await rows(
    'select id, created_at, row_count from backups order by created_at desc'
  );
  res.json({ backups: list });
}));

/* ========================= משתמשים ========================= */

r.get('/users', wrap(async (_req, res) => {
  res.json({ users: await rows(`select ${PUBLIC_USER_COLS} from users order by is_owner desc, id`) });
}));

r.post('/users', requirePerm('users'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!b.name || !email) return bad(res, 'צריך שם ואימייל');
  // סיסמה אופציונלית — בלעדיה המשתמש מתחבר דרך Google בלבד
  const password = b.password ? String(b.password) : null;
  if (password !== null && password.length < 8) return bad(res, 'הסיסמה חייבת להיות באורך 8 תווים לפחות');

  const exists = await one('select id from users where lower(email) = $1', [email]);
  if (exists) return bad(res, 'כבר קיים משתמש עם האימייל הזה');

  const u = await one(
    `insert into users (name, email, password_hash, perm_content, perm_settings, perm_approve, perm_users)
     values ($1,$2,$3,coalesce($4,true),coalesce($5,false),coalesce($6,false),coalesce($7,false))
     returning ${PUBLIC_USER_COLS}`,
    [b.name, email, password ? await hashPassword(password) : null,
     b.perm_content ?? null, b.perm_settings ?? null, b.perm_approve ?? null, b.perm_users ?? null]
  );
  res.status(201).json({ user: u });
}));

r.patch('/users/:id', requirePerm('users'), wrap(async (req, res) => {
  const target = await one('select * from users where id = $1', [req.params.id]);
  if (!target) return bad(res, 'לא נמצא משתמש כזה', 404);
  if (target.is_owner) return bad(res, 'אי אפשר לשנות את הרשאות הבעלים', 403);

  const b = { ...req.body };
  if (b.password) {
    if (String(b.password).length < 8) return bad(res, 'הסיסמה חייבת להיות באורך 8 תווים לפחות');
    await query('update users set password_hash = $1 where id = $2',
      [await hashPassword(String(b.password)), target.id]);
    delete b.password;
  }
  const u = await updateById('users',
    ['name', 'perm_content', 'perm_settings', 'perm_approve', 'perm_users'],
    target.id, b, PUBLIC_USER_COLS);
  res.json({ user: u ?? await one(`select ${PUBLIC_USER_COLS} from users where id = $1`, [target.id]) });
}));

r.delete('/users/:id', requirePerm('users'), wrap(async (req, res) => {
  const target = await one('select is_owner from users where id = $1', [req.params.id]);
  if (target?.is_owner) return bad(res, 'אי אפשר למחוק את הבעלים', 403);
  if (Number(req.params.id) === req.user.id) return bad(res, 'אי אפשר למחוק את עצמך');
  await query('delete from users where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export default r;
