import { currentOrg, one, query, rows } from './db.js';
import { mediaReady, mediaStore, newMediaKey } from './media.js';

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
 *     assetOwnerId / itemAssetsSql, וכל העלאה לעוקבת נרשמת על המקור
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

/* ========================= ניתוק ========================= */

/** שגיאה עם קוד HTTP והודעה למשתמש — הנתיב מחזיר אותה כמו שהיא */
export class LinkError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** הגרסה של פריט למדיה של המשבצת שלו — נוצרת אם אין, כדי לתלות עליה קבצים */
async function slotVariantId(contentId) {
  const v = await one(
    `insert into content_variants (content_id, channel_id)
     select id, slot_channel_id from content_items where id = $1 and slot_channel_id is not null
     on conflict (content_id, channel_id) do update set content_id = excluded.content_id
     returning id`,
    [contentId]);
  return v?.id ?? null;
}

/**
 * מעתיק את הקבצים של המקור לפריט אחר, כעותקים עצמאיים: קובץ ב-R2 מועתק
 * לאובייקט חדש (כמו בשכפול קמפיין — מחיקה מאחד מוחקת את האובייקט שלו),
 * קובץ ישן (bytea) מועתק בתוך Postgres. קובץ של הגרסה של המקור הופך לקובץ
 * של הגרסה של היעד (המדיה של היעד).
 * העתקה ב-R2 קודמת לשורה: כשל באמצע מפיל את הבקשה (והטרנזקציה מתגלגלת),
 * ומה שכבר הועתק נשאר יתום וסריקת היתומים אוספת אותו.
 * @returns {Promise<number>} כמה קבצים הועתקו
 */
export async function copyAssetsTo(sourceId, targetId, { store = mediaStore } = {}) {
  const list = await rows(
    'select id, variant_id, storage_key, filename from content_assets where content_id = $1 order by id',
    [sourceId]);
  if (!list.length) return 0;
  if (list.some((a) => a.storage_key) && !mediaReady()) {
    throw new LinkError('אחסון המדיה לא מוגדר בשרת — אי אפשר להעתיק את הקבצים של המשבצת', 503);
  }
  const variantId = list.some((a) => a.variant_id) ? await slotVariantId(targetId) : null;
  for (const a of list) {
    const key = a.storage_key ? newMediaKey(currentOrg(), a.filename) : null;
    if (key) await store.copy(a.storage_key, key);
    await query(
      `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data, storage_key)
       select $1, $2, filename, mime, size_bytes, case when $3::text is null then data end, $3
         from content_assets where id = $4`,
      [targetId, a.variant_id ? variantId : null, key, a.id]);
  }
  return list.length;
}

/**
 * מעביר את שורות הקבצים של המקור לפריט אחר, בלי העתקה (המקור עומד להימחק).
 * קובץ של הגרסה של המקור עובר לגרסה של היעד.
 */
async function moveAssetsTo(sourceId, targetId) {
  const has = await one(
    'select bool_or(variant_id is not null) as v from content_assets where content_id = $1', [sourceId]);
  const variantId = has?.v ? await slotVariantId(targetId) : null;
  const moved = await rows(
    `update content_assets set content_id = $2,
            variant_id = case when variant_id is null then null else $3::int end
      where content_id = $1 returning id`,
    [sourceId, targetId, variantId]);
  return moved.length;
}

/**
 * מנתק עוקבת אחת מהמקור שלה: היא נשארת עם עותק עצמאי של התוכן — הטקסט כבר
 * משוכפל אצלה, והקבצים מועתקים מהמקור.
 */
export async function unlinkFollower(followerId, opts = {}) {
  const f = await one(
    'select id, linked_to_id from content_items where id = $1 for update', [followerId]);
  if (!f) throw new LinkError('לא נמצא תוכן כזה', 404);
  if (!f.linked_to_id) throw new LinkError('המשבצת הזו לא מקושרת');
  const copied = await copyAssetsTo(f.linked_to_id, f.id, opts);
  await query('update content_items set linked_to_id = null where id = $1', [f.id]);
  return { unlinked: 1, copied };
}

/**
 * מנתק את כל העוקבות של מקור — כל אחת עם עותק עצמאי. sourceGoing: המקור
 * עומד להימחק, ולכן העוקבת הראשונה מקבלת את שורות הקבצים שלו עצמן (בלי
 * העתקה), ורק השאר מקבלות עותקים.
 */
export async function detachFollowers(sourceId, { sourceGoing = false, ...opts } = {}) {
  const followers = await rows(
    'select id from content_items where linked_to_id = $1 order by id for update', [sourceId]);
  if (!followers.length) return { unlinked: 0, copied: 0 };
  const [heir, ...rest] = sourceGoing ? followers : [null, ...followers];
  let copied = 0;
  // קודם העותקים (הם נקראים מהשורות של המקור), ואחר כך ההעברה ליורשת
  for (const f of rest) copied += await copyAssetsTo(sourceId, f.id, opts);
  if (heir) copied += await moveAssetsTo(sourceId, heir.id);
  await query('update content_items set linked_to_id = null where linked_to_id = $1', [sourceId]);
  return { unlinked: followers.length, copied };
}

/**
 * "נתק קישור" מכל משבצת בקבוצה: עוקבת — רק היא מתנתקת; מקור — כל העוקבות
 * שלו מתנתקות. בכל מקרה כל משבצת נשארת עם תוכן משלה.
 */
export async function unlink(contentId, opts = {}) {
  const item = await one('select id, linked_to_id from content_items where id = $1', [contentId]);
  if (!item) throw new LinkError('לא נמצא תוכן כזה', 404);
  if (item.linked_to_id) return unlinkFollower(item.id, opts);
  const out = await detachFollowers(item.id, opts);
  if (!out.unlinked) throw new LinkError('המשבצת הזו לא מקושרת');
  return out;
}

/**
 * לפני שפריט יוצא מהקבוצה שלו לתמיד (נמחק, יוצא מהקמפיין, הקמפיין נמחק):
 * עוקבת — מתנתקת עם עותק; מקור — העוקבות מתנתקות עם עותקים (sourceGoing:
 * המקור נמחק, והראשונה יורשת את הקבצים שלו).
 */
export async function releaseLinks(contentId, { sourceGoing = false, ...opts } = {}) {
  const item = await one('select id, linked_to_id from content_items where id = $1', [contentId]);
  if (!item) return { unlinked: 0, copied: 0 };
  if (item.linked_to_id) {
    // עוקבת שנמחקת לא צריכה עותק — רק יוצאת מהקבוצה
    if (sourceGoing) {
      await query('update content_items set linked_to_id = null where id = $1', [item.id]);
      return { unlinked: 1, copied: 0 };
    }
    return unlinkFollower(item.id, opts);
  }
  return detachFollowers(item.id, { sourceGoing, ...opts });
}
