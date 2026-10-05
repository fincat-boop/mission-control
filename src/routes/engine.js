import crypto from 'node:crypto';
import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { bad, parseIdList, wrap } from './_shared.js';
import { applyWeek, planWeek, recordDismissals, withEngineLock } from '../engine.js';
import { planUrgent } from '../urgent.js';
import { one, query, rows } from '../db.js';

const r = Router();

/* ========================= מנוע השיבוץ ========================= */

/** תכנון בלבד — לא נכתב כלום */
r.post('/engine/plan', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planWeek(req.body?.week));
}));

/**
 * ביצוע התכנון. מריץ תכנון טרי כדי שלא ייכתב משהו על סמך מצב ישן.
 * selected (לא חובה) — מפתחות הפריטים שהמשתמש השאיר מסומנים בחלון;
 * נכתב רק מה שגם מסומן וגם עדיין בהצעה הטרייה. בלי selected — הכול.
 */
r.post('/engine/apply', requirePerm('content'), wrap(async (req, res) => {
  const raw = req.body?.selected;
  if (raw != null && !Array.isArray(raw)) return bad(res, 'selected חייב להיות רשימה');
  const selected = raw == null ? null : raw.map(String).slice(0, 500);
  if (selected && selected.length === 0) return bad(res, 'לא סומן אף פריט לשיבוץ');

  const result = await withEngineLock(() => applyWeek(req.body?.week, { selected }));
  if (result.placed === 0 && result.attached === 0 && result.holes === 0) {
    const why = result.dropped.length
      ? `לא שובץ כלום: ${result.dropped[0].reason}`
      : result.skipped
        ? 'הלוח השתנה מאז שההצעה הוצגה, ואף פריט מסומן כבר לא רלוונטי — פתחו שוב את מילוי השבוע'
        : 'אין מה לשבץ — הלוח מלא או שאין תוכן מוכן';
    return bad(res, why, result.skipped ? 409 : 400);
  }
  res.status(201).json(result);
}));

/**
 * "בטל" על מילוי של המנוע. רק מה שלא השתנה מאז:
 *  - created [{post_id, content_id}] — נמחק רק פוסט שעדיין מתוכנן, לא פורסם,
 *    נוצר בחצי השעה האחרונה, עם אותו תוכן, ובלי תוצאות שנמדדו.
 *  - attached [{post_id, content_id, title, prev_title, prev_kind, closed_task_ids}]
 *    — חוזר לפוסט חסר תוכן רק אם עדיין מתוכנן, עם אותו תוכן ואותה כותרת
 *    שהשיוך כתב; המשימות שהשיוך סגר (לכתוב/החלפה) נפתחות שוב.
 * מה שבוטל נרשם כוויתור, כדי שהמילוי הבא לא יחזיר אותו.
 */
r.post('/engine/undo', requirePerm('content'), wrap(async (req, res) => {
  const created = (Array.isArray(req.body?.created) ? req.body.created : [])
    .slice(0, 500)
    .map((x) => ({ id: Number(x?.post_id), content: x?.content_id == null ? null : Number(x.content_id) }))
    .filter((x) => x.id && (x.content === null || x.content));
  const attached = Array.isArray(req.body?.attached) ? req.body.attached.slice(0, 500) : [];
  if (created.length === 0 && attached.length === 0) return bad(res, 'אין מה לבטל');

  const removed = created.length
    ? await rows(
        `delete from posts p
          using unnest($1::int[], $2::int[]) as x(id, content_id)
          where p.id = x.id and p.content_id is not distinct from x.content_id
            and p.status = 'scheduled' and p.published_at is null
            and p.created_at > now() - interval '30 minutes'
            and not exists (select 1 from post_results r where r.post_id = p.id)
        returning p.id, p.content_id, p.channel_id, p.scheduled_at`,
        [created.map((x) => x.id), created.map((x) => x.content)])
    : [];

  const detached = [];
  for (const a of attached) {
    const postId = Number(a?.post_id);
    const contentId = Number(a?.content_id);
    if (!postId || !contentId || typeof a.title !== 'string') continue;
    const kind = ['promo', 'value', 'hybrid'].includes(a.prev_kind) ? a.prev_kind : null;
    const prevTitle = typeof a.prev_title === 'string' && a.prev_title.trim()
      ? a.prev_title.trim().slice(0, 200) : 'חסר תוכן';
    const post = await one(
      `update posts set content_id = null, title = $4, kind = coalesce($5, kind)
        where id = $1 and content_id = $2 and title = $3
          and status = 'scheduled' and published_at is null
        returning id, channel_id, scheduled_at`,
      [postId, contentId, a.title, prevTitle, kind]
    );
    if (!post) continue;
    const taskIds = parseIdList(a.closed_task_ids);
    if (taskIds.length) {
      await query(
        `update tasks set done = false, done_at = null
          where post_id = $1 and id = any($2::int[]) and kind in ('write','swap') and done = true`,
        [postId, taskIds]
      );
    }
    detached.push({ ...post, content_id: contentId });
  }

  await recordDismissals([...removed, ...detached]);
  res.json({ removed: removed.length, detached: detached.length,
             ignored: created.length + attached.length - removed.length - detached.length });
}));

/* ========================= מבצע דחוף ========================= */

/** תצוגה מקדימה: "מה יקרה" — בלי לשמור כלום */
r.post('/urgent/preview', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planUrgent(req.body ?? {}));
}));

/** אישור: משבץ בפועל לפי אותה תוכנית */
r.post('/urgent/commit', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const plan = await planUrgent(b);
  if (plan.errors?.length) return bad(res, plan.errors.join(' · '));
  if (plan.placements.length === 0) return bad(res, 'לא נמצא שטח פנוי לשיבוץ הדחוף');

  const needsApproval = !(req.user.is_owner || req.user.perm_approve);
  // מפתח אחד לכל הפוסטים של המבצע — "אשר את כל המבצע" בחלון הפוסט
  const group = crypto.randomUUID();
  const created = [];
  for (const p of plan.placements) {
    const post = await one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at,
                          status, assignee_id, urgent, note, urgent_group)
       values ($1,$2,$3,'promo',$4,$5,$6,true,$7,$8) returning *`,
      [p.channel_id, b.endpoint_id ?? null, b.title, p.scheduled_at,
       needsApproval ? 'pending_approval' : 'scheduled',
       b.assignee_id ?? req.user.id, p.note ?? null, group]
    );
    created.push(post);
    if (needsApproval) {
      await query(
        `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent)
         values ($1,$2,'approve',$3,$4,true)`,
        [`לאשר: ${b.title}`, `${p.channel_name} · ${p.day_label} · דורש הרשאת אישור`,
         post.id, b.endpoint_id ?? null]
      );
    }
  }
  res.status(201).json({ posts: created, pending: needsApproval });
}));

export default r;
