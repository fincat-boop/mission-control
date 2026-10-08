/**
 * הטעינה מהמסד של מה ש-capacity.js מחשב עליו. capacity.js טהור (בלי מסד);
 * כאן רק השאילתות, כדי שהמנוע, הרשת, האזהרות והלוח יטענו את אותן שורות
 * באותה צורה — ולא כל אחד גרסה משלו.
 *
 * הקובץ לא מייבא שום מודול של המנוע או של הנתיבים, כדי שכל אחד מהם יוכל
 * לייבא אותו בלי מעגל.
 */

import { one, rows } from './db.js';
import { channelEndpoints } from './capacity.js';
import { postIsLiveSql } from './live.js';

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

/**
 * תוכן שוטף (בלי קמפיין) שעוד יכול לצאת בכל ערוץ — לכל ערוץ, אילו נקודות
 * מתחרות בו בזכות תוכן שוטף (channelEndpoints, סעיף 5): גרסה מוכנה או טיוטה
 * לערוץ, נקודה פעילה, ועוד לא היה לו פוסט בערוץ (או evergreen — הוא חוזר).
 */
export const STANDALONE_SQL = `select v.channel_id, ci.endpoint_id
    from content_items ci
    join content_variants v on v.content_id = ci.id and v.status in ('ready','draft')
    join endpoints e        on e.id = ci.endpoint_id and e.active
   where ci.campaign_id is null
     and (ci.evergreen or not exists (
           select 1 from posts p where p.content_id = ci.id and p.channel_id = v.channel_id
              and p.status <> 'hole'))
   group by v.channel_id, ci.endpoint_id`;

/** STANDALONE_SQL כמפה: ערוץ → Set של נקודות */
export async function loadStandalone() {
  const out = new Map();
  for (const r of await rows(STANDALONE_SQL)) {
    if (!out.has(r.channel_id)) out.set(r.channel_id, new Set());
    out.get(r.channel_id).add(r.endpoint_id);
  }
  return out;
}

/**
 * כל מה ש-effectiveGap צריך כדי לגזור את המרווח בכל ערוץ בטווח [from, to]
 * (gapOn): ההגדרות, הערוצים, ומי מתחרה בכל ערוץ (channelEndpoints). מי
 * שכבר טען הגדרות / קמפיינים מעביר אותם, כדי לא לטעון פעמיים.
 * @returns {Promise<{settings:object|null, channels:Map<number, object>,
 *                    endpoints:Map<number, Map<number, (number|null)[]>>}>}
 */
export async function loadGapContext(from, to, { settings = undefined, campaigns = null } = {}) {
  const s = settings === undefined ? await one('select * from engine_settings limit 1') : settings;
  const channels = await rows('select * from channels order by id');
  const list = campaigns ?? await rows(CAMPAIGNS_WEIGHTED_SQL);
  const standalone = await loadStandalone();
  return {
    settings: s,
    channels: new Map(channels.map((ch) => [ch.id, ch])),
    endpoints: channelEndpoints(list, standalone, { from, to }),
  };
}

/** הסטטוסים של פוסט שתופס שטח — כמו LIVE_STATUSES במנוע */
const AIR_STATUSES = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];

/**
 * כמה פוסטים "באוויר" בחלון [from, to] (תאריכים, כולל) לכל נקודה × ערוץ ×
 * קמפיין (campaign_id null — תוכן שוטף / בלי תוכן). זה ה"בפועל" שהמנוע רודף
 * בפיגור מהנתח (computeDebts) ושמסך האסטרטגיה מציג (currentAllocation, סעיף
 * 34) — שאילתה אחת לשניהם.
 *
 * נספר: מה שפורסם (לפי מתי שפורסם), ומה שעוד חי על הלוח — מתוכנן / מאושר /
 * ממתין / בפרסום / נכשל (לפי המועד), כולל "לא סומנו כפורסמו" (מתוכנן שהמועד שלו
 * עבר, UNCONFIRMED_SQL) — לא ידוע ≠ לא יצא. שיבוץ מוחזק (postIsLiveSql — קמפיין
 * מושהה, ערוץ / נקודה מושבתים) לא נספר, אלא אם כבר פורסם.
 * published — מתוכם מה שסומן פורסם.
 * @returns {Promise<{endpoint_id:number, channel_id:number, campaign_id:number|null,
 *                    n:number, published:number}[]>}
 */
export function airCounts(from, to) {
  return rows(
    `select p.endpoint_id, p.channel_id, ci.campaign_id, count(*)::int as n,
            count(*) filter (where p.status = 'published')::int as published
       from posts p
       left join content_items ci on ci.id = p.content_id
      where p.endpoint_id is not null
        and p.status = any($3::text[])
        and (p.status = 'published' or ${postIsLiveSql('p')})
        -- פוסט שפורסם נספר לפי מתי שפורסם, אחר — לפי מתי שמתוכנן. שני תנאים
        -- נפרדים ולא coalesce, כדי שהאינדקסים על published_at ו-scheduled_at ישמשו
        and ((p.published_at >= $1::date and p.published_at < ($2::date + 1))
          or (p.published_at is null
              and p.scheduled_at >= $1::date and p.scheduled_at < ($2::date + 1)))
      group by p.endpoint_id, p.channel_id, ci.campaign_id`,
    [from, to, AIR_STATUSES]
  );
}
