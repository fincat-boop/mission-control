import { currentOrg, one, rows } from './db.js';
import { isPlatformOrg } from './platform.js';
import { effectiveCadenceDays, ymd } from './board.js';
import { campaignsWithHealth } from './campaigns.js';
import { postsOnBlockedDays } from './respace.js';
import { suppressTaskedAlerts } from './task-lifecycle.js';
import { backupAlerts, readBackupLayers } from './backup-status.js';
import { mediaReady } from './media.js';

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * מרכז ההתראות. הכול מחושב בזמן קריאה — אין טבלת התראות,
 * ולכן אין מצב שהתראה נשארת תלויה אחרי שהבעיה נפתרה.
 *
 * רמות: crit (חוסם), warn (דורש טיפול), info (לידיעה)
 *
 * user — מי מבקש. התראה שדורשת הרשאה כדי לפעול (perm: 'approve' /
 * 'settings') מוצגת רק למי שיכול לפעול עליה. בלי user (העוזר) — הכול.
 */

const DAY = 86400000;
const UPCOMING_WINDOW_DAYS = 7; // מתי מתחילים להתריע על קמפיין שעומד להתחיל

export async function buildAlerts(user = null) {
  const settings = await one('select * from engine_settings limit 1');
  const alertHours = settings?.content_alert_hours ?? 48;

  const campaigns = await campaignsWithHealth();
  const endpoints = await endpointsWithoutAir();
  const holes = await rows(`select p.id, p.scheduled_at, e.name as endpoint_name, c.name as channel_name
          from posts p
          left join endpoints e on e.id = p.endpoint_id
          left join channels c  on c.id = p.channel_id
         where p.status = 'hole' and p.scheduled_at >= now() - interval '7 days'
         order by p.scheduled_at`);
  const pending = await rows(`select p.id, p.title, p.scheduled_at, c.name as channel_name
          from posts p left join channels c on c.id = p.channel_id
         where p.status = 'pending_approval' order by p.scheduled_at`);
  const soonWithoutContent = await rows(
    `select p.id, p.title, p.scheduled_at, c.name as channel_name
       from posts p left join channels c on c.id = p.channel_id
      where p.status = 'scheduled' and p.content_id is null
        and p.scheduled_at between now() and now() + ($1 || ' hours')::interval
      order by p.scheduled_at`,
    [alertHours]
  );
  // פרסום שנכשל — עד שבועיים אחורה. אחר כך זה כבר היסטוריה, לא מצב.
  const failed = await rows(`select p.id, p.title, p.scheduled_at, p.publish_error, c.name as channel_name
          from posts p left join channels c on c.id = p.channel_id
         where p.status = 'failed' and p.scheduled_at >= now() - interval '14 days'
           and not exists (select 1 from content_items ci
                             join campaigns ca on ca.id = ci.campaign_id
                            where ci.id = p.content_id and ca.paused_at is not null)
         order by p.scheduled_at`);
  // המועד עבר ואף אחד לא פרסם/סימן. חצי שעה חסד — וואטסאפ נשלח ידנית,
  // ופרסום אוטומטי עוד יכול להיות בדרך.
  const missed = await rows(`select p.id, p.title, p.scheduled_at, c.name as channel_name
          from posts p left join channels c on c.id = p.channel_id
         where p.status in ('scheduled','approved') and p.published_at is null
           and not exists (select 1 from content_items ci
                             join campaigns ca on ca.id = ci.campaign_id
                            where ci.id = p.content_id and ca.paused_at is not null)
           and p.scheduled_at between now() - interval '7 days'
                                  and now() - interval '30 minutes'
         order by p.scheduled_at`);
  // משימות פתוחות (שלא נדחו) שכבר מכסות התראה על אותו פוסט — suppressTaskedAlerts
  const openTasks = await rows(`select post_id, kind from tasks
         where not done and post_id is not null and kind in ('approve','write')
           and (snoozed_until is null or snoozed_until <= now())`);
  const backupLayers = await readBackupLayers();

  const alerts = [];
  const today = ymd(new Date());

  for (const c of campaigns) {
    // קמפיין מושהה לא מייצר רעש — ההשהיה היא החלטה, לא בעיה
    if (['ended','inactive','paused'].includes(c.phase)) continue;

    const daysToStart = c.starts_on
      ? Math.round((new Date(c.starts_on) - new Date(today)) / DAY) : null;

    if (c.missing_content > 0) {
      const starting = c.phase === 'upcoming' && daysToStart !== null &&
                       daysToStart <= UPCOMING_WINDOW_DAYS;
      if (c.phase === 'running' || starting) {
        alerts.push(campaignContentAlert(c, daysToStart));
      }
    }

    if (c.phase === 'running' && c.pace?.behind > 0) {
      alerts.push({
        id: `campaign-pace-${c.id}`,
        level: 'warn',
        title: `מפגר אחרי הקצב: ${c.name}`,
        detail: `לפי התדירות שהוגדרה היו אמורים לצאת ${c.pace.expected_by_now} פוסטים, ` +
                `יצאו ${c.pace.published}`,
        tab: 'plan',
        campaign_id: c.id,
      });
    }

    if (c.phase === 'running' && c.missing_content === 0 && c.unplaced > 0) {
      alerts.push({
        id: `campaign-unplaced-${c.id}`,
        level: 'info',
        title: `תוכן ממתין לשיבוץ: ${c.name}`,
        detail: `${c.unplaced} פריטי תוכן מוכנים ועוד לא נכנסו ללוח`,
        tab: 'plan',
        campaign_id: c.id,
      });
    }
  }

  alerts.push(...failedPostAlerts(failed), ...missedPostAlerts(missed));

  for (const e of endpoints) {
    const cadence = effectiveCadenceDays(e);
    alerts.push({
      id: `endpoint-air-${e.id}`,
      level: e.days_over >= cadence ? 'crit' : 'warn',
      title: `${e.name} לא מפרסמת`,
      detail: e.days_since === null
        ? `עוד לא פורסם ממנה כלום — נוספה לפני ${e.days_over} ימים, התדירות לפי החשיבות היא כל ${cadence} ימים`
        : `${e.days_since} ימים בלי פרסום — התדירות לפי החשיבות היא כל ${cadence} ימים`,
      tab: 'plan',
      endpoint_id: e.id,
    });
  }

  for (const h of holes) {
    alerts.push({
      id: `hole-${h.id}`,
      level: 'crit',
      title: `חסר תוכן על הלוח — ${h.endpoint_name ?? 'לא משויך'}`,
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
      perm: 'approve', // רק מי שיכול לאשר
      tab: 'tasks',
      post_id: p.id,
    });
  }

  // התנגשות שיכולה להיווצר משיבוץ ידני או מנתונים ישנים:
  // אותה נקודת קצה, אותה מדיה, אותו יום
  const clashes = await rows(
    `select e.name as endpoint_name, c.name as channel_name,
            p.scheduled_at::date as on_date,
            count(*)::int as n,
            string_agg(distinct p.kind, ',') as kinds
       from posts p
       join endpoints e on e.id = p.endpoint_id
       join channels c  on c.id = p.channel_id
      where p.status in ('scheduled','approved','publishing','failed','pending_approval')
        and p.scheduled_at >= now() - interval '1 day'
      group by e.name, c.name, p.scheduled_at::date
     having count(*) > 1`
  );

  for (const x of clashes) {
    const mixed = x.kinds.includes('promo') && x.kinds.includes('value');
    alerts.push({
      id: `clash-${x.endpoint_name}-${x.channel_name}-${x.on_date}`,
      level: mixed ? 'crit' : 'warn',
      title: `${x.n} פוסטים לאותה נקודה באותו יום — ${x.endpoint_name}`,
      detail: `${x.channel_name} · ${new Date(x.on_date).toLocaleDateString('he-IL')}` +
              (mixed ? ' · גם מכירתי וגם ערך באותו יום' : ''),
      tab: 'board',
    });
  }

  for (const p of soonWithoutContent) {
    alerts.push({
      id: `no-text-${p.id}`,
      level: 'crit',
      title: `חסר תוכן לפוסט שמתפרסם בקרוב`,
      detail: `${p.title} · ${p.channel_name} · ` +
              `${new Date(p.scheduled_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}`,
      tab: 'board',
      post_id: p.id,
    });
  }

  // פוסט שיושב על יום שהערוץ חסם. חסימת יום מפנה אוטומטית את מי שאפשר
  // (relocateBlocked), אבל פוסט שלא נמצא לו יום חוקי נשאר במקום — וזה חייב
  // להיראות, אחרת הוא יוצא לאוויר ביום שהוגדר סגור.
  for (const p of await postsOnBlockedDays()) {
    const d = new Date(p.scheduled_at);
    alerts.push({
      id: `blocked-day-${p.id}`,
      level: 'crit',
      title: `פוסט על יום חסום — ${p.channel_name}`,
      detail: `${p.title} · ${HE_DAYS[d.getDay()]} ${d.toLocaleDateString('he-IL')} · ` +
              'צריך להזיז אותו ידנית או לפתוח את היום',
      tab: 'board',
      post_id: p.id,
    });
  }

  // ה-volume של המסד מוגבל. עדיף להתריע לפני שנגמר המקום מאשר לגלות את זה
  // כשהעלאה נכשלת. גלוי רק למי שיש הרשאת הגדרות, וההסבר אומר מה תופס מקום.
  const size = await one(
    `select pg_database_size(current_database()) as bytes,
            (select coalesce(sum(size_bytes),0) from content_assets
              where data is not null)::bigint as assets,
            pg_total_relation_size('backups') as backups,
            pg_total_relation_size('activity_log') as log`
  );
  // גיבוי ונפח המסד — של המערכת כולה, לא של ארגון; רק לארגון הפלטפורמה
  const platformSignals = systemAlertsAllowed(user, currentOrg());
  const storage = platformSignals && storageAlert({
    usedBytes: Number(size.bytes), assetsBytes: Number(size.assets),
    backupsBytes: Number(size.backups), logBytes: Number(size.log),
    limitMb: storageLimitMb(), mediaInR2: mediaReady(),
  });
  if (storage) alerts.push(storage);

  if (platformSignals) alerts.push(...backupAlerts(backupLayers));

  const order = { crit: 0, warn: 1, info: 2 };
  // סימן אחד לכל פוסט: משימה פתוחה היא ה-to-do, ההתראה המקבילה מתייתרת
  const shown = alertsForUser(suppressTaskedAlerts(alerts, openTasks), user);
  shown.sort((a, b) => order[a.level] - order[b.level]);

  return {
    alerts: shown,
    counts: {
      total: shown.length,
      crit: shown.filter((a) => a.level === 'crit').length,
      warn: shown.filter((a) => a.level === 'warn').length,
      info: shown.filter((a) => a.level === 'info').length,
    },
  };
}

