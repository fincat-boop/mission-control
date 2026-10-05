import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { weekMeta } from '../board.js';
import { requirePerm } from '../auth.js';
import { closeResolvedTasksSafely } from '../task-lifecycle.js';

const r = Router();

/* ========================= משימות ========================= */

export const LOCAL_TZ = 'Asia/Jerusalem';

/**
 * YYYY-MM-DD של הרגע הנתון בשעון ישראל — בלי תלות ב-TZ של התהליך. due_on
 * של משימות נכתב בתאריך המקומי, ולכן גם "היום" שמולו משווים חייב להיות מקומי.
 */
export function localYmd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** האם משימה פתוחה נדחתה ("דחה עד מחר") ועוד לא הגיע הזמן שלה */
export const isSnoozed = (t, now = new Date()) =>
  !t.done && t.snoozed_until != null && new Date(t.snoozed_until) > now;

/**
 * חלוקת המשימות לקבוצות של הטאב. due_on מגיע כמחרוזת 'YYYY-MM-DD'.
 * משימה שנדחתה לא נכנסת להיום/דורש טיפול ולא למונה — רק לקבוצת "נדחו".
 */
export function groupTasks(all, { today, weekStart, now = new Date() }) {
  const open = all.filter((t) => !t.done && !isSnoozed(t, now));
  return {
    today: open.filter((t) => t.due_on === today),
    attention: open.filter((t) => t.due_on !== today),
    snoozed: all.filter((t) => isSnoozed(t, now)),
    done_this_week: all.filter(
      (t) => t.done && t.done_at && localYmd(new Date(t.done_at)) >= weekStart
    ),
    open_count: open.length,
  };
}

/** תנאי SQL למשימה פתוחה שלא נדחתה — אותו כלל כמו isSnoozed */
const OPEN_SQL = 'not done and (snoozed_until is null or snoozed_until <= now())';

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
  const c = await one(
    `select count(*) filter (where ${OPEN_SQL})::int as open_count,
            count(*) filter (where ${OPEN_SQL} and urgent)::int as urgent_count
       from tasks`
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
