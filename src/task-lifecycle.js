import { query, rows } from './db.js';

/**
 * מחזור החיים של משימה: משימה היא משהו שאדם צריך לעשות, ולכן היא נסגרת
 * לבד ברגע שהתנאי שלה נפתר — לא מחכה שמישהו יזכור לסמן אותה. ההחלטה
 * טהורה (taskCloseReason) ונבדקת בטסטים; closeResolvedTasks רק מיישם.
 *
 * רץ פעם בשעה מהתחזוקה (לכל ארגון) וגם בתחילת GET /tasks ו-/tasks/count,
 * כך שהרשימה לא מציגה משימה שכבר לא רלוונטית.
 */

const DAY_MS = 86400000;
const EXPIRE_MS = DAY_MS; // משימת כתיבה/וואטסאפ שהמועד שלה עבר ביותר מזה — כבר לא רלוונטית

/** סוגי המשימות שהמערכת יכולה לסגור בעצמה ("general" — ידנית, רק אדם סוגר) */
export const AUTO_CLOSE_KINDS = ['write', 'swap', 'publish', 'failed', 'approve'];

/** סוגים שמקבלים אוטומטית את האחראי של הפוסט כשאין להם אחראי */
const AUTO_ASSIGN_KINDS = ['write', 'swap', 'publish'];

/**
 * למה המשימה הזו כבר לא נחוצה, או null אם היא עדיין בתוקף.
 * t: שורת משימה פתוחה + פרטי הפוסט שלה (post_status null = הפוסט נמחק).
 *   write / swap   — לפוסט יש תוכן עם גרסה מוכנה לערוץ שלו (post_ready), הוא
 *                    אושר או פורסם, או שהמועד עבר ביותר מיממה. תוכן בלי
 *                    גרסה מוכנה לערוץ הזה — עוד יש מה לכתוב
 *   publish (wa)   — הפוסט פורסם, או שהמועד עבר ביותר מיממה (התראת "עבר
 *                    המועד" ממשיכה להציג אותו שבוע)
 *   failed         — הפוסט פורסם, או אושר שוב למועד עתידי
 *   approve        — הפוסט כבר לא ממתין לאישור
 */
export function taskCloseReason(t, now = new Date()) {
  if (t.done || t.post_id == null) return null;
  if (!AUTO_CLOSE_KINDS.includes(t.kind)) return null;
  if (t.post_status == null) return 'post_deleted';

  const at = t.post_scheduled_at ? new Date(t.post_scheduled_at).getTime() : null;
  const expired = at != null && now.getTime() - at > EXPIRE_MS;
  const future = at != null && at > now.getTime();
  const published = t.post_status === 'published';

  switch (t.kind) {
    case 'write':
    case 'swap':
      if (published) return 'published';
      if (t.post_status === 'approved') return 'approved';
      if (t.post_content_id != null && t.post_ready) return 'has_content';
      return expired ? 'expired' : null;
    case 'publish':
      if (!t.meta?.wa_send) return null; // משימת פרסום ידנית ישנה — נשארת לאדם
      if (published) return 'published';
      return expired ? 'expired' : null;
    case 'failed':
      if (published) return 'published';
      return t.post_status === 'approved' && future ? 'reapproved' : null;
    case 'approve':
      return t.post_status !== 'pending_approval' ? 'resolved' : null;
    default:
      return null;
  }
}

/**
 * האחראי שמשימה של פוסט מקבלת אוטומטית: האחראי של הפוסט, אם יש, ורק פעם
 * אחת (meta.assignee_auto) — מי שהוריד את השיוך ביד לא יקבל אותו שוב.
 */
export function autoAssignee(t) {
  if (t.done || t.assignee_id != null || t.post_assignee_id == null) return null;
  if (!AUTO_ASSIGN_KINDS.includes(t.kind) || t.meta?.assignee_auto) return null;
  return t.post_assignee_id;
}

/**
 * הסגירה מתוך בקשת GET (טאב המשימות, המונה): בתוך savepoint ועם
 * lock_timeout קצר — כשל או המתנה לנעילה לא מפילים את הבקשה, רק
 * נרשמים ללוג, והרשימה מוגשת כמו שהיא. לא זורק לעולם.
 */
