import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { weekMeta } from '../board.js';
import { requirePerm } from '../auth.js';
import { LOCAL_TZ, closeResolvedTasksSafely, localYmd } from '../task-lifecycle.js';

const r = Router();

/* ========================= משימות ========================= */

// התאריך המקומי — מוגדר ב-task-lifecycle (גם הטיק והסגירה האוטומטית צריכים אותו)
export { LOCAL_TZ, localYmd };

/** האם משימה פתוחה נדחתה ("דחה עד מחר") ועוד לא הגיע הזמן שלה */
export const isSnoozed = (t, now = new Date()) =>
  !t.done && t.snoozed_until != null && new Date(t.snoozed_until) > now;

/**
 * היעד של משימה: due_on, ולמשימת מערכת בלי due_on (אישור) — היום של הפוסט
 * שלה (scheduled_at מה-join ב-GET /tasks). 'YYYY-MM-DD' או null.
 */
export function dueOf(t) {
  if (t.due_on) return t.due_on;
  if (t.kind !== 'general' && t.scheduled_at) return localYmd(new Date(t.scheduled_at));
  return null;
}

/**
 * דחופה? משימה ידנית ("general") — כמו שסומנה. משימת מערכת — רק כשהיעד
 * שלה היום או עבר (מחושב בקריאה, לא הדגל השמור: הצעת החלפה או משימת כתיבה
 * לשבוע הבא נוצרות "דחופות", והתגית איבדה משמעות).
 */
export function isUrgentTask(t, today) {
  if (t.kind === 'general') return !!t.urgent;
  const due = dueOf(t);
  return due != null && due <= today;
}

/** משימה שנסגרה לבד כי פג תוקפה — לא "הושלמה" (אף אחד לא עשה אותה) */
export const isExpiredTask = (t) => !!t.done && t.meta?.auto_closed === 'expired';

const byUrgencyThenDue = (a, b) =>
  (b.urgent - a.urgent) ||
  ((dueOf(a) ?? '9999') < (dueOf(b) ?? '9999') ? -1 : (dueOf(a) ?? '9999') > (dueOf(b) ?? '9999') ? 1 : 0) ||
  (a.id - b.id);

/**
 * חלוקת המשימות לקבוצות של הטאב. due_on מגיע כמחרוזת 'YYYY-MM-DD'.
 *   today     — היעד היום
 *   attention — "דורש טיפול": באיחור, או בלי יעד
 *   upcoming  — "בקרוב": היעד אחרי היום
 *   snoozed   — נדחו (לא בשום קבוצה אחרת ולא במונה)
 *   done_this_week / expired_this_week — מה שנסגר מתחילת השבוע; מה שפג
 *               תוקפו (נסגר לבד בלי שאיש עשה אותו) בנפרד
 * open_count — מה שדורש טיפול עכשיו: היום + דורש טיפול (בלי "בקרוב").
 * urgent של כל משימה מחושב מחדש (isUrgentTask).
 */
export function groupTasks(all, { today, weekStart, now = new Date() }) {
  const list = all.map((t) => ({ ...t, urgent: t.done ? !!t.urgent : isUrgentTask(t, today) }))
    .sort(byUrgencyThenDue);
  const open = list.filter((t) => !t.done && !isSnoozed(t, now));
  const closedThisWeek = list.filter((t) => t.done && t.done_at && localYmd(new Date(t.done_at)) >= weekStart);
  const todayList = open.filter((t) => dueOf(t) === today);
  const attention = open.filter((t) => dueOf(t) == null || dueOf(t) < today);
  return {
    today: todayList,
    attention,
    upcoming: open.filter((t) => dueOf(t) != null && dueOf(t) > today),
    snoozed: list.filter((t) => isSnoozed(t, now)),
    done_this_week: closedThisWeek.filter((t) => !isExpiredTask(t)),
    expired_this_week: closedThisWeek.filter(isExpiredTask),
    open_count: todayList.length + attention.length,
  };
}

/** תנאי SQL למשימה פתוחה שלא נדחתה — אותו כלל כמו isSnoozed */
const OPEN_SQL = 't.done = false and (t.snoozed_until is null or t.snoozed_until <= now())';
/** היעד ב-SQL — אותו כלל כמו dueOf (t = tasks, p = הפוסט שלה) */
const DUE_SQL = `coalesce(t.due_on, case when t.kind <> 'general'
                   then (p.scheduled_at at time zone '${LOCAL_TZ}')::date end)`;

/**
 * משימות פתוחות + מה שנסגר בשבועיים האחרונים (הטאב מציג רק "הושלם השבוע").
 * ?all=1 — הכול, כולל ההיסטוריה הישנה.
 */
