/**
 * מתי פריט תוכן מתאים לפוסט בערוץ מסוים ובתאריך מסוים — כלל אחד, בשלושה
 * מקומות שחייבים להסכים: המנוע (chooseForSlot / chooseHoleFills), רשימת
 * "שייך תוכן" (contentCandidates), ו"יש טיוטה" על כרטיס בלוח (board.js).
 * אם הכרטיס מבטיח תוכן שהרשימה לא מציגה — המשתמש נתקע.
 *
 * הכלל: נקודת הקצה של התוכן פעילה; משבצת-מדיה של קמפיין כללי רק בערוץ
 * שלה וכל עוד הערוץ בקמפיין; קמפיין לא מושהה; התאריך בתוך חלון הקמפיין.
 * (ניסוח לערוץ — מוכן או טיוטה — נבדק בנפרד, ב-join על content_variants.)
 */

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
