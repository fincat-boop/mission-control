import { one, rows } from './db.js';
import { ymd } from './board.js';
import { campaignsWithHealth } from './campaigns.js';

/**
 * מרכז ההתראות. הכול מחושב בזמן קריאה — אין טבלת התראות,
 * ולכן אין מצב שהתראה נשארת תלויה אחרי שהבעיה נפתרה.
 *
 * רמות: crit (חוסם), warn (דורש טיפול), info (לידיעה)
 */

const DAY = 86400000;
const UPCOMING_WINDOW_DAYS = 7; // מתי מתחילים להתריע על קמפיין שעומד להתחיל

export async function buildAlerts() {
  const settings = await one('select * from engine_settings where id = 1');
  const alertHours = settings?.content_alert_hours ?? 48;

  const [campaigns, endpoints, holes, pending, soonWithoutContent] = await Promise.all([
    campaignsWithHealth(),
    endpointsWithoutAir(),
    rows(`select p.id, p.scheduled_at, e.name as endpoint_name, c.name as channel_name
            from posts p
            left join endpoints e on e.id = p.endpoint_id
            left join channels c  on c.id = p.channel_id
           where p.status = 'hole' and p.scheduled_at >= now() - interval '7 days'
           order by p.scheduled_at`),
    rows(`select p.id, p.title, p.scheduled_at, c.name as channel_name
            from posts p left join channels c on c.id = p.channel_id
           where p.status = 'pending_approval' order by p.scheduled_at`),
    rows(
      `select p.id, p.title, p.scheduled_at, c.name as channel_name
         from posts p left join channels c on c.id = p.channel_id
        where p.status = 'scheduled' and p.content_id is null
          and p.scheduled_at between now() and now() + ($1 || ' hours')::interval
        order by p.scheduled_at`,
      [alertHours]
    ),
  ]);

  const alerts = [];
  const today = ymd(new Date());

  for (const c of campaigns) {
    if (c.phase === 'ended' || c.phase === 'inactive') continue;

    const daysToStart = c.starts_on
      ? Math.round((new Date(c.starts_on) - new Date(today)) / DAY) : null;

    if (c.missing_content > 0) {
      const starting = c.phase === 'upcoming' && daysToStart !== null &&
                       daysToStart <= UPCOMING_WINDOW_DAYS;
      if (c.phase === 'running' || starting) {
        alerts.push({
          id: `campaign-content-${c.id}`,
          level: c.phase === 'running' ? 'crit' : 'warn',
          title: `חסר תוכן: ${c.name}`,
          detail: c.phase === 'running'
            ? `הקמפיין רץ וחסרים לו ${c.missing_content} פוסטים מתוך ${c.required}`
            : `מתחיל בעוד ${daysToStart} ימים וחסרים לו ${c.missing_content} מתוך ${c.required}`,
          tab: 'campaigns',
          campaign_id: c.id,
        });
      }
    }

    if (c.phase === 'running' && c.pace?.behind > 0) {
      alerts.push({
        id: `campaign-pace-${c.id}`,
        level: 'warn',
        title: `מפגר אחרי הקצב: ${c.name}`,
        detail: `לפי התדירות שהוגדרה היו אמורים לצאת ${c.pace.expected_by_now} פוסטים, ` +
                `יצאו ${c.pace.published}`,
        tab: 'campaigns',
        campaign_id: c.id,
      });
    }

    if (c.phase === 'running' && c.missing_content === 0 && c.unplaced > 0) {
      alerts.push({
        id: `campaign-unplaced-${c.id}`,
        level: 'info',
        title: `תוכן ממתין לשיבוץ: ${c.name}`,
        detail: `${c.unplaced} פריטי תוכן מוכנים ועוד לא נכנסו ללוח`,
        tab: 'campaigns',
        campaign_id: c.id,
      });
    }
  }

  for (const e of endpoints) {
    alerts.push({
      id: `endpoint-air-${e.id}`,
      level: e.days_over >= e.min_days_between ? 'crit' : 'warn',
      title: `${e.name} לא מפרסמת`,
      detail: e.days_since === null
        ? 'עוד לא פורסם ממנה כלום'
        : `${e.days_since} ימים בלי פרסום — הקצב שהוגדר הוא כל ${e.min_days_between}`,
      tab: 'campaigns',
      endpoint_id: e.id,
    });
  }

  for (const h of holes) {
    alerts.push({
      id: `hole-${h.id}`,
      level: 'crit',
      title: `הלוח מחכה לתוכן — ${h.endpoint_name ?? 'לא משויך'}`,
      detail: `${h.channel_name} · ${new Date(h.scheduled_at).toLocaleDateString('he-IL')}`,
      tab: 'board',
      post_id: h.id,
    });
  }

  for (const p of pending) {
    alerts.push({
      id: `approval-${p.id}`,
      level: 'warn',
      title: `ממתין לאישור: ${p.title}`,
      detail: `${p.channel_name} · ${new Date(p.scheduled_at).toLocaleDateString('he-IL')}`,
      tab: 'tasks',
      post_id: p.id,
    });
  }

  for (const p of soonWithoutContent) {
    alerts.push({
      id: `no-text-${p.id}`,
      level: 'crit',
      title: `אין טקסט לפוסט שמתפרסם בקרוב`,
      detail: `${p.title} · ${p.channel_name} · ` +
              `${new Date(p.scheduled_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}`,
      tab: 'board',
      post_id: p.id,
    });
  }

  const order = { crit: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  return {
    alerts,
    counts: {
      total: alerts.length,
      crit: alerts.filter((a) => a.level === 'crit').length,
      warn: alerts.filter((a) => a.level === 'warn').length,
      info: alerts.filter((a) => a.level === 'info').length,
    },
  };
}

/** נקודות קצה שעברו את הקצב שהוגדר להן בלי פרסום */
async function endpointsWithoutAir() {
  const list = await rows(
    `select e.id, e.name, e.min_days_between,
            max(p.published_at) as last_at
       from endpoints e
       left join posts p on p.endpoint_id = e.id and p.status = 'published'
      where e.active = true
      group by e.id, e.name, e.min_days_between`
  );
  const now = new Date();
  return list
    .map((e) => {
      const daysSince = e.last_at ? Math.floor((now - new Date(e.last_at)) / DAY) : null;
      return { ...e, days_since: daysSince, days_over: daysSince === null ? 999 : daysSince };
    })
    .filter((e) => e.days_since === null || e.days_since > e.min_days_between);
}
