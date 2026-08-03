import { Router } from 'express';
import { autoFill, bad, updateById, wrap } from './_shared.js';
import { campaignsWithHealth, currentAllocation } from '../campaigns.js';
import { one, rows, tx } from '../db.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= קמפיינים ========================= */

/** כל הקמפיינים עם מצב מלאות, קצב והתוכן שמשויך אליהם */
r.get('/campaigns', wrap(async (_req, res) => {
  const [campaigns, allocation, milestones] = await Promise.all([
    campaignsWithHealth(),
    currentAllocation(),
    rows(`select m.*, e.name as endpoint_name
            from strategy_milestones m
            left join endpoints e on e.id = m.endpoint_id
           order by m.on_date`),
  ]);
  res.json({ campaigns, allocation, milestones });
}));

const CAMPAIGN_FIELDS = ['name', 'endpoint_id', 'starts_on', 'ends_on', 'share_pct',
                         'importance', 'target_posts', 'goal', 'urgent', 'active'];

/** מעדכן על אילו מדיות הקמפיין יושב */
async function setCampaignChannels(client, campaignId, ids) {
  await client.query('delete from campaign_channels where campaign_id = $1', [campaignId]);
  for (const channelId of ids) {
    await client.query(
      `insert into campaign_channels (campaign_id, channel_id) values ($1,$2)
       on conflict do nothing`,
      [campaignId, channelId]
    );
  }
}

r.post('/campaigns', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.endpoint_id || !b.name) return bad(res, 'צריך נקודת קצה ושם קמפיין');
  if (b.starts_on && b.ends_on && b.starts_on > b.ends_on) {
    return bad(res, 'תאריך הסיום מוקדם מתאריך ההתחלה');
  }
  const c = await one(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct,
                            importance, target_posts, goal, urgent)
     values ($1,$2,$3,$4,$5,
             coalesce($6,(select importance from endpoints where id = $1)),
             $7,$8,coalesce($9,false))
     returning *`,
    [b.endpoint_id, b.name, b.starts_on ?? null, b.ends_on ?? null, b.share_pct ?? null,
     b.importance ?? null, b.target_posts ?? null, b.goal ?? null, b.urgent ?? false]
  );
  if (Array.isArray(b.channel_ids)) {
    await tx((client) => setCampaignChannels(client, c.id, b.channel_ids));
  }
  const engine = await autoFill(b.week);
  res.status(201).json({ campaign: c, engine });
}));

r.patch('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (b.starts_on && b.ends_on && b.starts_on > b.ends_on) {
    return bad(res, 'תאריך הסיום מוקדם מתאריך ההתחלה');
  }

  const before = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!before) return bad(res, 'לא נמצא קמפיין כזה', 404);

  const c = await updateById('campaigns', CAMPAIGN_FIELDS, req.params.id, b);
  if (Array.isArray(b.channel_ids)) {
    await tx((client) => setCampaignChannels(client, c.id, b.channel_ids));
  }

  // הזזת קמפיין בזמן גוררת איתה את השיבוצים שלו. בלי זה הקמפיין זז
  // והפוסטים נשארים מאחור, מנותקים מהחלון שהם אמורים לשרת.
  let movedPosts = 0;
  if (b.starts_on && before.starts_on && b.starts_on !== before.starts_on) {
    const days = daysBetweenDates(before.starts_on, b.starts_on);
    if (days !== 0) {
      // רק מה שעוד לא יצא ועוד לא עבר. היסטוריה לא מזיזים.
      const moved = await rows(
        `update posts p
            set scheduled_at = p.scheduled_at + ($1 || ' days')::interval
           from content_items ci
          where ci.id = p.content_id
            and ci.campaign_id = $2
            and p.status in ('scheduled','pending_approval','hole')
            and p.scheduled_at >= now()
          returning p.id`,
        [days, c.id]
      );
      movedPosts = moved.length;
    }
  }

  const engine = await autoFill(b.week);
  res.json({ campaign: c, moved_posts: movedPosts, engine });
}));

/** מספר ימים בין שני תאריכים, בלי להיתקל במעבר שעון */
function daysBetweenDates(a, b) {
  const p = (s) => String(s).slice(0, 10).split('-').map(Number);
  const [ay, am, ad] = p(a);
  const [by, bm, bd] = p(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export default r;
