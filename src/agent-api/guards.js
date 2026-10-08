/**
 * כללים שחלים רק על סוכן — מעבר לרשימה הלבנה. הנתיבים עצמם משותפים עם
 * הממשק, ושם אדם עם הרשאת תוכן רשאי לעשות את הדברים האלה. לסוכן לא:
 *
 *  - לשנות תוכן (טקסט, ניסוח, קבצים, קישור) שמשובץ בפוסט שכבר אושר לפרסום
 *    או בפרסום. הטיק מפרסם את מה שיש בתוכן ברגע היציאה, כך ששינוי אחרי
 *    האישור = פרסום של משהו שאף אדם לא אישר. 409 — אדם מבטל אישור קודם.
 *  - להעביר תוכן בין קמפיינים או נקודות קצה (ניהול קמפיינים — מחוץ להרשאות).
 *  - להחליף תוכן קיים במשבצת בקישור (link עם replace) — זה מוחק את הקבצים
 *    והניסוחים של היעד.
 *  - למחוק תוצאות. ב-PUT /posts/:id/results שדה שלא נשלח מתאפס; לסוכן הוא
 *    נשמר מהקיים, ותוצאות שכולן ריקות נדחות.
 *
 * רץ אחרי tenantScope (בהקשר הארגון) ולפני הנתיבים.
 */

import { one } from '../db.js';

const RESULT_FIELDS = ['reach', 'engagement', 'clicks', 'leads', 'note'];

/** האם תוכן (או קבוצת הקישור שלו — הם יוצאים עם אותו תוכן) משובץ בפוסט מאושר */
async function feedsApprovedPost(contentId) {
  const r = await one(
    `with root as (
       select coalesce(linked_to_id, id) as id from content_items where id = $1
     )
     select exists (
       select 1 from posts p
        where p.status in ('approved', 'publishing')
          and p.content_id in (
            select ci.id from content_items ci, root
             where ci.id = root.id or ci.linked_to_id = root.id)
     ) as hit`, [contentId]);
  return !!r?.hit;
}

const deny = (res, status, error) => res.status(status).json({ error });
const idOrNull = (v) => (v == null || v === '' ? null : Number(v));

async function check(req, res) {
  const b = req.body ?? {};
  const content = /^\/content\/(\d+)(?:\/|$)/.exec(req.path);

  if (content && req.method !== 'GET') {
    if (await feedsApprovedPost(content[1])) {
      return deny(res, 409, 'התוכן משובץ בפוסט שכבר אושר לפרסום. סוכן לא משנה תוכן מאושר — ' +
        'אדם צריך לבטל את האישור קודם.');
    }
    if (req.method === 'PATCH' && /^\/content\/\d+\/?$/.test(req.path) &&
        ('campaign_id' in b || 'endpoint_id' in b)) {
      const cur = await one('select campaign_id, endpoint_id from content_items where id = $1', [content[1]]);
      const moved = cur && (('campaign_id' in b && idOrNull(b.campaign_id) !== cur.campaign_id) ||
                            ('endpoint_id' in b && idOrNull(b.endpoint_id) !== cur.endpoint_id));
      if (moved) return deny(res, 403, 'סוכן לא מעביר תוכן בין קמפיינים או נקודות קצה');
    }
    if (/\/link\/?$/.test(req.path) && b.replace === true) {
      return deny(res, 403, 'סוכן לא מחליף תוכן קיים במשבצת — הקישור עם replace מוחק את התוכן של היעד');
    }
  }

  const results = /^\/posts\/(\d+)\/results\/?$/.exec(req.path);
  if (results && req.method === 'PUT') {
    const cur = await one(`select ${RESULT_FIELDS.join(', ')} from post_results where post_id = $1`, [results[1]]);
    const merged = { ...b };
    for (const f of RESULT_FIELDS) if (!(f in merged) && cur) merged[f] = cur[f];
    if (RESULT_FIELDS.every((f) => merged[f] == null || String(merged[f]).trim() === '')) {
      return deny(res, 400, 'צריך לפחות ערך אחד. סוכן לא מוחק תוצאות');
    }
    req.body = merged;
  }
  return null;
}

export function agentGuards(req, res, next) {
  check(req, res).then((denied) => { if (!denied) next(); }).catch(next);
}
