import { Router } from 'express';
import { autoFill, bad, evictBlocked, refillCampaigns, releaseHeld, updateById, wrap } from './_shared.js';
import { openPostSql } from '../live.js';
import { one, query, rows } from '../db.js';
import { requirePerm } from '../auth.js';
import { LinkError, releaseLinks } from '../links.js';
import { resetChannelApprovals } from '../publish/approval.js';

const r = Router();

/* ========================= ערוצים ========================= */

r.get('/channels', wrap(async (_req, res) => {
  res.json({ channels: await rows('select * from channels order by sort_order, id') });
}));

// target_per_week לא כאן: "פוסטים בשבוע" הוא max_per_week בלבד. העמודה נשארת
// בסכימה (שורות ישנות), אבל אף אחד כבר לא קורא או כותב אותה.
const CHANNEL_FIELDS = ['name', 'max_per_week', 'max_promo_per_week',
                        'max_hybrid_per_week', 'max_value_per_week', 'urgent_reserve_pct',
                        'blocked_days', 'active', 'sort_order', 'efficiency', 'platform',
                        'default_hour'];

/** שעת הפרסום הרגילה (סעיף 12): שעה שלמה 0–22, או null (= 10:00) */
const badHour = (v) => v != null && !(Number.isInteger(Number(v)) && v !== '' &&
  Number(v) >= 0 && Number(v) <= 22);

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
  if (badHour(req.body?.default_hour)) return bad(res, 'שעת הפרסום צריכה להיות שעה שלמה בין 0 ל-22');
  const before = await one('select active, disabled_at from channels where id = $1', [req.params.id]);
  const c = await updateById('channels', CHANNEL_FIELDS, req.params.id, req.body);
  if (!c) return bad(res, 'לא נמצא ערוץ כזה', 404);
  // הופעל מחדש (releaseHeld, סעיף 16): שום דבר לא נמחק — הפוסטים חוזרים
  // למקומם, מאושר שהמועד שלו עבר חוזר לאישור, והמילוי רק משלים מקום פנוי
  const reactivated = before && !before.active && c.active;
  const { reset, back } = reactivated
    ? await releaseHeld('channel', c.id, { since: before.disabled_at }) : { reset: 0, back: 0 };
  // הושבת (D1): ערוץ מושבת לא מתפרסם — המאושרים שלו חוזרים לאישור
  const disabledReset = before?.active && !c.active ? await resetChannelApprovals(c.id) : 0;

  // קודם מפנים מה שנעשה לא חוקי, ורק אז ממלאים — אחרת המילוי תופס את
  // הימים שהפוסטים המפונים אמורים לעבור אליהם.
  const relocated = 'blocked_days' in (req.body ?? {}) ? await evictBlocked() : null;
  // הקמפיינים שרצים בערוץ — לכל התקופה שלהם; אחרת השבוע המוצג
  const ids = reactivated ? await rows(
    `select ca.id from campaigns ca
       join campaign_channels cc on cc.campaign_id = ca.id and cc.channel_id = $1
       join endpoints e on e.id = ca.endpoint_id and e.active
      where ca.active and ca.paused_at is null
        and (ca.ends_on is null or ca.ends_on >= current_date)
      order by ca.id`, [c.id]) : [];
  const engine = await refillCampaigns(ids.map((x) => x.id), req.body?.week);
  res.json({ channel: c, engine, relocated, approval_reset: reset + disabledReset, back });
}));

/**
 * מה נמחק עם הערוץ: הפוסטים שלו (cascade, כולל שפורסמו) ותוצאותיהם.
 * לפני מחיקה — הממשק מציג את זה ומציע להשבית במקום. future_posts — פוסטים
 * עתידיים שלא פורסמו: מה שהשבתה מחזיקה (יורד מהלוח ולא יוצא, סעיף 16).
 */
async function channelImpact(id) {
  return one(
    `select c.id, c.name, c.active,
            count(p.id) filter (where p.status = 'published')::int  as published,
            count(p.id) filter (where p.status <> 'published')::int as other,
            count(p.id) filter (where ${openPostSql('p')} and p.scheduled_at >= now())::int
              as future_posts,
            count(p.id) filter (where p.status = 'approved' and p.scheduled_at >= now())::int
              as future_approved,
            -- מאושרים שפוספסו בזמן ההשבתה (disabled_at; null — כל העבר)
            count(p.id) filter (where p.status = 'approved' and p.scheduled_at < now()
                and p.scheduled_at >= coalesce(c.disabled_at, '-infinity'::timestamptz))::int
              as missed_approved,
            count(pr.post_id)::int                                  as results,
            (select count(*)::int from content_variants v
              where v.channel_id = c.id and coalesce(btrim(v.body), '') <> '') as variants
       from channels c
       left join posts p         on p.channel_id = c.id
       left join post_results pr on pr.post_id = p.id
      where c.id = $1
      group by c.id`,
    [id]
  );
}

r.get('/channels/:id/delete-impact', requirePerm('settings'), wrap(async (req, res) => {
  const impact = await channelImpact(req.params.id);
  if (!impact) return bad(res, 'לא נמצא ערוץ כזה', 404);
  res.json({ impact });
}));

r.delete('/channels/:id', requirePerm('settings'), wrap(async (req, res) => {
  const impact = await channelImpact(req.params.id);
  if (!impact) return bad(res, 'לא נמצא ערוץ כזה', 404);
  // היסטוריה שפורסמה או ניסוחים שנכתבו לערוץ — לא נמחקים בלי בקשה מפורשת
  if ((impact.published > 0 || impact.variants > 0) && req.query.force !== '1') {
    return res.status(409).json({
      error: `בערוץ יש ${impact.published} פוסטים שפורסמו ו־${impact.variants} ניסוחים שנכתבו לו — מחיקה תמחק את כולם. אפשר להשבית את הערוץ במקום.`,
      impact, needs_force: true,
    });
  }
  // משבצות מקושרות במדיה שנמחקת: הגרסה והקבצים שלהן יורדים עם המדיה, והשאר
  // בקבוצה היו נשארות בלי מקור. מתפרקות קודם — כל אחת עם עותק משלה.
  const linked = await rows(
    `select ci.id from content_items ci
      where ci.slot_channel_id = $1
        and (ci.linked_to_id is not null
             or exists (select 1 from content_items f where f.linked_to_id = ci.id))
      order by ci.campaign_id, ci.id`, [req.params.id]);
  try {
    for (const x of linked) await releaseLinks(x.id);
  } catch (e) {
    if (e instanceof LinkError) return bad(res, e.message, e.status);
    throw e;
  }
  await query('delete from channels where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

export default r;
