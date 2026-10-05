/**
 * מתי פריט תוכן מתאים לפוסט בערוץ מסוים ובתאריך מסוים — כלל אחד, בשלושה
 * מקומות שחייבים להסכים: המנוע (chooseForSlot / chooseHoleFills), רשימת
 * "שייך תוכן" (contentCandidates), ו"יש טיוטה" על כרטיס בלוח (board.js).
 * אם הכרטיס מבטיח תוכן שהרשימה לא מציגה — המשתמש נתקע.
 *
 * הכלל: נקודת הקצה של התוכן פעילה; משבצת-מדיה של קמפיין כללי רק בערוץ
 * שלה וכל עוד הערוץ בקמפיין; קמפיין לא מושהה; התאריך בתוך חלון הקמפיין.
 * (ניסוח לערוץ — מוכן או טיוטה — נבדק בנפרד, ב-join על content_variants.)
 *
 * קמפיין מוכן (שלב 3): פריט לא יוצא לפני התאריך המתוכנן שלו. התאריך נגזר
 * מהמקום בתור (COMPLETE_SPREAD_COLUMNS + spreadDate), ולכן נבדק ב-JS דרך
 * outsideCampaignWindow — אותה פונקציה שהמנוע משתמש בה — ולא משוכפל ב-SQL.
 * candidateFilterSql מסנן גס (חלון בלבד), candidateFits משלים.
 */

import { rows } from './db.js';
// מעגל ייבוא מכוון (engine ← candidates): משתמשים בהם רק בתוך פונקציות, אף
// פעם בזמן טעינת המודול — לכן אין כאן קבועים שנבנים מהם.
import { COMPLETE_SPREAD_COLUMNS, outsideCampaignWindow } from './engine.js';

/** משבצת-מדיה של קמפיין כללי שייכת לערוץ אחד בלבד */
export const fitsSlotChannel = (c, channelId) =>
  !c.slot_channel_id || c.slot_channel_id === channelId;

/**
 * אותו כלל כביטוי SQL. ci/ca — הכינויים של content_items ו-campaigns
 * בשאילתה; channel/date — ביטויים (פרמטר או עמודה). date יכול להיות null.
 */
export function candidateFilterSql({ ci = 'ci', ca = 'ca', channel, date }) {
  return `exists (select 1 from endpoints fe where fe.id = ${ci}.endpoint_id and fe.active)
    and (${ci}.slot_channel_id is null or (${ci}.slot_channel_id = ${channel} and exists (
          select 1 from campaign_channels fcc
           where fcc.campaign_id = ${ci}.campaign_id and fcc.channel_id = ${ci}.slot_channel_id)))
    and (${ca}.id is null or (${ca}.paused_at is null and (
          ${date} is null or ((${ca}.starts_on is null or ${ca}.starts_on <= ${date})
                          and (${ca}.ends_on is null or ${ca}.ends_on >= ${date})))))`;
}

/**
 * העמודות ש-candidateFits צריך (כינויים ci/ca): חלון הקמפיין והמקום בתור
 * של קמפיין מוכן. פונקציה ולא קבוע — ראו הערת הייבוא למעלה.
 */
export const candidateColumnsSql = () =>
  `ci.campaign_id, ci.slot_channel_id,
   ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
   ${COMPLETE_SPREAD_COLUMNS}`;

/**
 * ההשלמה ב-JS ל-candidateFilterSql: משבצת-מדיה בערוץ שלה, והתאריך בתוך
 * החלון — כולל "לא לפני התאריך המתוכנן" של קמפיין מוכן. בלי dateKey —
 * רק כלל הערוץ.
 */
export function candidateFits(c, channelId, dateKey = null) {
  return fitsSlotChannel(c, channelId) && (!dateKey || !outsideCampaignWindow(c, dateKey));
}

/**
 * "יש טיוטה" / "יש תוכן לשייך" לפוסט חסר תוכן — מתוך שורות מועמדים
 * (content_id, endpoint_id, channel_id, status + עמודות candidateColumnsSql).
 * 'ready' אם יש מועמד מוכן, 'draft' אם יש רק טיוטות, אחרת null.
 */
export function hintFor(candidateRows, post, dateKey) {
  const fits = candidateRows.filter((r) =>
    r.endpoint_id === post.endpoint_id && r.channel_id === post.channel_id &&
    candidateFits(r, post.channel_id, dateKey));
  if (fits.some((r) => r.status === 'ready')) return 'ready';
  return fits.length ? 'draft' : null;
}

/**
 * הרמזים לכל הפוסטים חסרי התוכן בלוח, בשאילתה אחת.
 * @param {object[]} posts שורות posts (id, content_id, endpoint_id, channel_id, scheduled_at)
 * @param {(d:Date)=>string} ymd תאריך מקומי YYYY-MM-DD
 * @returns {Promise<Map<number, 'ready'|'draft'|null>>}
 */
export async function contentHints(posts, ymd) {
  const missing = posts.filter((p) => !p.content_id && p.endpoint_id);
  const out = new Map();
  if (missing.length === 0) return out;
  const candidateRows = await rows(
    `select ci.id, ci.endpoint_id, v.channel_id, v.status, ${candidateColumnsSql()}
       from content_items ci
       join content_variants v on v.content_id = ci.id and v.status in ('ready','draft')
       left join campaigns ca  on ca.id = ci.campaign_id
      where ci.endpoint_id = any($1::int[]) and v.channel_id = any($2::int[])
        and ${candidateFilterSql({ channel: 'v.channel_id', date: 'null::date' })}`,
    [[...new Set(missing.map((p) => p.endpoint_id))],
     [...new Set(missing.map((p) => p.channel_id))]]
  );
  for (const p of missing) {
    out.set(p.id, hintFor(candidateRows, p, ymd(new Date(p.scheduled_at))));
  }
  return out;
}
