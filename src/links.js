import { currentOrg, one, query, rows } from './db.js';
import { TRASH_DAYS, mediaReady, mediaStore, newMediaKey } from './media.js';
import { contentBlocker } from './publish/readiness.js';

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
 * סדר הנעילה של כל שינוי בקבוצה מקושרת: קודם שורת הקמפיין (כמו "קמפיין
 * מוכן" והעלאה מרוכזת — קמפיין ← פריטים), ואחר כך שורות הקבוצה לפי מזהה.
 * כך שתי בקשות על אותה קבוצה (עריכה של המקור ושל העוקבת במקביל, מחיקה מול
 * קישור) רצות בתור ולא נתקעות זו בזו. חייב לרוץ לפני שהבקשה נוגעת בשורה של
 * הפריט עצמו (updateById נועל אותה).
 * רק משבצת של קמפיין כללי — רק להן יש קישורים; זווית ותוכן שוטף לא ננעלים.
 * @returns {Promise<object|null>} שורת הפריט, נקראת אחרי הנעילה
 */
export async function lockLinkScope(contentId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const it = await one(
      'select id, campaign_id, slot_channel_id from content_items where id = $1', [contentId]);
    if (!it || !it.campaign_id || !it.slot_channel_id) return it;
    await query('select id from campaigns where id = $1 for update', [it.campaign_id]);
    // הפריט עבר קמפיין בין הקריאה לנעילה — מנסים שוב מול הקמפיין החדש
    const now = await one('select campaign_id from content_items where id = $1', [contentId]);
    if (now && now.campaign_id !== it.campaign_id) continue;
    await query(
      `with root as (select coalesce(linked_to_id, id) as id from content_items where id = $1)
       select ci.id from content_items ci, root
        where ci.id = root.id or ci.linked_to_id = root.id
        order by ci.id for update of ci`,
      [contentId]);
    return one('select * from content_items where id = $1', [contentId]);
  }
  throw new LinkError('התוכן השתנה בזמן הפעולה — נסו שוב', 409);
}

/**
 * מעתיק את התוכן של $1 לכל שאר הפריטים בקבוצה שלו: כותרת, סוג, גוף, וגרסה
 * למדיה של כל אחד (טקסט, מצב, meta). עריכה של עוקבת עוברת כך גם למקור
 * ומשם לשאר העוקבות. פריט לא מקושר — לא נוגע בכלום.
 * המצב (טיוטה/מוכן) עובר לשאר הקבוצה רק כשהבקשה שינתה אותו (statusChanged);
 * עריכה שמשאירה את המצב מסנכרנת טקסט, meta, כותרת וסוג בלבד. כך עוקבת
 * שנשארה טיוטה (למשל אינסטגרם בלי מדיה) לא מורידה את המקור לטיוטה כשעורכים
 * בה טקסט. כשהמצב כן עובר ל"מוכן" — כל משבצת נבדקת לערוץ שלה, ומשבצת שהתוכן
 * לא מספיק לה נשארת טיוטה (readiness.js).
 * @param {{statusChanged?:boolean}} opts statusChanged — הבקשה שינתה את המצב של
 *        הפריט שנערך (או קישור חדש — הקבוצה מקבלת את מצב המקור)
 * @returns {Promise<{synced:number, downgraded:object[]}>} כמה פריטים עודכנו,
 *          ואילו עוקבות נשארו טיוטה ({id, channel_id, channel_name, reason})
 */