r.get('/tasks', wrap(async (req, res) => {
  // קודם סוגרים את מה שכבר נפתר — שהרשימה לא תציג משימה שאין בה צורך.
  // כשל כאן לא מפיל את הטאב (ראו closeResolvedTasksSafely)
  await closeResolvedTasksSafely();
  const all = await rows(
    `select t.*, u.name as assignee_name, e.name as endpoint_name,
            p.title as post_title, p.scheduled_at, c.name as channel_name,
            -- הטקסט ל"העתק טקסט": הגרסה הנוכחית של התוכן לערוץ של הפוסט
            -- (בוואטסאפ — הנוסח לוואטסאפ, לא גוף התוכן הכללי), חי ולא מה
            -- שנשמר כשהמשימה נוצרה. אחריה מה שנשמר במשימה, ואז הכותרת.
            coalesce(nullif(btrim(v.body), ''), nullif(btrim(t.meta->>'body'), ''),
                     p.title, t.title) as copy_text
       from tasks t
       left join users u            on u.id = t.assignee_id
       left join endpoints e        on e.id = t.endpoint_id
       left join posts p            on p.id = t.post_id
       left join channels c         on c.id = p.channel_id
       left join content_variants v on v.content_id = p.content_id
                                   and v.channel_id = p.channel_id
      where $1 or t.done = false or t.done_at >= now() - interval '14 days'
      order by t.urgent desc, t.due_on nulls last, t.id`,
    [req.query.all === '1']
  );
  res.json(groupTasks(all, { today: localYmd(), weekStart: weekMeta(new Date()).start }));
}));

/** מונה זול לתגית בטאב ולרענון התקופתי — בלי לשלוף את כל המשימות */
r.get('/tasks/count', wrap(async (_req, res) => {
  await closeResolvedTasksSafely();
  // אותם כללים כמו groupTasks: "בקרוב" לא נספר, דחיפות של משימת מערכת לפי היעד
  const c = await one(
    `select count(*) filter (where ${OPEN_SQL}
                               and (${DUE_SQL} is null or ${DUE_SQL} <= $1::date))::int as open_count,
            count(*) filter (where ${OPEN_SQL}
                               and case when t.kind = 'general' then t.urgent
                                        else ${DUE_SQL} <= $1::date end)::int as urgent_count
       from tasks t left join posts p on p.id = t.post_id`,
    [localYmd()]
  );
  res.json(c);
}));

/**
 * בדיקות שדות שמשותפות ליצירה ולעדכון. מחזיר הודעת שגיאה או null.
 * האחראי חייב להיות משתמש של הארגון (RLS מסנן את users) — מפתח זר לבדו
 * לא בודק את זה, כי בדיקת FK עוקפת RLS.
 */
const INT4_MAX = 2147483647;
export const BULK_MAX = 200;

/** מזהה תקין לעמודת int: מספר שלם חיובי בטווח int4 (גם כמחרוזת ספרות) */
export const isDbId = (v) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 && n <= INT4_MAX;
};

/** 'YYYY-MM-DD' שהוא תאריך אמיתי — 2026-02-31 נדחה (Postgres היה זורק 500) */
export function isRealDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * רשימת מזהים לפעולה מרוכזת: מערך של 1–200 מזהים תקינים. מחזיר
 * { ids } או { error } בעברית — קלט שבור לא מגיע ל-SQL.
 */
export function parseBulkIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'לא נבחרו משימות' };
  if (ids.length > BULK_MAX) return { error: `אפשר לבחור עד ${BULK_MAX} משימות בבת אחת` };
  if (!ids.every(isDbId)) return { error: 'רשימת המשימות לא תקינה' };
  return { ids: [...new Set(ids.map(Number))] };
}

/** בדיקות שדות בלי DB (טהורה) — הודעת שגיאה או null */
export function invalidTaskShape(b) {
  if ('kind' in b && b.kind != null && b.kind !== 'general') {
    return 'אפשר ליצור ידנית רק משימה כללית — משימות אישור, כשל וכתיבה נוצרות מהמערכת';
  }
  if ('due_on' in b && b.due_on != null && !isRealDate(b.due_on)) return 'תאריך היעד לא תקין';
  if ('snoozed_until' in b && b.snoozed_until != null && Number.isNaN(Date.parse(b.snoozed_until))) {
    return 'זמן הדחייה לא תקין';
  }
  for (const [k, label] of [['assignee_id', 'המשתמש שנבחר'], ['post_id', 'הפוסט'], ['endpoint_id', 'נקודת הקצה']]) {
    if (k in b && b[k] != null && !isDbId(b[k])) return `${label} לא תקין`;
  }
  return null;
}

