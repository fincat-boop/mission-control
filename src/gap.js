/**
 * המרווח המינימלי בין שני פרסומים של אותה נקודת קצה באותה מדיה.
 *
 * המנוע מכבד את min_gap_days מאז ומתמיד, אבל שיבוץ ידני עקף אותו בשקט:
 * אפשר היה לגרור פוסט ליום שאחרי פוסט קיים והמערכת לא אמרה מילה.
 *
 * הבחירה כאן היא אזהרה ולא חסימה. שיבוץ צמוד הוא לפעמים בדיוק מה שרוצים
 * (השקה, מבצע), ולכן המערכת מראה את מה שהיא יודעת ונותנת להחליט — בניגוד
 * לכללים שהם באמת שגיאה, כמו שני פוסטים לאותה נקודה באותו יום.
 */

import { one } from './db.js';
import { ymd } from './board.js';

const LIVE = "('scheduled','published','pending_approval')";

/**
 * @returns {null | {days:number, min:number, other:object, channel_name:string, message:string}}
 */
export async function gapWarning({ endpointId, channelId, when, excludePostId = null }) {
  if (!endpointId || !channelId || !when) return null;

  const settings = await one('select min_gap_days from engine_settings limit 1');
  const min = settings?.min_gap_days ?? 7;
  if (min <= 0) return null;

  // השכן הקרוב ביותר בזמן, לפני או אחרי — מרווח נמדד לשני הכיוונים
  const near = await one(
    `select p.id, p.title, p.scheduled_at, c.name as channel_name,
            abs(p.scheduled_at::date - $3::date) as days
       from posts p join channels c on c.id = p.channel_id
      where p.endpoint_id = $1 and p.channel_id = $2
        and p.status in ${LIVE}
        and ($4::int is null or p.id <> $4)
        and abs(p.scheduled_at::date - $3::date) between 1 and $5
      order by days, p.scheduled_at
      limit 1`,
    [endpointId, channelId, when, excludePostId, min - 1]
  );
  if (!near) return null;

  const days = Number(near.days);
  return {
    days,
    min,
    other: { id: near.id, title: near.title, scheduled_at: near.scheduled_at },
    channel_name: near.channel_name,
    message: days === 1
      ? `יש כבר פוסט לאותה נקודת קצה ב${near.channel_name} יום לפני או אחרי ` +
        `("${near.title}", ${ymd(new Date(near.scheduled_at))}). ` +
        `המרווח שהוגדר הוא ${min} ימים.`
      : `יש כבר פוסט לאותה נקודת קצה ב${near.channel_name} במרחק ${days} ימים ` +
        `("${near.title}", ${ymd(new Date(near.scheduled_at))}). ` +
        `המרווח שהוגדר הוא ${min} ימים.`,
  };
}