/**
 * התראות כלל-מערכתיות (גיבוי, נפח המסד) — רק בארגון הפלטפורמה (PLATFORM_ORG_ID).
 * הארגון: של המשתמש, ואם אין (העוזר) — הארגון הפעיל בהקשר. ההרשאה (settings)
 * נבדקת בנפרד ב-alertsForUser.
 */
export function systemAlertsAllowed(user, ctxOrg = null, env = process.env) {
  return isPlatformOrg(user?.org_id ?? ctxOrg, env);
}

/** האם המשתמש רשאי לראות התראה (perm = ההרשאה שנדרשת כדי לפעול עליה) */
export function alertsForUser(alerts, user) {
  if (!user) return alerts;
  return alerts.filter((a) => !a.perm || user.is_owner || user[`perm_${a.perm}`]);
}

/** תקרת נפח המסד ב-MB — STORAGE_ALERT_MB, ברירת מחדל 500 (ה-volume ב-Railway) */
export function storageLimitMb(env = process.env) {
  const n = Number(env.STORAGE_ALERT_MB);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

const mb = (bytes) => Math.round(bytes / 1048576);

/**
 * התראת אחסון (טהורה): מעל 70% מהתקרה — דורש טיפול, מעל 90% — חוסם.
 * ההסבר אומר מה תופס מקום עכשיו ושהפינוי אצל המפתח — אין כאן כפתור
 * שהמשתמש יכול ללחוץ עליו, ולכן גם אין "פתח".
 */
export function storageAlert({ usedBytes, assetsBytes = 0, backupsBytes = 0, logBytes = 0,
                               limitMb = 500, mediaInR2 = false }) {
  const used = usedBytes / 1048576;
  if (used <= limitMb * 0.7) return null;
  const parts = [
    ['גיבויים פנימיים', backupsBytes], ['קבצים שעוד שמורים במסד', assetsBytes], ['יומן פעולות', logBytes],
  ].filter(([, b]) => mb(b) > 0).map(([label, b]) => `${label} ${mb(b)}MB`);
  return {
    id: 'storage',
    level: used > limitMb * 0.9 ? 'crit' : 'warn',
    perm: 'settings',
    title: 'המסד מתמלא',
    detail: [
      `${Math.round(used)}MB מתוך ${limitMb}MB`,
      parts.length ? `הכי הרבה: ${parts.join(', ')}` : null,
      mediaInR2
        ? 'תמונות וסרטונים חדשים כבר נשמרים באחסון המדיה (R2) ולא תופסים כאן מקום'
        : 'אחסון המדיה (R2) לא מוגדר, ולכן כל קובץ שעולה נשמר במסד',
      'הפינוי או הגדלת הנפח — אצל המפתח; מעבירים לו את ההודעה הזו',
    ].filter(Boolean).join(' · '),
    tab: null,
  };
}

/**
 * התראת התוכן של קמפיין. בקמפיין שסומן "מוכן" אין משבצות ריקות — מה
 * שנשאר לא מוכן הוא טיוטות, וזה מה שההתראה אומרת (לא "חסר תוכן").
 */
export function campaignContentAlert(c, daysToStart) {
  const running = c.phase === 'running';
  const n = c.missing_content;
  if (c.complete) {
    const drafts = n === 1 ? 'פוסט אחד עדיין בטיוטה' : `${n} פוסטים עדיין בטיוטה`;
    return {
      id: `campaign-content-${c.id}`,
      level: running ? 'crit' : 'warn',
      title: `טיוטות לסיום: ${c.name}`,
      detail: (running ? 'הקמפיין רץ' : `מתחיל בעוד ${daysToStart} ימים`) +
              ` ו-${drafts} (מתוך ${c.required}) — הם ייצאו רק אחרי שיסומנו מוכנים`,
      tab: 'plan',
      campaign_id: c.id,
    };
  }
  return {
    id: `campaign-content-${c.id}`,
    level: running ? 'crit' : 'warn',
    title: `חסר תוכן: ${c.name}`,
    detail: running
      ? `הקמפיין רץ וחסרים לו ${n} פוסטים מתוך ${c.required}`
      : `מתחיל בעוד ${daysToStart} ימים וחסרים לו ${n} מתוך ${c.required}`,
    tab: 'plan',
    campaign_id: c.id,
  };
}

const shortWhen = (d) =>
  new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

/** התראה חוסמת לכל פוסט שהפרסום שלו נכשל. id יציב לפי הפוסט. */
export function failedPostAlerts(list) {
  return list.map((p) => ({
    id: `post-failed-${p.id}`,
    level: 'crit',
    title: `פרסום נכשל: ${p.title}`,
    detail: [p.channel_name, shortWhen(p.scheduled_at), p.publish_error].filter(Boolean).join(' · '),
    tab: 'board',
    post_id: p.id,
  }));
}

/** התראה לכל פוסט שהמועד שלו עבר והוא לא פורסם ולא סומן "פורסם" */
export function missedPostAlerts(list) {
  return list.map((p) => ({
    id: `post-missed-${p.id}`,
    level: 'warn',
    title: `עבר המועד ולא פורסם: ${p.title}`,
    detail: [p.channel_name, shortWhen(p.scheduled_at),
             'מפרסמים ומסמנים "פורסם", או משבצים מחדש'].filter(Boolean).join(' · '),
    tab: 'board',
    post_id: p.id,
  }));
}

/**
 * האם נקודת קצה עברה את הקצב שלה בלי פרסום. null = בסדר.
 * נקודה שעוד לא פורסם ממנה כלום נמדדת מיום שנוספה — אחרת נקודה חדשה
 * מקבלת "לא מפרסמת" חוסם בדקה הראשונה, לפני שהיה לה בכלל סיכוי.
 */
export function endpointAirStatus(e, now = new Date()) {
  const cadence = effectiveCadenceDays(e);
  const daysSince = e.last_at ? Math.floor((now - new Date(e.last_at)) / DAY) : null;
  const daysRef = daysSince ?? (e.created_at ? Math.floor((now - new Date(e.created_at)) / DAY) : 999);
  if (daysRef <= cadence) return null;
  return { days_since: daysSince, days_over: daysRef };
}

/** נקודות קצה שעברו את הקצב שהוגדר להן בלי פרסום */
async function endpointsWithoutAir() {
  const list = await rows(
    `select e.id, e.name, e.importance, e.created_at,
            max(p.published_at) as last_at
       from endpoints e
       left join posts p on p.endpoint_id = e.id and p.status = 'published'
      where e.active = true
      group by e.id, e.name, e.importance, e.created_at`
  );
  const now = new Date();
  return list
    .map((e) => ({ ...e, status: endpointAirStatus(e, now) }))
    .filter((e) => e.status)
    .map(({ status, ...e }) => ({ ...e, ...status }));
}
