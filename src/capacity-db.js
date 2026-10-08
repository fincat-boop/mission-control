/**
 * הטעינה מהמסד של מה ש-capacity.js מחשב עליו. capacity.js טהור (בלי מסד);
 * כאן רק השאילתות, כדי שהמנוע, הרשת, האזהרות והלוח יטענו את אותן שורות
 * באותה צורה — ולא כל אחד גרסה משלו.
 *
 * הקובץ לא מייבא שום מודול של המנוע או של הנתיבים, כדי שכל אחד מהם יוכל
 * לייבא אותו בלי מעגל.
 */

/**
 * הערוצים של כל קמפיין כעמודה בשורה — siblingsOf ו-normalizeSharesByChannel
 * (capacity.js) סופרים לפיה מי יושב על כל ערוץ.
 */
export const CHANNEL_IDS_SQL = `(select coalesce(array_agg(cc.channel_id order by cc.channel_id), '{}')
     from campaign_channels cc where cc.campaign_id = c.id) as channel_ids`;

/**
 * הקמפיינים עם החשיבות של נקודת הקצה שלהם והערוצים שלהם — הרשימה ש-shareOf
 * מחלק ביניהם ו-siblingsOf סופר בה. כל מי שמחשב נתח או צורך
 * (channelNeeds, המנוע) טוען דרכה. endpoint_active — קמפיין של נקודה מושבתת
 * לא מתחרה על שטח, כמו קמפיין מושהה (normalizeShares, סעיף 16).
 */
export const CAMPAIGNS_WEIGHTED_SQL = `select c.*, e.importance as endpoint_importance,
       e.active as endpoint_active,
       ${CHANNEL_IDS_SQL}
  from campaigns c join endpoints e on e.id = c.endpoint_id`;
