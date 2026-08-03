import { Router } from 'express';
import { autoFill, bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { effectiveCadenceDays } from '../board.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= נקודות קצה ========================= */

r.get('/endpoints', wrap(async (_req, res) => {
  const list = await rows('select * from endpoints order by importance desc, id');
  const [campaigns, content] = await Promise.all([
    rows('select * from campaigns order by starts_on nulls last, id'),
    rows('select * from content_items order by created_at desc'),
  ]);
  res.json({
    endpoints: list.map((e) => ({
      ...e,
      effective_min_days: effectiveCadenceDays(e),
      campaigns: campaigns.filter((c) => c.endpoint_id === e.id),
      content: content.filter((c) => c.endpoint_id === e.id),
    })),
  });
}));

const ENDPOINT_FIELDS = ['name', 'importance', 'min_days_between', 'active', 'sort_order'];

r.post('/endpoints', requirePerm('settings'), wrap(async (req, res) => {
  if (!req.body?.name) return bad(res, 'צריך שם לנקודת הקצה');
  // min_days_between ריק = אוטומטי לפי החשיבות, לא ברירת מחדל שרירותית
  const e = await one(
    `insert into endpoints (name, importance, min_days_between)
     values ($1, coalesce($2,5), $3) returning *`,
    [req.body.name, req.body.importance ?? null, req.body.min_days_between ?? null]
  );
  const engine = await autoFill(req.body?.week);
  res.status(201).json({ endpoint: { ...e, effective_min_days: effectiveCadenceDays(e) }, engine });
}));

r.patch('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  const e = await updateById('endpoints', ENDPOINT_FIELDS, req.params.id, req.body);
  if (!e) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  const engine = await autoFill(req.body?.week);
  res.json({ endpoint: e, engine });
}));

r.delete('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from endpoints where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

export default r;
