import { Router } from 'express';
import { autoFill, bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { effectiveCadenceDays } from '../board.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= נקודות קצה ========================= */

r.get('/endpoints', wrap(async (_req, res) => {
  const list = await rows('select * from endpoints order by importance desc, id');
  const campaigns = await rows('select * from campaigns order by starts_on nulls last, id');
  const content = await rows('select * from content_items order by created_at desc');
  res.json({
    endpoints: list.map((e) => ({
      ...e,
      effective_min_days: effectiveCadenceDays(e),
      campaigns: campaigns.filter((c) => c.endpoint_id === e.id),
      content: content.filter((c) => c.endpoint_id === e.id),
    })),
  });
}));

// min_days_between לא כאן בכוונה: התדירות נגזרת מהחשיבות (effectiveCadenceDays),
// והמרווח בין פוסטים יושב על הקמפיין. ערך שנשלח (עוזר ישן, לקוח ישן) — מתעלמים.
const ENDPOINT_FIELDS = ['name', 'importance', 'active', 'sort_order'];

r.post('/endpoints', requirePerm('settings'), wrap(async (req, res) => {
  if (!req.body?.name) return bad(res, 'צריך שם לנקודת הקצה');
  const e = await one(
    `insert into endpoints (name, importance) values ($1, coalesce($2,5)) returning *`,
    [req.body.name, req.body.importance ?? null]
  );
  const engine = await autoFill(req.body?.week);
  res.status(201).json({ endpoint: { ...e, effective_min_days: effectiveCadenceDays(e) }, engine });
}));

r.patch('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  const e = await updateById('endpoints', ENDPOINT_FIELDS, req.params.id, req.body);
  if (!e) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  const engine = await autoFill(req.body?.week);
  res.json({ endpoint: { ...e, effective_min_days: effectiveCadenceDays(e) }, engine });
}));

/**
 * מה נמחק עם הנקודה: הקמפיינים והתוכן שלה (cascade). הפוסטים שלה נשארים
 * על הלוח, אבל בלי נקודת קצה ובלי תוכן (set null).
 */
async function endpointImpact(id) {
  return one(
    `select e.id, e.name, e.active,
            (select count(*)::int from campaigns c     where c.endpoint_id = e.id)  as campaigns,
            (select count(*)::int from content_items ci where ci.endpoint_id = e.id) as content,
            (select count(*)::int from posts p          where p.endpoint_id = e.id)  as posts
       from endpoints e where e.id = $1`,
    [id]
  );
}

r.get('/endpoints/:id/delete-impact', requirePerm('settings'), wrap(async (req, res) => {
  const impact = await endpointImpact(req.params.id);
  if (!impact) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  res.json({ impact });
}));

r.delete('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  const impact = await endpointImpact(req.params.id);
  if (!impact) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  // תוכן שנכתב לא נמחק בלי בקשה מפורשת (?force=1)
  if ((impact.content > 0 || impact.campaigns > 0) && req.query.force !== '1') {
    return res.status(409).json({
      error: `לנקודת הקצה יש ${impact.content} פריטי תוכן ו־${impact.campaigns} קמפיינים — מחיקה תמחק אותם. אפשר להשבית את הנקודה במקום.`,
      impact, needs_force: true,
    });
  }
  await query('delete from endpoints where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

export default r;
