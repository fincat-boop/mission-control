import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { currentAllocation, shareTimeline } from '../campaigns.js';
import { one, query, rows } from '../db.js';
import { buildAlerts } from '../alerts.js';
import { requirePerm } from '../auth.js';

const r = Router();

/* ========================= אסטרטגיה ========================= */

/**
 * התמונה ברמת נקודות הקצה: איך השטח מתחלק ביניהן לאורך הזמן,
 * וכמה כל אחת קיבלה בפועל.
 */
r.get('/strategy', wrap(async (_req, res) => {
  const [timeline, allocation, milestones, endpoints, campaigns] = await Promise.all([
    shareTimeline(),
    currentAllocation(),
    rows(`select m.*, e.name as endpoint_name from strategy_milestones m
            left join endpoints e on e.id = m.endpoint_id order by m.on_date`),
    rows('select * from endpoints order by importance desc, id'),
    rows(`select c.*, count(ci.id)::int as content_count,
                 count(ci.id) filter (where ci.evergreen)::int as evergreen_count
            from campaigns c
            left join content_items ci on ci.campaign_id = c.id
           group by c.id order by c.starts_on nulls last, c.id`),
  ]);

  // הספירה היא ישירות מול נקודת הקצה ולא דרך הקמפיינים,
  // אחרת התוכן השוטף — שאין לו קמפיין — נופל מהספירה
  const contentStats = await rows(
    `select endpoint_id,
            count(*)::int as content_count,
            count(*) filter (where evergreen)::int as evergreen_count,
            count(*) filter (where campaign_id is null)::int as background_count
       from content_items group by endpoint_id`
  );
  const statsBy = new Map(contentStats.map((s) => [s.endpoint_id, s]));

  const byEndpoint = endpoints.map((e) => {
    const s = statsBy.get(e.id);
    return {
      ...e,
      campaigns: campaigns.filter((c) => c.endpoint_id === e.id),
      content_count: s?.content_count ?? 0,
      evergreen_count: s?.evergreen_count ?? 0,
      background_count: s?.background_count ?? 0,
    };
  });

  res.json({ timeline, allocation, milestones, endpoints: byEndpoint });
}));

/* ========================= התראות ========================= */

/**
 * ההתראות מחושבות בזמן קריאה מהמצב האמיתי, ולא נשמרות בטבלה —
 * ולכן התראה נעלמת מעצמה ברגע שהבעיה נפתרה.
 */
r.get('/alerts', wrap(async (_req, res) => {
  res.json(await buildAlerts());
}));

/* ========================= אבני דרך ========================= */

r.post('/strategy/milestones', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.label || !b.on_date) return bad(res, 'צריך שם ותאריך לאבן הדרך');
  const m = await one(
    `insert into strategy_milestones (endpoint_id, label, on_date)
     values ($1,$2,$3) returning *`,
    [b.endpoint_id ?? null, b.label, b.on_date]
  );
  res.status(201).json({ milestone: m });
}));

r.delete('/strategy/milestones/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from strategy_milestones where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

export default r;
