import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { bad, parseIdList, wrap } from './_shared.js';
import { applyWeek, planWeek, recordDismissals, withEngineLock } from '../engine.js';
import { planUrgent } from '../urgent.js';
import { one, query, rows } from '../db.js';

const r = Router();

/* ========================= מנוע השיבוץ ========================= */

/** תכנון בלבד — לא נכתב כלום */
r.post('/engine/plan', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planWeek(req.body?.week));
}));

/**
 * ביצוע התכנון. מריץ תכנון טרי כדי שלא ייכתב משהו על סמך מצב ישן.
 * selected (לא חובה) — מפתחות הפריטים שהמשתמש השאיר מסומנים בחלון;
 * נכתב רק מה שגם מסומן וגם עדיין בהצעה הטרייה. בלי selected — הכול.
 */
r.post('/engine/apply', requirePerm('content'), wrap(async (req, res) => {
  const raw = req.body?.selected;
  if (raw != null && !Array.isArray(raw)) return bad(res, 'selected חייב להיות רשימה');
  const selected = raw == null ? null : raw.map(String).slice(0, 500);
  if (selected && selected.length === 0) return bad(res, 'לא סומן אף פריט לשיבוץ');

  const result = await withEngineLock(() => applyWeek(req.body?.week, { selected }));
  if (result.placed === 0 && result.attached === 0 && result.holes === 0) {
    return bad(res, result.skipped
      ? 'הלוח השתנה מאז שההצעה הוצגה, ואף פריט מסומן כבר לא רלוונטי — פתחו שוב את מילוי השבוע'
      : 'אין מה לשבץ — הלוח מלא או שאין תוכן מוכן', result.skipped ? 409 : 400);
  }
  res.status(201).json(result);
}));

/**
 * "בטל" על מילוי של המנוע. מוחק רק פוסטים מהרשימה שעדיין מתוכננים, לא
 * פורסמו, ונוצרו בחצי השעה האחרונה — כל השאר נשאר. שיוכי תוכן (attached)
 * חוזרים לפוסט חסר תוכן עם הכותרת והסוג הקודמים, ומשימת "לכתוב" שנסגרה
 * בשיוך נפתחת שוב. מה שבוטל נרשם כוויתור, כדי שהמילוי הבא לא יחזיר אותו.
 */
r.post('/engine/undo', requirePerm('content'), wrap(async (req, res) => {
  const ids = parseIdList(req.body?.post_ids).slice(0, 500);
  const attached = Array.isArray(req.body?.attached) ? req.body.attached.slice(0, 500) : [];
  if (ids.length === 0 && attached.length === 0) return bad(res, 'אין מה לבטל');

  const removed = ids.length
    ? await rows(
        `delete from posts
          where id = any($1::int[]) and status = 'scheduled' and published_at is null
            and created_at > now() - interval '30 minutes'
        returning id, content_id, channel_id, scheduled_at`,
        [ids])
    : [];

  const detached = [];
  for (const a of attached) {
    const postId = Number(a?.post_id);
    const contentId = Number(a?.content_id);
    if (!postId || !contentId) continue;
    const kind = ['promo', 'value', 'hybrid'].includes(a.prev_kind) ? a.prev_kind : null;
    const title = typeof a.prev_title === 'string' && a.prev_title.trim()
      ? a.prev_title.trim().slice(0, 200) : 'חסר תוכן';
    const post = await one(
      `update posts set content_id = null, title = $3, kind = coalesce($4, kind)
        where id = $1 and content_id = $2 and status = 'scheduled' and published_at is null
        returning id, channel_id, scheduled_at`,
      [postId, contentId, title, kind]
    );
    if (!post) continue;
    await query(
      `update tasks set done = false, done_at = null
        where post_id = $1 and kind = 'write' and done = true
          and done_at > now() - interval '30 minutes'`,
      [postId]
    );
    detached.push({ ...post, content_id: contentId });
  }

  await recordDismissals([...removed, ...detached]);
  res.json({ removed: removed.length, detached: detached.length,
             ignored: ids.length + attached.length - removed.length - detached.length });
}));

/* ========================= מבצע דחוף ========================= */

/** תצוגה מקדימה: "מה יקרה" — בלי לשמור כלום */
r.post('/urgent/preview', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planUrgent(req.body ?? {}));
}));

/** אישור: משבץ בפועל לפי אותה תוכנית */
r.post('/urgent/commit', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const plan = await planUrgent(b);
  if (plan.errors?.length) return bad(res, plan.errors.join(' · '));
  if (plan.placements.length === 0) return bad(res, 'לא נמצא שטח פנוי לשיבוץ הדחוף');

  const needsApproval = !(req.user.is_owner || req.user.perm_approve);
  const created = [];
  for (const p of plan.placements) {
    const post = await one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at,
                          status, assignee_id, urgent, note)
       values ($1,$2,$3,'promo',$4,$5,$6,true,$7) returning *`,
      [p.channel_id, b.endpoint_id ?? null, b.title, p.scheduled_at,
       needsApproval ? 'pending_approval' : 'scheduled',
       b.assignee_id ?? req.user.id, p.note ?? null]
    );
    created.push(post);
    if (needsApproval) {
      await query(
        `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent)
         values ($1,$2,'approve',$3,$4,true)`,
        [`לאשר: ${b.title}`, `${p.channel_name} · ${p.day_label} · דורש הרשאת אישור`,
         post.id, b.endpoint_id ?? null]
      );
    }
  }
  res.status(201).json({ posts: created, pending: needsApproval });
}));

export default r;
