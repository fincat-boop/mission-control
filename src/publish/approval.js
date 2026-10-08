import { createHash } from 'node:crypto';
import { one, query, rows } from '../db.js';
import { itemAssetsSql } from '../links.js';

/**
 * האישור לפרסום אוטומטי ניתן על תוכן מסוים (סעיף 31 בשיפורי ההתנהגות).
 *
 * ברגע האישור נשמרת על הפוסט טביעה (posts.approved_digest) של מה שיוצא
 * בפועל: מצב הגרסה לערוץ, הטקסט, ה-meta (תגובה ראשונה, שער, קישור...)
 * והקבצים לפי הסדר שבו הם יוצאים (itemAssetsSql — במשבצת מקושרת, של
 * המקור). אותו רעיון כמו הטביעה של הניוזלטר מול ה-HUB (newsletter.js
 * newsletterDigest), בלי המועד: הזזת מועד משאירה את האישור.
 *
 * שני מקומות משווים אליה:
 *   - כל נתיב שמשנה תוכן (גרסה, קבצים, מצב, קישור) — resetChangedApprovals
 *     באותה טרנזקציה: פוסטים מאושרים עתידיים שהטביעה שלהם השתנתה חוזרים
 *     למתוכנן, והתשובה אומרת כמה (approval_reset).
 *   - הטיק, ברגע הפרסום (runner.js preparePublish): טביעה שלא תואמת — לא
 *     מפרסמים; הפוסט חוזר למתוכנן עם משימת "לאשר מחדש". הגנה למקרה שנתיב
 *     כלשהו (ייבוא, המרת מבנה קמפיין) שינה תוכן בלי לעבור כאן.
 * טביעה ריקה = אושר לפני שהיו טביעות: הטיק לא חוסם אותו, ושינוי תוכן כן
 * מחזיר אותו לאישור (אין מול מה להשוות — הזהיר).
 */

/** סדר מפתחות קבוע — אותו meta תמיד נותן אותה מחרוזת */
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
};

/**
 * הטביעה (טהורה): variant — {status, body, meta} של הגרסה לערוץ (או null),
 * assets — הקבצים בסדר שבו הם יוצאים (רק id נדרש).
 */
export function approvalDigest({ variant, assets = [] }) {
  const payload = JSON.stringify([
    variant?.status ?? null, variant?.body ?? '', stable(variant?.meta ?? {}),
    (assets ?? []).map((a) => Number(a.id)),
  ]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** הטביעה של מה שהפוסט היה יוצא איתו עכשיו (התוכן × הערוץ שלו) */
export async function currentApprovalDigest(contentId, channelId) {
  if (!contentId) return approvalDigest({ variant: null });
  const variant = await one(
    'select status, body, meta from content_variants where content_id = $1 and channel_id = $2',
    [contentId, channelId]);
  const assets = await rows(itemAssetsSql('a.id'), [contentId, channelId]);
  return approvalDigest({ variant, assets });
}

/**
 * אחרי שינוי בתוכן של contentIds (כל אחד עם הקבוצה המקושרת שלו — מקור
 * ועוקבות): פוסט מאושר עתידי שהטביעה שלו לא תואמת למה שהיה יוצא עכשיו
 * חוזר למתוכנן, בלי אישור. מה שהמועד שלו עבר, פורסם או באמצע פרסום — לא
 * נוגעים (הטיק בודק ברגע הפרסום). רץ בתוך טרנזקציית הבקשה.
 * @param {Array<number|string>} contentIds
 * @returns {Promise<number>} כמה פוסטים חזרו לאישור
 */
export async function resetChangedApprovals(contentIds) {
  const list = [...new Set((contentIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  const approved = await rows(
    `select p.id, p.content_id, p.channel_id, p.approved_digest
       from posts p
      where p.status = 'approved' and p.scheduled_at > now()
        and p.content_id in (
          select ci.id from content_items ci
           where coalesce(ci.linked_to_id, ci.id) in (
             select coalesce(linked_to_id, id) from content_items where id = any($1::int[])))
      order by p.id
      for update of p`,
    [list]);
  const stale = [];
  for (const p of approved) {
    const now = await currentApprovalDigest(p.content_id, p.channel_id);
    if (p.approved_digest !== now) stale.push(p.id);
  }
  if (!stale.length) return 0;
  const back = await rows(
    `update posts set status = 'scheduled', approved_by = null, approved_at = null,
                      approved_digest = null, publish_error = null, publish_retry_at = null
      where id = any($1::int[]) and status = 'approved' returning id`,
    [stale]);
  return back.length;
}

/** "לאשר מחדש" — הטיק סירב לפרסם כי התוכן השתנה אחרי האישור */
export const CHANGED_AFTER_APPROVAL =
  'התוכן השתנה אחרי האישור, ולכן הפוסט לא פורסם אוטומטית — בודקים את התוכן, קובעים מועד ומאשרים שוב';

/**
 * משימת "לאשר מחדש" לפוסט שהטיק סירב לפרסם (kind 'approve' + meta.reapprove;
 * אחת פתוחה לכל פוסט — tasks_reapprove_uidx). נסגרת לבד כשהפוסט מאושר שוב,
 * פורסם או נמחק, או יממה אחרי המועד (task-lifecycle.js).
 */
export async function recordReapproveTask(post) {
  await query(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta, assignee_id)
     values ($1,$2,'approve',$3,$4,true,(now() at time zone 'Asia/Jerusalem')::date,
             '{"reapprove": true}'::jsonb, $5)
     on conflict (post_id) where kind = 'approve' and done = false and (meta->>'reapprove') = 'true'
     do nothing`,
    [`לאשר מחדש: ${post.title}`, `${post.channel_name} — ${CHANGED_AFTER_APPROVAL}`,
     post.id, post.endpoint_id ?? null, post.assignee_id ?? null]);
}

/**
 * הערוץ הפסיק להתפרסם לבד (החלטת מנהל D1, סבב 2 של שלב 7): פרסום אוטומטי
 * כובה לערוץ, החיבור נמחק, או שהערוץ הושבת. "מאושר" שם כבר לא מגן על
 * כלום — כל המאושרים של הערוץ חוזרים למתוכנן (כמו resetToManual, מצומצם
 * לערוץ): בלי אישור, טביעה, ניסיון חוזר והודעת הכשל של הניסיון הראשון.
 * publishing — לא נוגעים (כבר יצא לדרך).
 * @returns {Promise<number>} כמה חזרו לאישור
 */
export async function resetChannelApprovals(channelId) {
  const back = await rows(
    `update posts set status = 'scheduled', approved_by = null, approved_at = null,
                      approved_digest = null, publish_retry_at = null, publish_error = null
      where channel_id = $1 and status = 'approved' returning id`, [channelId]);
  return back.length;
}