export async function closeResolvedTasksSafely() {
  await query('savepoint task_sweep');
  try {
    const { prev } = (await query("select current_setting('lock_timeout') as prev")).rows[0];
    await query("select set_config('lock_timeout', '2s', true)");
    const out = await closeResolvedTasks();
    await query("select set_config('lock_timeout', $1, true)", [prev]);
    await query('release savepoint task_sweep');
    return out;
  } catch (e) {
    // rollback ל-savepoint מחזיר גם את lock_timeout לקודם
    await query('rollback to savepoint task_sweep');
    console.error('סגירת משימות שנפתרו (בתוך בקשה) נכשלה:', e.message);
    return null;
  }
}

/**
 * סוגר משימות שהתנאי שלהן נפתר (done + meta.auto_closed = הסיבה), ומשייך
 * משימות פוסט לאחראי של הפוסט. מחזיר כמה נסגרו וכמה שויכו.
 */
export async function closeResolvedTasks(now = new Date()) {
  const open = await rows(
    `select t.id, t.kind, t.meta, t.post_id, t.assignee_id, t.done,
            p.status as post_status, p.content_id as post_content_id,
            p.scheduled_at as post_scheduled_at, p.assignee_id as post_assignee_id,
            exists (select 1 from content_variants v
                     where v.content_id = p.content_id and v.channel_id = p.channel_id
                       and v.status = 'ready') as post_ready
       from tasks t
       left join posts p on p.id = t.post_id
      where t.done = false and t.post_id is not null
        and t.kind = any($1::text[])
        -- שורה שבקשה אחרת מעדכנת כרגע (סימון בוצע, סגירה מקבילה) — מדלגים
        -- עליה; היא תיבדק בפעם הבאה. בלי זה GET /tasks היה ממתין לה.
        for update of t skip locked`,
    [AUTO_CLOSE_KINDS]
  );

  const close = [];
  const assign = [];
  for (const t of open) {
    const reason = taskCloseReason(t, now);
    if (reason) close.push({ id: t.id, reason });
    else {
      const who = autoAssignee(t);
      if (who != null) assign.push({ id: t.id, who });
    }
  }

  if (close.length) {
    await query(
      `update tasks t set done = true, done_at = now(),
              meta = coalesce(t.meta, '{}'::jsonb) || jsonb_build_object('auto_closed', x.reason)
         from unnest($1::int[], $2::text[]) as x(id, reason)
        where t.id = x.id and t.done = false`,
      [close.map((c) => c.id), close.map((c) => c.reason)]
    );
  }
  if (assign.length) {
    await query(
      `update tasks t set assignee_id = x.who,
              meta = coalesce(t.meta, '{}'::jsonb) || '{"assignee_auto": true}'::jsonb
         from unnest($1::int[], $2::int[]) as x(id, who)
        where t.id = x.id and t.assignee_id is null`,
      [assign.map((a) => a.id), assign.map((a) => a.who)]
    );
  }
  return { closed: close.length, assigned: assign.length };
}

/* ========================= סימן אחד לכל פוסט ========================= */

/** איזו התראה מתייתרת כשיש משימה פתוחה מאיזה סוג (המשימה היא ה-to-do) */
const ALERT_COVERED_BY = { approval: 'approve', 'no-text': 'write' };

/**
 * מסיר התראות שמשימה פתוחה כבר מכסה: "ממתין לאישור" כשיש משימת אישור,
 * "אין טקסט" כשיש משימת כתיבה לאותו פוסט. התראת כשל (crit) נשארת גם
 * כשיש משימת כשל — זה מצב חוסם, לא רק תזכורת.
 * openTasks: [{post_id, kind}] — משימות פתוחות שלא נדחו.
 */
export function suppressTaskedAlerts(alerts, openTasks) {
  const covered = new Set(openTasks.map((t) => `${t.kind}:${t.post_id}`));
  return alerts.filter((a) => {
    if (a.post_id == null) return true;
    const prefix = Object.keys(ALERT_COVERED_BY).find((p) => a.id === `${p}-${a.post_id}`);
    return !prefix || !covered.has(`${ALERT_COVERED_BY[prefix]}:${a.post_id}`);
  });
}
