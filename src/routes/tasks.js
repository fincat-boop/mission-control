import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { weekMeta, ymd } from '../board.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= משימות ========================= */

r.get('/tasks', wrap(async (_req, res) => {
  const all = await rows(
    `select t.*, u.name as assignee_name, e.name as endpoint_name,
            p.title as post_title, p.scheduled_at, c.name as channel_name,
            ci.body as content_body
       from tasks t
       left join users u         on u.id = t.assignee_id
       left join endpoints e     on e.id = t.endpoint_id
       left join posts p         on p.id = t.post_id
       left join channels c      on c.id = p.channel_id
       left join content_items ci on ci.id = p.content_id
      order by t.urgent desc, t.due_on nulls last, t.id`
  );
  const today = ymd(new Date());
  const week = weekMeta(new Date());

  res.json({
    // due_on מגיע כמחרוזת 'YYYY-MM-DD'
    today: all.filter((t) => !t.done && t.due_on === today),
    attention: all.filter((t) => !t.done && t.due_on !== today),
    done_this_week: all.filter(
      (t) => t.done && t.done_at && ymd(new Date(t.done_at)) >= week.start
    ),
    open_count: all.filter((t) => !t.done).length,
  });
}));

r.post('/tasks', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.title) return bad(res, 'צריך כותרת למשימה');
  const t = await one(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, assignee_id, due_on, urgent)
     values ($1,$2,coalesce($3,'general'),$4,$5,$6,$7,coalesce($8,false)) returning *`,
    [b.title, b.subtitle ?? null, b.kind ?? null, b.post_id ?? null, b.endpoint_id ?? null,
     b.assignee_id ?? null, b.due_on ?? null, b.urgent ?? false]
  );
  res.status(201).json({ task: t });
}));

r.patch('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  const body = { ...req.body };
  // סימון "בוצע" מחתים גם את השעה
  if (body.done === true) body.done_at = new Date().toISOString();
  if (body.done === false) body.done_at = null;
  const t = await updateById('tasks',
    ['title', 'subtitle', 'kind', 'assignee_id', 'due_on', 'urgent', 'done', 'done_at'],
    req.params.id, body);
  if (!t) return bad(res, 'לא נמצאה משימה כזו', 404);
  res.json({ task: t });
}));

r.delete('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from tasks where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export default r;
