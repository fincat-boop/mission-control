import { one, query, rows } from './db.js';

/**
 * משבצות מקושרות בקמפיין כללי.
 *
 * המשתמש מקשר משבצת אחת (למשל ריל באינסטגרם, משבצת 3) למשבצת של מדיה אחרת
 * באותו קמפיין (שורט ביוטיוב, משבצת 2). מכאן שתיהן חולקות תוכן אחד — טקסט
 * וקבצים — וכל אחת עדיין מתוזמנת לבד, לפי המדיה שלה.
 *
 * המבנה: content_items.linked_to_id של העוקבת מצביע על המקור. רמה אחת בלבד
 * (מקור לא מקושר לאף אחד), ולכל מקור לכל היותר עוקבת אחת בכל מדיה.
 *
 * איך "תוכן אחד" מגיע לכל מסלולי הקריאה בלי לגעת בעשרות שאילתות:
 *   - הטקסט, המצב וה-meta משוכפלים (sync-on-write) לגרסה של כל משבצת בקבוצה
 *     בכל כתיבה — מכל משבצת בקבוצה (syncFrom). לכן כל מה שקורא גרסה (המנוע,
 *     הלוח, "העתק טקסט", מוכנות, ספירות) רואה את התוכן המשותף כמו שהוא.
 *     גם הכותרת והסוג משוכפלים — הם חלק מהתוכן שבטופס המשבצת.
 *   - הקבצים יושבים רק על המקור. כל קריאה של קבצים לפריט עוברת דרך
 *     assetOwnerId / ITEM_ASSETS_SQL, וכל העלאה לעוקבת נרשמת על המקור
 *     (mediaOwner). כך אין שתי שורות לאותו storage_key, והסל, הסריקה
 *     והגיבוי לא צריכים ספירת הפניות.
 */

/** הפריט שהקבצים שלו הם הקבצים של x (שורה עם id ו-linked_to_id) */
export const assetOwnerId = (x) => x.linked_to_id ?? x.id;

/**
 * הקבצים שפריט $1 מציג במדיה $2, דרך הקישור: עוקבת רואה את כל הקבצים של
 * המקור (בכללי לכל פריט יש גרסה אחת, ולכן קובץ של הגרסה של המקור הוא קובץ
 * של התוכן). לפריט לא מקושר — בדיוק כמו קודם: המשותפים + של הגרסה למדיה.
 * @param cols עמודות מ-content_assets בכינוי a
 */
export const itemAssetsSql = (cols) => `
  select ${cols}
    from content_items ci
    join content_assets a on a.content_id = coalesce(ci.linked_to_id, ci.id)
    left join content_variants av on av.id = a.variant_id
   where ci.id = $1
     and (a.variant_id is null or ci.linked_to_id is not null or av.channel_id = $2)
   order by a.variant_id nulls last, a.id`;

/**
 * כל הפריטים בקבוצה של $1 (המקור והעוקבות שלו), כולל $1 עצמו.
 * @returns {Promise<{id:number, linked_to_id:number|null, slot_channel_id:number|null}[]>}
 */
export async function linkGroup(contentId) {
  return rows(
    `with root as (select coalesce(linked_to_id, id) as id from content_items where id = $1)
     select ci.id, ci.linked_to_id, ci.slot_channel_id, ci.sort_order
       from content_items ci, root
      where ci.id = root.id or ci.linked_to_id = root.id
      order by ci.linked_to_id nulls first, ci.id`,
    [contentId]);
}

/**
 * מעתיק את התוכן של $1 לכל שאר הפריטים בקבוצה שלו: כותרת, סוג, גוף, וגרסה
 * למדיה של כל אחד (טקסט, מצב, meta). עריכה של עוקבת עוברת כך גם למקור
 * ומשם לשאר העוקבות. פריט לא מקושר — לא נוגע בכלום.
 * @returns {Promise<number>} כמה פריטים עודכנו
 */
export async function syncFrom(contentId) {
  const others = await rows(
    `with f as (select id, coalesce(linked_to_id, id) as root, title, kind, body
                  from content_items where id = $1)
     update content_items ci
        set title = f.title, kind = f.kind, body = f.body
       from f
      where (ci.id = f.root or ci.linked_to_id = f.root) and ci.id <> f.id
      returning ci.id`,
    [contentId]);
  if (!others.length) return 0;

  // הגרסה של המקור-לרגע (הפריט שנערך) למדיה שלו → הגרסה של כל אחד למדיה שלו
  await query(
    `with f as (select id, coalesce(linked_to_id, id) as root, slot_channel_id
                  from content_items where id = $1),
          fv as (select v.body, v.status, v.meta
                   from content_variants v join f on v.content_id = f.id
                                                 and v.channel_id = f.slot_channel_id)
     insert into content_variants (content_id, channel_id, body, status, meta)
     select ci.id, ci.slot_channel_id, fv.body, fv.status, fv.meta
       from content_items ci, f, fv
      where (ci.id = f.root or ci.linked_to_id = f.root) and ci.id <> f.id
        and ci.slot_channel_id is not null
     on conflict (content_id, channel_id)
       do update set body = excluded.body, status = excluded.status, meta = excluded.meta`,
    [contentId]);
  return others.length;
}

/**
 * לאן נרשם קובץ שמועלה לפריט: לעוקבת — למקור. קובץ "של הגרסה" של העוקבת
 * עובר לגרסה של המקור (המדיה של המקור), כי לעוקבת אין קבצים משלה.
 * @returns {Promise<{contentId:number, channelId:number|null}|null>} null = אין פריט
 */
export async function mediaOwner(contentId, channelId = null) {
  const item = await one(
    `select ci.id, ci.linked_to_id, src.slot_channel_id as source_channel_id
       from content_items ci
       left join content_items src on src.id = ci.linked_to_id
      where ci.id = $1`,
    [contentId]);
  if (!item) return null;
  if (!item.linked_to_id) return { contentId: item.id, channelId: channelId ?? null };
  return {
    contentId: item.linked_to_id,
    channelId: channelId != null ? item.source_channel_id : null,
  };
}
