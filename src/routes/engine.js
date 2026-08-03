import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { bad, wrap } from './_shared.js';
import { applyWeek, planWeek, withEngineLock } from '../engine.js';
import { planUrgent } from '../urgent.js';
import { one, query } from '../db.js';

const r = Router();

/* ========================= מנוע השיבוץ ========================= */

/** תכנון בלבד — לא נכתב כלום */
r.post('/engine/plan', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planWeek(req.body?.week));
}));

/** ביצוע התכנון. מריץ תכנון טרי כדי שלא ייכתב משהו על סמך מצב ישן. */
r.post('/engine/apply', requirePerm('content'), wrap(async (req, res) => {
  const result = await withEngineLock(() => applyWeek(req.body?.week));
  if (result.placed === 0 && result.holes === 0) {
    return bad(res, 'אין מה לשבץ — הלוח מלא או שאין תוכן מוכן');
  }
  res.status(201).json(result);
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
