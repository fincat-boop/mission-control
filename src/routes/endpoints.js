import { Router } from 'express';
import { autoFill, bad, refillCampaigns, releaseHeld, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { effectiveCadenceDays } from '../board.js';
import { requirePerm } from '../auth.js';
import { openPostSql } from '../live.js';

/** פוסט עתידי שלא פורסם (לא כולל 'publishing' — פרסום באמצע לא נעצר) */
const FUTURE_OPEN = `${openPostSql('p')} and p.scheduled_at >= now()`;

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
  const before = await one('select active from endpoints where id = $1', [req.params.id]);
  const e = await updateById('endpoints', ENDPOINT_FIELDS, req.params.id, req.body);
  if (!e) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  // הופעלה מחדש — כמו קמפיין שחזר מהשהיה (releaseHeld, סעיף 16): מאושר
  // שהמועד שלו עבר חוזר לאישור (בלי פרץ בטיק הבא), עתידי שלא אושר נמחק
  // והמנוע ממקם מחדש את הקמפיינים שלה — בזמן ההשבתה המקום שלה היה פנוי לאחרים
  if (before && !before.active && e.active) {
    const { reset, cleared } = await releaseHeld('endpoint', e.id);
    const ids = await rows(
      `select id from campaigns
        where endpoint_id = $1 and active and paused_at is null
          and (ends_on is null or ends_on >= current_date)
        order by id`, [e.id]);
    const engine = await refillCampaigns(ids.map((x) => x.id), req.body?.week);
    return res.json({ endpoint: { ...e, effective_min_days: effectiveCadenceDays(e) }, engine,
                      approval_reset: reset, cleared });
  }
  const engine = await autoFill(req.body?.week);
  res.json({ endpoint: { ...e, effective_min_days: effectiveCadenceDays(e) }, engine,
             approval_reset: 0, cleared: 0 });
}));

/**
 * מה השבתה ומחיקה של הנקודה נוגעות בו — לחלון האישור לפניהן:
 *   campaigns / content — נמחקים איתה (cascade).
 *   future_posts — פוסטים עתידיים שלא פורסמו: בהשבתה מוחזקים (יורדים מהלוח
 *     ולא יוצאים), במחיקה נמחקים. future_approved — כמה מהם אושרו לפרסום.
 *   past_open — המועד עבר ולא סומנו (אולי יצאו): נשארים גם במחיקה, בלי נקודה ובלי תוכן.
 *   missed_approved — מאושרים שהמועד שלהם עבר: בהפעלה מחדש חוזרים לאישור.
 *   published — נשארים בהיסטוריה תמיד (בלי נקודה ובלי תוכן אחרי מחיקה).
 *   posts — הכול (לשאלה אם יש בכלל מה לאבד).
 */
async function endpointImpact(id) {
  return one(
    `select e.id, e.name, e.active,
            (select count(*)::int from campaigns c     where c.endpoint_id = e.id)  as campaigns,
            (select count(*)::int from content_items ci where ci.endpoint_id = e.id) as content,
            (select count(*)::int from posts p          where p.endpoint_id = e.id)  as posts,
            (select count(*)::int from posts p where p.endpoint_id = e.id
                and ${FUTURE_OPEN}) as future_posts,
            (select count(*)::int from posts p where p.endpoint_id = e.id
                and ${FUTURE_OPEN} and p.status = 'approved') as future_approved,
            (select count(*)::int from posts p where p.endpoint_id = e.id
                and ${openPostSql('p')} and p.scheduled_at < now()) as past_open,
            (select count(*)::int from posts p where p.endpoint_id = e.id
                and p.status = 'approved' and p.scheduled_at < now()) as missed_approved,
            (select count(*)::int from posts p where p.endpoint_id = e.id
                and p.status = 'published') as published
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
  // הפוסטים העתידיים שלה שלא פורסמו יורדים איתה — באותה טרנזקציה (כמו
  // מחיקת קמפיין עם התוכן). מה שפורסם, ומה שהמועד שלו עבר (אולי יצא),
  // נשאר בהיסטוריה בלי נקודה ובלי תוכן (set null).
  const removed = await rows(
    `delete from posts p where p.endpoint_id = $1 and ${FUTURE_OPEN} returning p.id`,
    [req.params.id]);
  await query('delete from endpoints where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, removed_posts: removed.length, engine });
}));

export default r;
