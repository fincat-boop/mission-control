import { Router } from 'express';
import { autoFill, bad, evictBlocked, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= ערוצים ========================= */

r.get('/channels', wrap(async (_req, res) => {
  res.json({ channels: await rows('select * from channels order by sort_order, id') });
}));

const CHANNEL_FIELDS = ['name', 'max_per_week', 'target_per_week', 'max_promo_per_week',
                        'max_hybrid_per_week', 'max_value_per_week', 'urgent_reserve_pct',
                        'blocked_days', 'active', 'sort_order', 'efficiency', 'platform'];

r.post('/channels', requirePerm('settings'), wrap(async (req, res) => {
  if (!req.body?.name) return bad(res, 'צריך שם לערוץ');
  const c = await one(
    `insert into channels (name, max_per_week, efficiency) values ($1, coalesce($2,5), $3) returning *`,
    [req.body.name, req.body.max_per_week ?? null, req.body.efficiency ?? null]
  );
  const engine = await autoFill(req.body?.week);
  res.status(201).json({ channel: c, engine });
}));

r.patch('/channels/:id', requirePerm('settings'), wrap(async (req, res) => {
  const c = await updateById('channels', CHANNEL_FIELDS, req.params.id, req.body);
  if (!c) return bad(res, 'לא נמצא ערוץ כזה', 404);

  // קודם מפנים מה שנעשה לא חוקי, ורק אז ממלאים — אחרת המילוי תופס את
  // הימים שהפוסטים המפונים אמורים לעבור אליהם.
  const relocated = 'blocked_days' in (req.body ?? {}) ? await evictBlocked() : null;
  const engine = await autoFill(req.body?.week);
  res.json({ channel: c, engine, relocated });
}));

r.delete('/channels/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from channels where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

export default r;