async function invalidTaskFields(b) {
  const shape = invalidTaskShape(b);
  if (shape) return shape;
  if ('assignee_id' in b && b.assignee_id != null &&
      !(await one('select 1 from users where id = $1', [Number(b.assignee_id)]))) {
    return 'המשתמש שנבחר לא נמצא';
  }
  return null;
}

/** משימה ידנית — תמיד "general". סוגי המערכת נוצרים רק מהמערכת עצמה. */
r.post('/tasks', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.title ?? '').trim()) return bad(res, 'צריך כותרת למשימה');
  const invalid = await invalidTaskFields(b);
  if (invalid) return bad(res, invalid);
  const t = await one(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, assignee_id, due_on, urgent)
     values ($1,$2,'general',$3,$4,$5,$6,coalesce($7,false)) returning *`,
    [String(b.title).trim(), b.subtitle ?? null, b.post_id ?? null, b.endpoint_id ?? null,
     b.assignee_id ?? null, b.due_on ?? null, b.urgent ?? false]
  );
  res.status(201).json({ task: t });
}));

/**
 * משימת אישור נסגרת רק בידי מי שמורשה לאשר: סגירה בלי אישור הפוסט
 * משאירה אותו ממתין, והמשימה שהייתה התזכורת היחידה נעלמת. גם שינוי
 * הסוג חסום — אחרת עוקפים דרך "general".
 */
export function approveTaskBlocked(task, body, user) {
  if (task.kind !== 'approve') return false;
  if (user.is_owner || user.perm_approve) return false;
  // גם דחייה מסתירה אותה מכולם — אותו כלל כמו סגירה
  return 'done' in body || 'kind' in body || 'snoozed_until' in body;
}

r.patch('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  if (!isDbId(req.params.id)) return bad(res, 'לא נמצאה משימה כזו', 404);
  const body = { ...req.body };
  const cur = await one('select kind from tasks where id = $1', [req.params.id]);
  if (!cur) return bad(res, 'לא נמצאה משימה כזו', 404);
  if (approveTaskBlocked(cur, body, req.user)) {
    return bad(res, 'משימת אישור נסגרת רק על ידי מי שמורשה לאשר — הפוסט עדיין ממתין לאישור', 403);
  }
  const invalid = await invalidTaskFields(body);
  if (invalid) return bad(res, invalid);
  // סימון "בוצע" מחתים גם את השעה
  if (body.done === true) body.done_at = new Date().toISOString();
  if (body.done === false) body.done_at = null;
  const t = await updateById('tasks',
    ['title', 'subtitle', 'kind', 'assignee_id', 'due_on', 'urgent', 'done', 'done_at',
     'snoozed_until'],
    req.params.id, body);
  if (!t) return bad(res, 'לא נמצאה משימה כזו', 404);
  res.json({ task: t });
}));

r.delete('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  if (!isDbId(req.params.id)) return bad(res, 'לא נמצאה משימה כזו', 404);
  // מחיקה היא סגירה בדרך אחרת — אותו כלל כמו ב-PATCH
  const cur = await one('select kind from tasks where id = $1', [req.params.id]);
  if (cur && approveTaskBlocked(cur, { done: true }, req.user)) {
    return bad(res, 'משימת אישור נמחקת רק על ידי מי שמורשה לאשר — הפוסט עדיין ממתין לאישור', 403);
  }
  await query('delete from tasks where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/**
 * פעולה על כמה משימות בבת אחת: done (סימון בוצע) או delete. אותו כלל
 * הרשאה כמו לכל משימה בנפרד — משימת אישור בלי הרשאת אישור מדולגת
 * ונספרת ב-skipped, לא מפילה את כל השאר.
 */
r.post('/tasks/bulk', requirePerm('content'), wrap(async (req, res) => {
  const { ids, action } = req.body ?? {};
  if (!['done', 'delete'].includes(action)) return bad(res, 'פעולה לא מוכרת');
  const parsed = parseBulkIds(ids);
  if (parsed.error) return bad(res, parsed.error);
  const list = parsed.ids;

  const found = await rows('select id, kind from tasks where id = any($1::int[])', [list]);
  const allowed = found.filter((t) => !approveTaskBlocked(t, { done: true }, req.user)).map((t) => t.id);
  if (allowed.length) {
    if (action === 'delete') {
      await query('delete from tasks where id = any($1::int[])', [allowed]);
    } else {
      await query(
        `update tasks set done = true, done_at = now()
          where id = any($1::int[]) and done = false`, [allowed]);
    }
  }
  res.json({ ok: true, affected: allowed.length, skipped: found.length - allowed.length });
}));

export default r;
