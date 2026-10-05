import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { weekMeta } from '../board.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= משימות ========================= */

export const LOCAL_TZ = 'Asia/Jerusalem';

/**
 * YYYY-MM-DD של הרגע הנתון בשעון ישראל — בלי תלות ב-TZ של התהליך. due_on
 * של משימות נכתב בתאריך המקומי, ולכן גם "היום" שמולו משווים חייב להיות מקומי.
 */
export function localYmd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** חלוקת המשימות לקבוצות של הטאב. due_on מגיע כמחרוזת 'YYYY-MM-DD'. */
export function groupTasks(all, { today, weekStart }) {
  return {
    today: all.filter((t) => !t.done && t.due_on === today),
    attention: all.filter((t) => !t.done && t.due_on !== today),
    done_this_week: all.filter(
      (t) => t.done && t.done_at && localYmd(new Date(t.done_at)) >= weekStart
    ),
    open_count: all.filter((t) => !t.done).length,
  };
}

/**
 * משימות פתוחות + מה שנסגר בשבועיים האחרונים (הטאב מציג רק "הושלם השבוע").
 * ?all=1 — הכול, כולל ההיסטוריה הישנה.
 */
r.get('/tasks', wrap(async (req, res) => {
  const all = await rows(
    `select t.*, u.name as assignee_name, e.name as endpoint_name,
            p.title as post_title, p.scheduled_at, c.name as channel_name,
            -- הטקסט ל"העתק טקסט": הגרסה הנוכחית של התוכן לערוץ של הפוסט
            -- (בוואטסאפ — הנוסח לוואטסאפ, לא גוף התוכן הכללי), חי ולא מה
            -- שנשמר כשהמשימה נוצרה. אחריה מה שנשמר במשימה, ואז הכותרת.
            coalesce(nullif(btrim(v.body), ''), nullif(btrim(t.meta->>'body'), ''),
                     p.title, t.title) as copy_text
       from tasks t
       left join users u            on u.id = t.assignee_id
       left join endpoints e        on e.id = t.endpoint_id
       left join posts p            on p.id = t.post_id
       left join channels c         on c.id = p.channel_id
       left join content_variants v on v.content_id = p.content_id
                                   and v.channel_id = p.channel_id
      where $1 or t.done = false or t.done_at >= now() - interval '14 days'
      order by t.urgent desc, t.due_on nulls last, t.id`,
    [req.query.all === '1']
  );
  res.json(groupTasks(all, { today: localYmd(), weekStart: weekMeta(new Date()).start }));
}));

/** מונה זול לתגית בטאב ולרענון התקופתי — בלי לשלוף את כל המשימות */
r.get('/tasks/count', wrap(async (_req, res) => {
  const c = await one(
    `select count(*) filter (where not done)::int as open_count,
            count(*) filter (where not done and urgent)::int as urgent_count
       from tasks`
  );
  res.json(c);
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

/**
 * משימת אישור נסגרת רק בידי מי שמורשה לאשר: סגירה בלי אישור הפוסט
 * משאירה אותו ממתין, והמשימה שהייתה התזכורת היחידה נעלמת. גם שינוי
 * הסוג חסום — אחרת עוקפים דרך "general".
 */
export function approveTaskBlocked(task, body, user) {
  if (task.kind !== 'approve') return false;
  if (user.is_owner || user.perm_approve) return false;
  return 'done' in body || 'kind' in body;
}

r.patch('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  const body = { ...req.body };
  const cur = await one('select kind from tasks where id = $1', [req.params.id]);
  if (!cur) return bad(res, 'לא נמצאה משימה כזו', 404);
  if (approveTaskBlocked(cur, body, req.user)) {
    return bad(res, 'משימת אישור נסגרת רק על ידי מי שמורשה לאשר — הפוסט עדיין ממתין לאישור', 403);
  }
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
  // מחיקה היא סגירה בדרך אחרת — אותו כלל כמו ב-PATCH
  const cur = await one('select kind from tasks where id = $1', [req.params.id]);
  if (cur && approveTaskBlocked(cur, { done: true }, req.user)) {
    return bad(res, 'משימת אישור נמחקת רק על ידי מי שמורשה לאשר — הפוסט עדיין ממתין לאישור', 403);
  }
  await query('delete from tasks where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export default r;
