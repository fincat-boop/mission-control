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
import { effectiveGap } from './capacity.js';

const LIVE = "('scheduled','approved','publishing','failed','published','pending_approval')";

/**
 * ברירת המחדל הכללית למרווח — engine_settings.min_gap_days (ברירת מחדל 7).
 * המקום היחיד שקורא אותה מהמסד בשביל מי שאין לו כבר את שורת ההגדרות
 * (הרשת, ההעלאה המרוכזת, האזהרות); המנוע וההזזה טוענים את כל השורה ממילא
 * ומעבירים אותה ל-effectiveGap.
 */
export async function loadGapDays() {
  const s = await one('select min_gap_days from engine_settings limit 1');
  return effectiveGap(null, s);
}

/**
 * @returns {null | {days:number, min:number, other:object, channel_name:string, message:string}}
 */
export async function gapWarning({ endpointId, channelId, when, excludePostId = null }) {
  if (!endpointId || !channelId || !when) return null;

  const min = await loadGapDays();
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

/**
 * פוסט של קמפיין שזז (או נוצר) מחוץ לחלון התאריכים של הקמפיין.
 *
 * המנוע לא משבץ תוכן של קמפיין מחוץ לחלון שלו, אבל ביד זה לפעמים בדיוק
 * מה שרוצים (חימום לפני השקה, תזכורת אחרי) — ולכן כאן אזהרה שאפשר לאשר,
 * כמו המרווח, ולא חסימה.
 *
 * @returns {null | {campaign:object, message:string}}
 */
export async function campaignWindowWarning({ contentId, when }) {
  if (!contentId || !when) return null;
  const c = await one(
    `select ca.id, ca.name, ca.starts_on, ca.ends_on
       from content_items ci join campaigns ca on ca.id = ci.campaign_id
      where ci.id = $1`,
    [contentId]
  );
  if (!c || (!c.starts_on && !c.ends_on)) return null;

  const day = ymd(new Date(when));
  const before = c.starts_on && day < c.starts_on;
  const after = c.ends_on && day > c.ends_on;
  if (!before && !after) return null;

  const fmt = (s) => `${Number(s.slice(8, 10))}.${Number(s.slice(5, 7))}`;
  const range = c.starts_on && c.ends_on ? `${fmt(c.starts_on)}–${fmt(c.ends_on)}`
              : c.starts_on ? `מ-${fmt(c.starts_on)}` : `עד ${fmt(c.ends_on)}`;
  return {
    campaign: { id: c.id, name: c.name, starts_on: c.starts_on, ends_on: c.ends_on },
    message: `הפוסט שייך לקמפיין "${c.name}" שרץ ${range}, ` +
             `והתאריך ${fmt(day)} ${before ? 'לפני תחילת' : 'אחרי סוף'} הקמפיין.`,
  };
}

/**
 * מאחד אזהרות רכות לתשובת 409 אחת — כך שאישור אחד (confirm_gap) מכסה את
 * כולן, ולא נוצר מצב של אישור, ושוב 409 על אזהרה אחרת.
 */
export function softWarning(...warnings) {
  const list = warnings.filter(Boolean);
  if (!list.length) return null;
  return { ...list[0], message: list.map((w) => w.message).join('\n\n'), all: list };
}
