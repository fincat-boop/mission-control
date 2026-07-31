/**
 * נתונים וסטטיסטיקה לתקופה נבחרת.
 *
 * הכול נספר מהמצב האמיתי בזמן הקריאה — אין טבלת סיכומים שצריך לתחזק
 * ושיכולה להתיישן. התקופה נקבעת בשני תאריכים, וכל מספר כאן מתייחס אך
 * ורק אליה.
 */

import { one, rows } from './db.js';
import { ymd } from './board.js';

/** ברירות מחדל: החודש האחרון */
export function periodOf(from, to) {
  const end = to ? new Date(`${String(to).slice(0, 10)}T23:59:59`) : new Date();
  const start = from
    ? new Date(`${String(from).slice(0, 10)}T00:00:00`)
    : (() => { const d = new Date(end); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d; })();

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('טווח התאריכים לא תקין');
  }
  if (start > end) throw new Error('תאריך הסיום מוקדם מתאריך ההתחלה');

  // מספר הימים כולל את שני הקצוות, בלי חשבון אלפיות שנשבר במעבר שעון
  const p = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((p(end) - p(start)) / 86400000) + 1;
  return { start, end, days, from: ymd(start), to: ymd(end), weeks: days / 7 };
}

export async function buildStats(from, to) {
  const period = periodOf(from, to);
  const args = [period.start, period.end];

  const [totals, byKind, byChannel, byEndpoint, contentMade, tasks, engine, activity] =
    await Promise.all([
      one(
        `select
           count(*) filter (where status = 'published')::int      as published,
           count(*) filter (where status = 'scheduled')::int      as scheduled,
           count(*) filter (where status = 'pending_approval')::int as pending,
           count(*) filter (where status = 'hole'
             or (status = 'scheduled' and content_id is null))::int as holes,
           count(*) filter (where urgent)::int                    as urgent
         from posts where scheduled_at between $1 and $2`, args),

      rows(
        `select kind, count(*)::int as n
           from posts where scheduled_at between $1 and $2 and status = 'published'
          group by kind`, args),

      rows(
        `select c.id, c.name, c.target_per_week, c.max_per_week,
                count(p.id) filter (where p.status = 'published')::int as published,
                count(p.id) filter (where p.status <> 'hole')::int     as placed
           from channels c
           left join posts p on p.channel_id = c.id and p.scheduled_at between $1 and $2
          group by c.id order by c.sort_order, c.id`, args),

      rows(
        `select e.id, e.name, e.importance,
                count(p.id) filter (where p.status = 'published')::int as published,
                count(p.id) filter (where p.status <> 'hole')::int     as placed,
                max(p.published_at)                                    as last_published
           from endpoints e
           left join posts p on p.endpoint_id = e.id and p.scheduled_at between $1 and $2
          group by e.id order by e.importance desc, e.id`, args),

      one(
        `select
           count(*)::int as created,
           count(*) filter (where evergreen)::int as evergreen
         from content_items where created_at between $1 and $2`, args),

      one(
        `select
           count(*) filter (where created_at between $1 and $2)::int as opened,
           count(*) filter (where done and done_at between $1 and $2)::int as closed,
           avg(extract(epoch from (done_at - created_at)) / 3600)
             filter (where done and done_at between $1 and $2) as avg_hours
         from tasks`, args),

      one(
        `select count(*)::int as runs
           from activity_log
          where action = 'apply' and created_at between $1 and $2`, args),

      rows(
        `select via, count(*)::int as n
           from activity_log where created_at between $1 and $2 group by via`, args),
    ]);

  // הנתח בפועל: כמה מהשטח שיצא בתקופה הלך לכל נקודת קצה
  const placedTotal = byEndpoint.reduce((s, e) => s + e.placed, 0);
  const totalWeight = byEndpoint.reduce((s, e) => s + (e.importance ?? 0), 0);

  const endpoints = byEndpoint.map((e) => ({
    ...e,
    share_actual: placedTotal ? Math.round((e.placed / placedTotal) * 100) : 0,
    // מה שהיה מגיע לה לפי משקל בלבד — קו ייחוס, לא יעד מחייב
    share_by_weight: totalWeight ? Math.round(((e.importance ?? 0) / totalWeight) * 100) : 0,
  }));

  const channels = byChannel.map((c) => ({
    ...c,
    per_week_actual: +(c.placed / period.weeks).toFixed(1),
    // מול הקצב הרצוי, לא מול התקרה
    target_per_week: c.target_per_week ?? c.max_per_week,
  }));

  const kinds = { promo: 0, value: 0, hybrid: 0 };
  for (const k of byKind) kinds[k.kind] = k.n;
  const valuePerPromo = kinds.promo
    ? +((kinds.value + kinds.hybrid * 0.5) / kinds.promo).toFixed(1) : null;

  return {
    period: { from: period.from, to: period.to, days: period.days },
    totals: { ...totals, ...contentMade, content_created: contentMade.created },
    kinds,
    value_per_promo: valuePerPromo,
    channels,
    endpoints,
    tasks: {
      opened: tasks.opened,
      closed: tasks.closed,
      avg_hours: tasks.avg_hours ? Math.round(Number(tasks.avg_hours)) : null,
    },
    engine_runs: engine.runs,
    activity_by_via: Object.fromEntries(activity.map((a) => [a.via, a.n])),
  };
}

/** יומן הפעולות לתקופה, עם סינון אופציונלי */
export async function readActivity({ from, to, user_id, via, entity, limit = 200 } = {}) {
  const period = periodOf(from, to);
  const params = [period.start, period.end];
  const where = ['created_at between $1 and $2'];

  for (const [col, val] of [['user_id', user_id], ['via', via], ['entity', entity]]) {
    if (val != null && val !== '') {
      params.push(val);
      where.push(`${col} = $${params.length}`);
    }
  }
  params.push(Math.min(Number(limit) || 200, 500));

  return {
    period: { from: period.from, to: period.to, days: period.days },
    entries: await rows(
      `select id, user_id, user_name, via, action, entity, entity_id, summary, meta, created_at
         from activity_log
        where ${where.join(' and ')}
        order by created_at desc
        limit $${params.length}`,
      params
    ),
  };
}
