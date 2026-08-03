import { Router } from 'express';
import { autoFill, bad, updateById, wrap } from './_shared.js';
import { buildBoard } from '../board.js';
import { requirePerm } from '../auth.js';
import { gapWarning } from '../gap.js';
import { one, query, rows } from '../db.js';
import { parseMetric } from '../performance.js';

const r = Router();

/* ========================= הלוח ========================= */

r.get('/board', wrap(async (req, res) => {
  res.json(await buildBoard(req.query.week));
}));

r.post('/posts', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel_id || !b.scheduled_at || !b.title) {
    return bad(res, 'צריך ערוץ, כותרת ומועד');
  }
  if (!['promo', 'value', 'hybrid'].includes(b.kind)) {
    return bad(res, 'סוג הפוסט חייב להיות promo / value / hybrid');
  }
  // שיבוץ צמוד מדי לפוסט קיים של אותה נקודה — מזהיר, לא חוסם
  const gap = await gapWarning({
    endpointId: b.endpoint_id, channelId: b.channel_id, when: b.scheduled_at,
  });
  if (gap && !b.confirm_gap) {
    return res.status(409).json({ error: gap.message, warning: gap, needs_confirm: true });
  }

  const post = await one(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                        scheduled_at, status, assignee_id, urgent, note)
     values ($1,$2,$3,$4,$5,$6,coalesce($7,'scheduled'),$8,coalesce($9,false),$10)
     returning *`,
    [b.channel_id, b.endpoint_id ?? null, b.content_id ?? null, b.title, b.kind,
     b.scheduled_at, b.status ?? null, b.assignee_id ?? null, b.urgent ?? false, b.note ?? null]
  );
  res.status(201).json({ post });
}));

const POST_FIELDS = ['channel_id', 'endpoint_id', 'content_id', 'title', 'kind',
                     'scheduled_at', 'status', 'assignee_id', 'urgent', 'note'];

r.patch('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const current = await one('select * from posts where id = $1', [req.params.id]);
  if (!current) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  // הזזה על הלוח עוברת את אותו כלל שהמנוע והמבצע הדחוף מכבדים:
  // נקודת קצה אחת, מדיה אחת, יום אחד.
  if (b.scheduled_at || b.channel_id) {
    const when = b.scheduled_at ?? current.scheduled_at;
    const channel = b.channel_id ?? current.channel_id;
    const endpoint = b.endpoint_id ?? current.endpoint_id;

    if (endpoint) {
      const clash = await one(
        `select p.id, p.title from posts p
          where p.id <> $1 and p.endpoint_id = $2 and p.channel_id = $3
            and p.scheduled_at::date = $4::date`,
        [current.id, endpoint, channel, when]
      );
      if (clash) {
        return bad(res, `כבר יש פוסט לאותה נקודת קצה במדיה הזו באותו יום: ${clash.title}`);
      }
    }

    // יום שהמדיה לא מקבלת בו תוכן
    const target = await one('select name, blocked_days from channels where id = $1', [channel]);
    const dow = new Date(when).getDay();
    if ((target?.blocked_days ?? []).includes(dow)) {
      const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
      return bad(res, `${target.name} לא מקבל תוכן בימי ${names[dow]}`);
    }

    // מעבר למדיה אחרת דורש שקיימת לתוכן גרסה למדיה הזו — אחרת היינו
    // מפרסמים שם ניסוח שנכתב למדיה אחרת
    if (b.channel_id && b.channel_id !== current.channel_id && current.content_id) {
      const v = await one(
        'select status from content_variants where content_id = $1 and channel_id = $2',
        [current.content_id, b.channel_id]
      );
      if (!v) {
        const ch = await one('select name from channels where id = $1', [b.channel_id]);
        return bad(res, `אין לתוכן הזה גרסה ל${ch?.name ?? 'מדיה הזו'} — כותבים אותה קודם בתוכן`);
      }
    }

    const gap = await gapWarning({
      endpointId: endpoint, channelId: channel, when, excludePostId: current.id,
    });
    if (gap && !b.confirm_gap) {
      return res.status(409).json({ error: gap.message, warning: gap, needs_confirm: true });
    }
  }

  const post = await updateById('posts', POST_FIELDS, req.params.id, b);
  res.json({ post });
}));

/**
 * מה שאמור לצאת בפועל: הטקסט של המדיה הזו והקבצים שלה.
 * הלוח מציג את זה בלחיצה, במקום טופס עריכה — הפרמטרים נקבעים בתוכן.
 */
r.get('/posts/:id/preview', wrap(async (req, res) => {
  const p = await one(
    `select p.*, c.name as channel_name, e.name as endpoint_name,
            u.name as assignee_name, ci.title as content_title, ci.kind as content_kind,
            ci.evergreen, ca.name as campaign_name
       from posts p
       left join channels c       on c.id = p.channel_id
       left join endpoints e      on e.id = p.endpoint_id
       left join users u          on u.id = p.assignee_id
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.id = $1`,
    [req.params.id]
  );
  if (!p) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  const variant = p.content_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
                [p.content_id, p.channel_id])
    : null;

  const assets = p.content_id
    ? await rows(
        `select id, filename, mime, size_bytes, variant_id
           from content_assets
          where content_id = $1 and (variant_id is null or variant_id = $2)
          order by variant_id nulls last, id`,
        [p.content_id, variant?.id ?? null])
    : [];

  // התוצאות נשלחות יחד עם התצוגה המקדימה כדי שהדיאלוג לא יצטרך קריאה שנייה
  const results = await one('select * from post_results where post_id = $1', [p.id]);

  res.json({ post: p, variant, assets, results });
}));

/**
 * הזנת התוצאות בפועל. שדה ריק נשמר כ-null ("לא נמדד") ולא כאפס —
 * ההבחנה הזו היא הבסיס לכל חישוב היעילות (ראו src/performance.js).
 */
r.put('/posts/:id/results', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const post = await one('select id from posts where id = $1', [req.params.id]);
  if (!post) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  let vals;
  try {
    vals = [parseMetric(b.reach), parseMetric(b.engagement),
            parseMetric(b.clicks), parseMetric(b.leads)];
  } catch (e) {
    return bad(res, e.message);
  }

  const results = await one(
    `insert into post_results (post_id, reach, engagement, clicks, leads, note)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (post_id) do update set
       reach = excluded.reach, engagement = excluded.engagement,
       clicks = excluded.clicks, leads = excluded.leads,
       note = excluded.note, updated_at = now()
     returning *`,
    [req.params.id, ...vals, b.note?.trim() || null]
  );
  res.json({ results });
}));

r.delete('/posts/:id/results', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from post_results where post_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

r.delete('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from posts where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

/** סימון "פורסם" — מעדכן גם את המשימה הצמודה */
r.post('/posts/:id/publish', requirePerm('content'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'published', published_at = now()
      where id = $1 returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'לא נמצא שיבוץ כזה', 404);
  await query(
    `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
    [post.id]
  );
  res.json({ post });
}));

/** ביטול "פורסם" — חוזר למתוכנן, למקרה שסימנו בטעות */
r.post('/posts/:id/unpublish', requirePerm('content'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled', published_at = null
      where id = $1 and status = 'published' returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ מפורסם עם המזהה הזה', 404);
  res.json({ post });
}));

/** אישור דחוף־דורס — הרשאה נפרדת */
r.post('/posts/:id/approve', requirePerm('approve'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled' where id = $1 and status = 'pending_approval'
      returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ שממתין לאישור עם המזהה הזה', 404);
  await query(`update tasks set done = true, done_at = now() where post_id = $1`, [post.id]);
  res.json({ post });
}));

export default r;
