import { currentOrg, one, rows } from './db.js';
import { isPlatformOrg } from './platform.js';
import { effectiveCadenceDays, postContentStates, ymd } from './board.js';
import { campaignsWithHealth } from './campaigns.js';
import { postsOnBlockedDays } from './respace.js';
import { COVERING_TASK_KINDS, suppressTaskedAlerts } from './task-lifecycle.js';
import { backupAlerts, readBackupLayers } from './backup-status.js';
import { mediaReady } from './media.js';
import { UNCONFIRMED_SQL, unconfirmedAlert, unconfirmedPosts } from './unconfirmed.js';
import { tickHeartbeat, tickStallAlert } from './publish/heartbeat.js';

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
// פוסט שהמנוע פתח כחסר תוכן (auto_hole): מתריעים שבוע לפני, ועד יומיים אחרי המועד
const HOLE_AHEAD_DAYS = 7;
const HOLE_PAST_DAYS = 2;

export async function buildAlerts(user = null) {
  const settings = await one('select * from engine_settings limit 1');
  const alertHours = settings?.content_alert_hours ?? 48;

  const campaigns = await campaignsWithHealth();
  const endpoints = await endpointsWithoutAir();
  // פוסטים בלי תוכן: כל מה שיוצא בתוך content_alert_hours, ופוסטים שהמנוע
  // פתח כחסרי תוכן (auto_hole, status='scheduled' — לא 'hole') בשבוע הקרוב
  // או שהמועד שלהם עבר ביומיים האחרונים (missingContentAlerts).
  // מבצע דחוף (urgent) — כותרת בלבד בכוונה (/urgent/commit), לא "חסר תוכן".
  // תוכן משויך בלי טקסט ובלי מדיה (טיוטה עם כותרת בלבד) — גם "חסר תוכן"
  // (סעיף 20). ההחלטה — isEmptyContent (readiness.js), אותה הגדרה כמו הלוח
  // והפרסום; בשאילתה רק החלון (48 שעות / שבוע לממלאי מקום), לא כלל משלה.
  const noContentCandidates = await rows(
    `select p.id, p.title, p.scheduled_at, p.auto_hole, p.content_id, p.channel_id,
            e.name as endpoint_name, c.name as channel_name, c.platform,
            v.status as variant_status, v.body as variant_body, v.meta as variant_meta
       from posts p
       left join endpoints e on e.id = p.endpoint_id
       left join channels c  on c.id = p.channel_id
       left join content_variants v on v.content_id = p.content_id and v.channel_id = p.channel_id
      where p.status = 'scheduled' and p.published_at is null
        and not p.urgent
        -- תוכן ריק שהמועד שלו עבר נספר ב"לא סומנו כפורסמו" (UNCONFIRMED_SQL) — סימן אחד
        and (p.content_id is null or p.scheduled_at >= now())
        -- פוסט של קמפיין מושהה לא על הלוח — אין מה לכתוב לו עכשיו
        and not exists (select 1 from content_items ci join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
        and (p.scheduled_at between now() and now() + ($1 || ' hours')::interval
             or (p.auto_hole and p.scheduled_at between now() - interval '${HOLE_PAST_DAYS} days'
                                                    and now() + interval '${HOLE_AHEAD_DAYS} days'))
      order by p.scheduled_at`,
    [alertHours]
  );
  const contentStates = await postContentStates(noContentCandidates);
  const withoutContent = noContentCandidates.filter((p) =>
    !p.content_id || contentStates.get(p.id)?.empty);
  const pending = await rows(`select p.id, p.title, p.scheduled_at, c.name as channel_name
          from posts p left join channels c on c.id = p.channel_id
         where p.status = 'pending_approval' order by p.scheduled_at`);
  // פרסום שנכשל — עד שבועיים אחורה. אחר כך זה כבר היסטוריה, לא מצב.
  const failed = await rows(`select p.id, p.title, p.scheduled_at, p.publish_error, c.name as channel_name
          from posts p left join channels c on c.id = p.channel_id
         where p.status = 'failed' and p.scheduled_at >= now() - interval '14 days'
           and not exists (select 1 from content_items ci
                             join campaigns ca on ca.id = ci.campaign_id
                            where ci.id = p.content_id and ca.paused_at is not null)
         order by p.scheduled_at`);
  // המועד עבר ואף אחד לא סימן שפורסם — "לא אושר שיצא" (unconfirmed.js).
  // התראה מרוכזת אחת במקום התראה לכל פוסט, ובלי חיתוך של שבוע.
  const unconfirmed = await unconfirmedPosts();
  // משימות פתוחות (שלא נדחו) שכבר מכסות התראה על אותו פוסט — suppressTaskedAlerts
  const openTasks = await rows(`select post_id, kind from tasks
         where not done and post_id is not null and kind = any($1::text[])
           and (snoozed_until is null or snoozed_until <= now())`, [COVERING_TASK_KINDS]);
  const backupLayers = await readBackupLayers();

  const alerts = [];
  const today = ymd(new Date());

  alerts.push(...campaignAlerts(campaigns, today));

  // חסר תוכן — התראה אחת לפוסט. ממלא מקום של המנוע (auto_hole) שהמועד שלו
  // עבר מקבל אותה, ולא נכנס ל"לא אושר שיצא" (UNCONFIRMED_SQL) — סימן אחד
  const noText = missingContentAlerts(withoutContent, { alertHours });
  alerts.push(...failedPostAlerts(failed), ...unconfirmedAlert(unconfirmed));

  for (const e of endpoints) {
    const cadence = effectiveCadenceDays(e);
    alerts.push({
      id: `endpoint-air-${e.id}`,
      level: e.level,
      title: `${e.name} לא מפרסמת`,
      detail: e.days_since === null
        ? `עוד לא פורסם ממנה כלום — נוספה לפני ${e.days_over} ימים, התדירות לפי החשיבות היא כל ${cadence} ימים`
        : `${e.days_since} ימים בלי פרסום — התדירות לפי החשיבות היא כל ${cadence} ימים`,
      tab: 'plan',
      endpoint_id: e.id,
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

  alerts.push(...noText);

  // פוסט שיושב על יום שהערוץ חסם. חסימת יום מפנה אוטומטית את מי שאפשר
  // (relocateBlocked), אבל פוסט שלא נמצא לו יום חוקי נשאר במקום — וזה חייב
  // להיראות, אחרת הוא יוצא לאוויר ביום שהוגדר סגור.
  // פוסט מאושר מתפרסם לבד במועד שלו — ולכן הכותרת אומרת את זה במפורש.
  for (const p of await postsOnBlockedDays()) {
    const d = new Date(p.scheduled_at);
    alerts.push({
      id: `blocked-day-${p.id}`,
      level: 'crit',
      title: p.status === 'approved'
        ? 'פוסט מאושר ביום שנחסם — יתפרסם ביום הזה אם לא יוזז'
        : `פוסט על יום חסום — ${p.channel_name}`,
      detail: `${p.status === 'approved' ? `${p.channel_name} · ` : ''}` +
              `${p.title} · ${HE_DAYS[d.getDay()]} ${d.toLocaleDateString('he-IL')} · ` +
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

  // טיק הפרסום לא הסתיים 10 דקות (publish/heartbeat.js) — הטיק אחד לכל
  // הארגונים, וכל ארגון מושפע; כמו "פרסום נכשל" — לכל משתמש, בלי הרשאה
  const stalled = tickStallAlert(tickHeartbeat());
  if (stalled) alerts.push(stalled);

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

/** כמה ימים אחרי הסוף קמפיין שהסתיים עוד מתריע על תוכן מוכן שלא יצא */
const ENDED_WINDOW_DAYS = 14;

const heDate = (d) => new Date(d).toLocaleDateString('he-IL');

/**
 * ההתראות של הקמפיינים (שורות campaignsWithHealth). טהורה.
 *
 *   חסר תוכן      — רץ, או מתחיל בתוך שבוע. החסר נספר מהיום והלאה
 *                    (missing_ahead): שורה שהתאריך שלה עבר כבר לא תשובץ, ואין
 *                    טעם לבקש לכתוב לה. קמפיין מוכן — הטיוטות (כולן עוד יכולות
 *                    לצאת עד הסוף).
 *   מפגר אחרי הקצב — רץ, ויצא (כולל מתוכנן להיום ולא אושר שיצא) פחות ממה
 *                    שהקיבולת שלו מצפה עד היום — בפער של 2+ ו-20%+ (paceOf).
 *   תוכן שלא ייכנס — רץ או מתוכנן, ויש תוכן בלי פוסט שאין לו מקום עד הסוף
 *                    (unplaced). warn — בלי החלטה הוא פשוט לא יצא.
 *   הסתיים         — עד שבועיים אחרי הסוף, כשנשארו גרסאות מוכנות שלא פורסמו
 *                    (unpublished_ready). info — לידיעה, נעלם לבד.
 * מושהה / לא פעיל — בלי רעש: ההשהיה היא החלטה, לא בעיה.
 */
export function campaignAlerts(campaigns, today) {
  const alerts = [];
  for (const c of campaigns) {
    if (c.phase === 'ended') {
      const n = c.unpublished_ready ?? 0;
      const since = c.ends_on ? Math.round((new Date(today) - new Date(c.ends_on)) / DAY) : null;
      if (n > 0 && since !== null && since <= ENDED_WINDOW_DAYS) {
        alerts.push({
          id: `campaign-leftover-${c.id}`,
          level: 'info',
          title: n === 1
            ? `פוסט מוכן אחד של ${c.name} לא פורסם`
            : `${n} פוסטים מוכנים של ${c.name} לא פורסמו`,
          detail: `הקמפיין הסתיים ב-${heDate(c.ends_on)} — אפשר להאריך אותו, ` +
                  'להעביר את התוכן לקמפיין אחר או להשאיר',
          tab: 'plan',
          campaign_id: c.id,
        });
      }
      continue;
    }
    if (['inactive', 'paused'].includes(c.phase)) continue;

    const daysToStart = c.starts_on
      ? Math.round((new Date(c.starts_on) - new Date(today)) / DAY) : null;

    // קמפיין מוכן: כל הטיוטות; אחרת — מה שחסר מהיום והלאה
    const missing = c.complete ? c.missing_content : (c.missing_ahead ?? c.missing_content);
    if (missing > 0) {
      const starting = c.phase === 'upcoming' && daysToStart !== null &&
                       daysToStart <= UPCOMING_WINDOW_DAYS;
      if (c.phase === 'running' || starting) {
        alerts.push(campaignContentAlert(c, daysToStart));
      }
    }

    // רק פיגור של ממש (paceOf.lagging — 2+ ולפחות 20%), ו"יצאו" כולל מה
    // שמתוכנן עד היום ומה שלא אושר שיצא (paceDone) — סעיפים 2, 29
    if (c.phase === 'running' && c.pace?.lagging) {
      alerts.push({
        id: `campaign-pace-${c.id}`,
        level: 'warn',
        title: `מפגר אחרי הקצב: ${c.name}`,
        detail: `לפי המקום שיש לקמפיין בערוצים היו אמורים לצאת עד היום ${c.pace.expected_by_now} ` +
                `פוסטים, יצאו או מתוכננים להיום ${c.pace.done ?? c.pace.published}`,
        tab: 'plan',
        campaign_id: c.id,
      });
    }

    if (['running', 'upcoming'].includes(c.phase) && c.unplaced > 0) {
      alerts.push({
        id: `campaign-unplaced-${c.id}`,
        level: 'warn',
        title: `תוכן שלא ייכנס: ${c.name}`,
        detail: `${c.unplaced === 1 ? 'פוסט אחד לא ייכנס' : `${c.unplaced} פוסטים לא ייכנסו`} ` +
                `עד סוף הקמפיין (${heDate(c.ends_on)}) — אפשר להאריך, לדחוס את המרווח או להסיר`,
        tab: 'plan',
        campaign_id: c.id,
      });
    }
  }
  return alerts;
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
  // לא מוכן: מה שחסר מהיום והלאה, מתוך מה שנשאר (שורות שעברו לא נספרות)
  const ahead = c.missing_ahead ?? n;
  const total = c.total_ahead ?? c.required;
  return {
    id: `campaign-content-${c.id}`,
    level: running ? 'crit' : 'warn',
    title: `חסר תוכן: ${c.name}`,
    detail: running
      ? `הקמפיין רץ וחסרים לו ${ahead} פוסטים מתוך ${total} שנשארו עד הסוף`
      : `מתחיל בעוד ${daysToStart} ימים וחסרים לו ${ahead} מתוך ${total}`,
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

/**
 * "חסר תוכן" — התראה אחת לכל פוסט מתוכנן בלי תוכן (שורות מהשאילתה ב-
 * buildAlerts). טהורה.
 *
 * קודם היו כאן שתי התראות: "חסר תוכן על הלוח" חיפשה status='hole' — מצב
 * שהמנוע כבר לא כותב (הוא פותח 'scheduled' + auto_hole) — ולכן מעולם לא
 * עלתה, ו"חסר תוכן לפוסט שמתפרסם בקרוב" (content_alert_hours). עכשיו אחת,
 * עם id אחד (no-text-<post>), כך שמשימת "לכתוב" פתוחה על הפוסט מכסה אותה
 * (suppressTaskedAlerts — סימן אחד לכל פוסט):
 *   המועד עבר (עד יומיים)    — crit (ממלא מקום של המנוע לא נכנס ל"לא אושר שיצא")
 *   בתוך content_alert_hours — crit
 *   אחרת (auto_hole, עד שבוע) — warn
 */
export function missingContentAlerts(list, { alertHours = 48, now = new Date() } = {}) {
  const soonUntil = now.getTime() + alertHours * 3600000;
  return list.map((p) => {
    const at = new Date(p.scheduled_at).getTime();
    // תוכן משויך בלי טקסט ובלי מדיה (סעיף 20) — אומרים שיש רק כותרת
    const where = [p.channel_name, shortWhen(p.scheduled_at),
                   p.content_id ? 'יש רק כותרת' : null].filter(Boolean);
    if (at <= now.getTime()) {
      return {
        id: `no-text-${p.id}`,
        level: 'crit',
        title: `חסר תוכן והמועד עבר — ${p.endpoint_name ?? p.title}`,
        detail: [...where, 'כותבים תוכן ומשבצים מחדש, או מוחקים את הפוסט'].join(' · '),
        tab: 'board',
        post_id: p.id,
      };
    }
    if (at <= soonUntil) {
      return {
        id: `no-text-${p.id}`,
        level: 'crit',
        title: 'חסר תוכן לפוסט שמתפרסם בקרוב',
        detail: [p.title, ...where].join(' · '),
        tab: 'board',
        post_id: p.id,
      };
    }
    return {
      id: `no-text-${p.id}`,
      level: 'warn',
      title: `חסר תוכן על הלוח — ${p.endpoint_name ?? 'לא משויך'}`,
      detail: where.join(' · '),
      tab: 'board',
      post_id: p.id,
    };
  });
}

/**
 * האם נקודת קצה עברה את הקצב שלה בלי פרסום. null = בסדר.
 * נקודה שעוד לא פורסם ממנה כלום נמדדת מיום שנוספה — אחרת נקודה חדשה
 * מקבלת "לא מפרסמת" חוסם בדקה הראשונה, לפני שהיה לה בכלל סיכוי.
 * הכיול (סעיף 29): מעל הקצב — warn; פי שניים ממנו — crit; ואין התראה בכלל
 * כשפוסט חי שלה מתוכנן בתוך הקצב הקרוב (next_at) — היא כבר בדרך.
 */
export function endpointAirStatus(e, now = new Date()) {
  const cadence = effectiveCadenceDays(e);
  const daysSince = e.last_at ? Math.floor((now - new Date(e.last_at)) / DAY) : null;
  const daysRef = daysSince ?? (e.created_at ? Math.floor((now - new Date(e.created_at)) / DAY) : 999);
  if (daysRef <= cadence) return null;
  if (e.next_at && (new Date(e.next_at) - now) / DAY <= cadence) return null;
  return { days_since: daysSince, days_over: daysRef, level: daysRef >= 2 * cadence ? 'crit' : 'warn' };
}

/**
 * נקודות קצה שעברו את הקצב שהוגדר להן בלי פרסום. "הפרסום האחרון" כולל גם
 * פוסט שלא אושר שיצא (UNCONFIRMED_SQL, לפי המועד שלו): לא ידוע ≠ לא יצא
 * (החלטה ה1 — הוא לא מסומן אוטומטית, אבל גם לא מפיל את הנקודה ל"לא מפרסמת").
 */
async function endpointsWithoutAir() {
  // next_at — הפוסט החי הבא שלה (ערוץ פעיל, קמפיין לא מושהה): בתוך הקצב = בדרך
  const list = await rows(
    `select e.id, e.name, e.importance, e.created_at,
            max(case when p.status = 'published' then p.published_at
                     else p.scheduled_at end) as last_at,
            (select min(n.scheduled_at) from posts n
               join channels nc on nc.id = n.channel_id and nc.active
              where n.endpoint_id = e.id
                and n.status in ('scheduled', 'approved', 'pending_approval', 'publishing')
                and n.scheduled_at >= now()
                and not (n.auto_hole and n.content_id is null)
                and not exists (select 1 from content_items nci
                                  join campaigns nca on nca.id = nci.campaign_id
                                 where nci.id = n.content_id and nca.paused_at is not null)
            ) as next_at
       from endpoints e
       left join posts p on p.endpoint_id = e.id
                        and (p.status = 'published' or ${UNCONFIRMED_SQL})
      where e.active = true
      group by e.id, e.name, e.importance, e.created_at`
  );
  const now = new Date();
  return list
    .map((e) => ({ ...e, status: endpointAirStatus(e, now) }))
    .filter((e) => e.status)
    .map(({ status, ...e }) => ({ ...e, ...status }));
}