export async function syncFrom(contentId, { statusChanged = false } = {}) {
  const others = await rows(
    `with f as (select id, coalesce(linked_to_id, id) as root, title, kind, body
                  from content_items where id = $1)
     update content_items ci
        set title = f.title, kind = f.kind, body = f.body
       from f
      where (ci.id = f.root or ci.linked_to_id = f.root) and ci.id <> f.id
      returning ci.id`,
    [contentId]);
  if (!others.length) return { synced: 0, downgraded: [] };

  // לפריט שנערך אין גרסה (נמחקה) — גם לשאר אין: הקבוצה תמיד זהה
  const hasVariant = await one(
    `select 1 from content_variants v join content_items ci
        on ci.id = v.content_id and v.channel_id = ci.slot_channel_id
      where ci.id = $1`, [contentId]);
  if (!hasVariant) {
    await query(
      `delete from content_variants v using content_items ci
        where ci.id = v.content_id and v.channel_id = ci.slot_channel_id
          and ci.id = any($1::int[])`,
      [others.map((x) => x.id)]);
    return { synced: others.length, downgraded: [] };
  }

  // הגרסה של המקור-לרגע (הפריט שנערך) למדיה שלו → הגרסה של כל אחד למדיה שלו.
  // המצב — רק כשהבקשה שינתה אותו ($2), או למשבצת שעוד אין לה גרסה.
  const written = await rows(
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
       do update set body = excluded.body, meta = excluded.meta,
                     status = case when $2 then excluded.status else content_variants.status end
     returning content_id, (xmax = 0) as inserted`,
    [contentId, statusChanged]);
  // מצב שעבר עכשיו (שינוי, או גרסה חדשה) — נבדק לכל ערוץ בנפרד
  const statusMoved = statusChanged ? written : written.filter((w) => w.inserted);
  return { synced: others.length,
           downgraded: await keepDraftWhereNotReady(statusMoved.map((w) => w.content_id)) };
}

/** עוקבות שקיבלו "מוכן" והתוכן לא מספיק לערוץ שלהן — חוזרות לטיוטה */
async function keepDraftWhereNotReady(ids) {
  const ready = await rows(
    `select ci.id, ci.slot_channel_id as channel_id, ch.name as channel_name, ch.platform,
            v.body, v.meta
       from content_items ci
       join content_variants v on v.content_id = ci.id and v.channel_id = ci.slot_channel_id
       join channels ch on ch.id = ci.slot_channel_id
      where ci.id = any($1::int[]) and v.status = 'ready'`, [ids]);
  const out = [];
  for (const r of ready) {
    const assets = await rows(itemAssetsSql('a.mime'), [r.id, r.channel_id]);
    const reason = contentBlocker({ platform: r.platform, variant: r, assets });
    if (!reason) continue;
    await query(`update content_variants set status = 'draft'
                  where content_id = $1 and channel_id = $2`, [r.id, r.channel_id]);
    out.push({ id: r.id, channel_id: r.channel_id, channel_name: r.channel_name, reason });
  }
  return out;
}

/**
 * לאן נרשם קובץ שמועלה לפריט: לעוקבת — למקור. קובץ "של הגרסה" של העוקבת
 * עובר לגרסה של המקור (המדיה של המקור), כי לעוקבת אין קבצים משלה.
 * @returns {Promise<{contentId:number, channelId:number|null}|null>} null = אין פריט
 */
export async function mediaOwner(contentId, channelId = null) {
  // העלאה מול מחיקת המקור / ניתוק באותו רגע — אותו סדר נעילה
  await lockLinkScope(contentId);
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
  // for update: התחזוקה מעבירה קבצים ישנים (bytea) ל-R2 ברקע ומאפסת את
  // הבייטים. נעילת השורות מחכה להעברה שבאמצע (ורואה את התוצאה שלה), או
  // מעכבת אותה עד סוף הבקשה — כך לא מעתיקים שורה בלי בייטים ובלי מפתח.
  const list = await rows(
    `select id, variant_id, storage_key, filename from content_assets
      where content_id = $1 order by id for update`,
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
  await lockLinkScope(contentId);
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
  await lockLinkScope(contentId);
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

/* ========================= קישור ========================= */

/** מקום במשבצת: מספר שלם 1–1000 (כמו בנתיבי התוכן) */
const validSlot = (n) => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 1000;

/**
 * כללי הקישור, בלי DB. מחזיר {error, status, needs_confirm?} או null כשמותר.
 *
 * @param ctx.campaign      הקמפיין של המקור {structure}
 * @param ctx.root          המקור {id, slot_channel_id, campaign_id} — אחרי שעוקבת
 *                          שנלחצה הוחלפה במקור שלה (רמה אחת בלבד)
 * @param ctx.rootChannel   המדיה של המקור {name, platform}
 * @param ctx.target        היעד {channel_id, sort_order, campaign_id}
 * @param ctx.targetChannel המדיה של היעד {name, platform, in_campaign} או null
 * @param ctx.targetItem    הפריט שכבר במשבצת היעד {id, linked_to_id, followers} או null
 * @param ctx.sibling       עוקבת קיימת של המקור באותה מדיה {sort_order} או null
 * @param ctx.replace       המשתמש אישר שהתוכן הקיים ביעד יוחלף
 */
export function linkError(ctx) {
  const { campaign, root, rootChannel, target, targetChannel, targetItem, sibling, replace } = ctx;
  if (!root.slot_channel_id || campaign?.structure !== 'general') {
    return { error: 'קישור משבצות זמין רק בקמפיין כללי', status: 400 };
  }
  // רמה אחת: המקור לא מקושר בעצמו (אם בינתיים הפך לעוקבת — מנסים שוב)
  if (root.linked_to_id) {
    return { error: 'המשבצת הזו התקשרה בינתיים למשבצת אחרת — נסו שוב', status: 409 };
  }
  if (!target || target.campaign_id !== root.campaign_id) {
    return { error: 'אפשר לקשר רק למשבצת באותו קמפיין', status: 400 };
  }
  if (!validSlot(target.sort_order)) {
    return { error: 'מספר המשבצת חייב להיות מספר שלם בין 1 ל-1000', status: 400 };
  }
  if (!targetChannel?.in_campaign) return { error: 'המדיה הזו לא בקמפיין', status: 400 };
  if (Number(target.channel_id) === root.slot_channel_id) {
    return {
      error: 'מקשרים למשבצת של מדיה אחרת — באותה מדיה כל משבצת היא פוסט נפרד', status: 400,
    };
  }
  if (rootChannel?.platform === 'newsletter' || targetChannel.platform === 'newsletter') {
    return {
      error: 'ניוזלטר לא מתקשר למשבצת אחרת — התוכן שלו (נושא, תבנית, גוף המייל) שונה מפוסט רגיל',
      status: 400,
    };
  }
  if (targetItem) {
    if (targetItem.id === root.id) return { error: 'זו אותה משבצת', status: 400 };
    if (targetItem.linked_to_id === root.id) return { error: 'המשבצות כבר מקושרות', status: 409 };
    if (targetItem.linked_to_id) {
      return { error: 'המשבצת הזו כבר מקושרת למשבצת אחרת — מנתקים אותה קודם', status: 409 };
    }
    if (targetItem.followers > 0) {
      return { error: 'למשבצת הזו מקושרות משבצות אחרות — מנתקים אותן קודם', status: 409 };
    }
  }
  if (sibling) {
    return {
      error: `לתוכן הזה כבר יש משבצת מקושרת ב${targetChannel.name} (פוסט ${sibling.sort_order}) — ` +
        'אפשר משבצת אחת בכל מדיה',
      status: 409,
    };
  }
  if (targetItem && !replace) {
    return { error: 'התוכן הקיים במשבצת יוחלף', status: 409, needs_confirm: true };
  }
  return null;
}

/** savepoint סביב כתיבה שעלולה להיתקל באינדקס ייחודי (שני משתמשים באותו רגע) */
async function uniqueOr409(fn, message) {
  await query('savepoint link_unique');
  try {
    const out = await fn();
    await query('release savepoint link_unique');
    return out;
  } catch (e) {
    await query('rollback to savepoint link_unique');
    if (e.code === '23505') throw new LinkError(message, 409);
    throw e;
  }
}

/**
 * מקשר את המשבצת שנלחצה למשבצת של מדיה אחרת באותו קמפיין. המשבצת שנלחצה
 * (או המקור שלה, אם היא עצמה עוקבת) היא המקור — התוכן שלה הוא התוכן המשותף.
 * משבצת יעד ריקה — נוצר בה פריט עוקב; משבצת עם תוכן — התוכן שלה מוחלף (הקבצים
 * שלה לסל המחזור) והפריט עצמו נשאר, כדי שפוסטים שכבר בלוח ימשיכו להצביע עליו.
 *
 * @param body {target_campaign_slot: {channel_id, sort_order}} או {target_content_id},
 *             ו-replace: true אחרי שהמשתמש אישר החלפה של תוכן קיים
 * @returns {Promise<{source:object, follower:object}>}
 */
export async function linkSlots(clickedId, body = {}) {
  // קודם הנעילה (קמפיין ← הקבוצה של המשבצת שנלחצה), ורק אחריה הקריאה: מה
  // שנקרא לפני הנעילה יכול להתיישן — קישור מקביל היה יוצר שרשרת
  const clicked = await lockLinkScope(clickedId);
  if (!clicked) throw new LinkError('לא נמצא תוכן כזה', 404);
  const rootId = clicked.linked_to_id ?? clicked.id;

  // היעד: פריט קיים לפי מזהה, או מקום (מדיה + מספר משבצת) בקמפיין של המקור
  let target;
  let targetItemId = null;
  if (body.target_content_id != null) {
    const t = await one(
      'select id, campaign_id, slot_channel_id, sort_order from content_items where id = $1',
      [Number(body.target_content_id) || 0]);
    if (!t) throw new LinkError('לא נמצאה משבצת כזו', 404);
    if (!t.slot_channel_id) throw new LinkError('קישור משבצות זמין רק בקמפיין כללי');
    target = { channel_id: t.slot_channel_id, sort_order: t.sort_order, campaign_id: t.campaign_id };
    targetItemId = t.id;
  } else if (body.target_campaign_slot && typeof body.target_campaign_slot === 'object') {
    const ts = body.target_campaign_slot;
    target = {
      channel_id: Number(ts.channel_id) || 0, sort_order: Number(ts.sort_order),
      campaign_id: clicked.campaign_id,
    };
  } else {
    throw new LinkError('צריך לבחור משבצת לקישור');
  }

  // נעילה של המקור ושל היעד (לפי סדר המזהים, בלי דדלוק): שני קישורים במקביל
  // לא יוצרים שרשרת (עוקבת של עוקבת) ולא שתי עוקבות באותה מדיה
  if (!targetItemId && validSlot(target.sort_order)) {
    targetItemId = (await one(
      `select id from content_items
        where campaign_id = $1 and slot_channel_id = $2 and sort_order = $3`,
      [target.campaign_id, target.channel_id, target.sort_order]))?.id ?? null;
  }
  await query(
    'select id from content_items where id = any($1::int[]) order by id for update',
    [[rootId, targetItemId].filter(Boolean)]);

  const root = await one(
    `select ci.*, ca.structure from content_items ci
       left join campaigns ca on ca.id = ci.campaign_id where ci.id = $1`, [rootId]);
  if (!root) throw new LinkError('לא נמצא תוכן כזה', 404);
  const targetItem = targetItemId ? await one(
    `select id, linked_to_id,
            (select count(*)::int from content_items f where f.linked_to_id = ci.id) as followers
       from content_items ci where id = $1`, [targetItemId]) : null;
  // ברצף ולא ב-Promise.all: כל השאילתות על אותו client של הבקשה
  const rootChannel = await one('select name, platform from channels where id = $1',
    [root.slot_channel_id]);
  const targetChannel = await one(
    `select ch.name, ch.platform,
            exists (select 1 from campaign_channels cc
                     where cc.campaign_id = $2 and cc.channel_id = ch.id) as in_campaign
       from channels ch where ch.id = $1`,
    [target.channel_id, root.campaign_id]);
  const sibling = await one(
    `select id, sort_order from content_items
      where linked_to_id = $1 and slot_channel_id = $2 and id <> coalesce($3, 0)`,
    [root.id, target.channel_id, targetItemId]);

  const err = linkError({
    campaign: { structure: root.structure }, root, rootChannel, target, targetChannel,
    targetItem, sibling, replace: body.replace === true,
  });
  if (err) {
    throw new LinkError(err.error, err.status, err.needs_confirm ? { needs_confirm: true } : {});
  }

  let followerId;
  if (targetItem) {
    // התוכן הקיים מוחלף: הקבצים שלו לסל המחזור (כמו הסרה מהממשק), גרסאות
    // למדיה אחרת (לא אמורות להיות) יורדות, והטקסט נדרס ב-syncFrom
    await query(
      `with gone as (delete from content_assets where content_id = $1 returning storage_key)
       insert into media_trash (bucket, storage_key, delete_after)
       select $2, storage_key, now() + make_interval(days => $3)
         from gone where storage_key is not null
       on conflict (bucket, storage_key) do nothing`,
      [targetItem.id, process.env.R2_PUBLIC_BUCKET ?? '', TRASH_DAYS]);
    await query(
      `delete from content_variants v using content_items ci
        where ci.id = v.content_id and ci.id = $1 and v.channel_id <> ci.slot_channel_id`,
      [targetItem.id]);
    await uniqueOr409(() => query(
      'update content_items set linked_to_id = $1 where id = $2', [root.id, targetItem.id]),
      'לתוכן הזה כבר יש משבצת מקושרת במדיה הזו');
    followerId = targetItem.id;
  } else {
    const created = await uniqueOr409(() => one(
      `insert into content_items (endpoint_id, campaign_id, kind, title, body, ready_channel_ids,
                                  sort_order, evergreen, reuse_after_days, slot_channel_id,
                                  linked_to_id)
       values ($1,$2,$3,$4,$5,$6::int[],$7,$8,$9,$10,$11) returning id`,
      [root.endpoint_id, root.campaign_id, root.kind, root.title, root.body,
       [target.channel_id], target.sort_order, root.evergreen, root.reuse_after_days,
       target.channel_id, root.id]),
    'המשבצת תפוסה, או שכבר יש לתוכן הזה משבצת מקושרת במדיה הזו');
    followerId = created.id;
  }
  // קישור: הקבוצה מקבלת את מצב המקור (כל משבצת נבדקת לערוץ שלה)
  const { downgraded } = await syncFrom(root.id, { statusChanged: true });

  const source = await one('select * from content_items where id = $1', [root.id]);
  const follower = await one('select * from content_items where id = $1', [followerId]);
  return { source, follower, downgraded };
}
