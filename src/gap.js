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
import { weekMeta, ymd } from './board.js';
import { effectiveGap } from './capacity.js';
import { LINK_LIVE_STATUSES } from './engine.js';

const LIVE = "('scheduled','approved','publishing','failed','published','pending_approval')";
const LIVE_LIST = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];

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
 * המרווח שחל על פוסט: של הקמפיין שהתוכן שלו שייך אליו (campaignId, או
 * contentId → הקמפיין של התוכן), ובלעדיו ברירת המחדל הכללית. פוסט בלי
 * קמפיין (מבצע דחוף, פוסט ידני בלי תוכן) — הכללי.
 * @returns {Promise<{min:number, campaign:{id:number,name:string}|null}>}
 *          campaign — רק כשהמרווח בא ממנו
 */
export async function gapFor({ campaignId = null, contentId = null } = {}) {
  let c = null;
  if (campaignId) {
    c = await one('select id, name, min_gap_days from campaigns where id = $1', [campaignId]);
  } else if (contentId) {
    c = await one(
      `select ca.id, ca.name, ca.min_gap_days
         from content_items ci join campaigns ca on ca.id = ci.campaign_id
        where ci.id = $1`, [contentId]);
  }
  if (c?.min_gap_days != null) {
    return { min: effectiveGap(c, null), campaign: { id: c.id, name: c.name } };
  }
  return { min: await loadGapDays(), campaign: null };
}

/**
 * השכן הקרוב (לפני או אחרי) של אותה נקודה באותו ערוץ, כשהוא בתוך המרווח.
 * המרווח לפי הקמפיין של הפוסט שזז/נוצר (gapFor) — campaignId או contentId,
 * מה שבידי הקורא.
 * @returns {null | {days:number, min:number, other:object, channel_name:string, message:string}}
 */
export async function gapWarning({ endpointId, channelId, when, excludePostId = null,
                                   campaignId = null, contentId = null }) {
  if (!endpointId || !channelId || !when) return null;

  const { min, campaign } = await gapFor({ campaignId, contentId });
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
  const rule = campaign
    ? `המרווח שהוגדר לקמפיין "${campaign.name}" הוא ${min} ימים.`
    : `המרווח שהוגדר הוא ${min} ימים.`;
  return {
    days,
    min,
    other: { id: near.id, title: near.title, scheduled_at: near.scheduled_at },
    channel_name: near.channel_name,
    message: days === 1
      ? `יש כבר פוסט לאותה נקודת קצה ב${near.channel_name} יום לפני או אחרי ` +
        `("${near.title}", ${ymd(new Date(near.scheduled_at))}). ${rule}`
      : `יש כבר פוסט לאותה נקודת קצה ב${near.channel_name} במרחק ${days} ימים ` +
        `("${near.title}", ${ymd(new Date(near.scheduled_at))}). ${rule}`,
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
 * פוסט מקושר (אותה קבוצת קישור — מקור ועוקבות) שכבר יוצא באותו יום, בכל
 * ערוץ, כשהקמפיין מבקש שפוסטים מקושרים לא ייצאו יחד (links_apart, ברירת
 * מחדל כן). המנוע לא משבץ כך; ביד — אזהרה שאפשר לאשר, כמו המרווח.
 * "יום" = יום בלוח של ישראל, כמו בשאר המנוע. אותו פריט בערוץ אחר לא נחשב.
 * @returns {null | {other:object, channel_name:string, message:string}}
 */
export async function linkDayWarning({ contentId, when, excludePostId = null }) {
  if (!contentId || !when) return null;
  const near = await one(
    `with me as (
       select ci.id, coalesce(ci.linked_to_id, ci.id) as root, ca.name as campaign_name
         from content_items ci left join campaigns ca on ca.id = ci.campaign_id
        where ci.id = $1 and coalesce(ca.links_apart, true))
     select p.id, p.title, p.scheduled_at, c.name as channel_name, me.campaign_name
       from me
       join content_items ci on coalesce(ci.linked_to_id, ci.id) = me.root and ci.id <> me.id
       join posts p          on p.content_id = ci.id
       join channels c       on c.id = p.channel_id
      where p.status = any($4)
        and ($3::int is null or p.id <> $3)
        and (p.scheduled_at at time zone 'Asia/Jerusalem')::date
          = ($2::timestamptz at time zone 'Asia/Jerusalem')::date
      order by p.scheduled_at, p.id
      limit 1`,
    [contentId, when, excludePostId, LINK_LIVE_STATUSES]
  );
  if (!near) return null;
  const rule = near.campaign_name
    ? ` בקמפיין "${near.campaign_name}" פוסטים מקושרים לא יוצאים באותו יום.`
    : '';
  return {
    other: { id: near.id, title: near.title, scheduled_at: near.scheduled_at },
    channel_name: near.channel_name,
    message: `פוסט מקושר ("${near.title}", ${near.channel_name}) כבר יוצא באותו יום.${rule}`,
  };
}

const KIND_HE = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };
const KIND_CAP = { promo: 'max_promo_per_week', value: 'max_value_per_week',
                   hybrid: 'max_hybrid_per_week' };

/**
 * פוסט ידני שחורג מהמכסות שהמנוע מכבד: פוסטים בשבוע בערוץ (max_per_week —
 * התקרה, כולל השטח ששמור לדחופים), תקרה לסוג בערוץ (max_*_per_week) ומכירתי
 * ליום בכל הערוצים (max_promo_per_day). השבוע — ראשון עד שבת, כמו בלוח.
 * נספרים הפוסטים החיים (LIVE), בלי הפוסט עצמו (excludePostId).
 *
 * פוסט שזז בתוך אותה משבצת (אותו ערוץ ושבוע / אותו סוג / אותו יום) כבר היה
 * נספר בה — ואז אין אזהרה, גם אם המשבצת כבר מעל המכסה (אושרה קודם). אחרת
 * כל הזזה בתוך שבוע מלא הייתה שואלת שוב.
 * @returns {null | {caps:string[], message:string}}
 */
export async function capWarning({ channelId, when, kind, excludePostId = null }) {
  if (!channelId || !when) return null;
  const ch = await one(
    `select name, max_per_week, max_promo_per_week, max_value_per_week, max_hybrid_per_week
       from channels where id = $1`, [channelId]);
  if (!ch) return null;

  const week = weekMeta(when);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);
  const day = ymd(new Date(when));

  const cur = excludePostId
    ? await one('select channel_id, kind, status, scheduled_at from posts where id = $1', [excludePostId])
    : null;
  const curLive = cur && LIVE_LIST.includes(cur.status);
  const curAt = curLive ? new Date(cur.scheduled_at) : null;
  const sameWeek = curLive && cur.channel_id === Number(channelId) && curAt >= from && curAt <= to;

  const n = await one(
    `select count(*)::int as total,
            count(*) filter (where kind = $5)::int as of_kind
       from posts
      where channel_id = $1 and status = any($4)
        and scheduled_at >= $2 and scheduled_at <= $3
        and ($6::int is null or id <> $6)`,
    [channelId, from, to, LIVE_LIST, kind ?? null, excludePostId]
  );

  const out = [];
  const max = Number(ch.max_per_week ?? 0);
  if (!sameWeek && max > 0 && n.total >= max) {
    out.push(`בשבוע הזה כבר ${n.total} מתוך ${max} פוסטים בשבוע ב${ch.name}.`);
  }
  const cap = kind ? ch[KIND_CAP[kind]] : null;
  if (cap != null && !(sameWeek && cur.kind === kind) && n.of_kind >= cap) {
    out.push(`בשבוע הזה כבר ${n.of_kind} מתוך ${cap} פוסטים מסוג ${KIND_HE[kind]} ב${ch.name}.`);
  }
  if (kind === 'promo') {
    const s = await one('select max_promo_per_day from engine_settings limit 1');
    const perDay = s?.max_promo_per_day ?? 1;
    const sameDay = curLive && cur.kind === 'promo' && ymd(curAt) === day;
    const d = await one(
      `select count(*)::int as n from posts
        where kind = 'promo' and status = any($2)
          and (scheduled_at at time zone 'Asia/Jerusalem')::date
            = ($1::timestamptz at time zone 'Asia/Jerusalem')::date
          and ($3::int is null or id <> $3)`,
      [when, LIVE_LIST, excludePostId]
    );
    if (!sameDay && d.n >= perDay) {
      out.push(`ביום הזה כבר ${d.n === 1 ? 'פוסט מכירתי אחד' : `${d.n} פוסטים מכירתיים`} ` +
               `בכל הערוצים, והמקסימום ליום הוא ${perDay}.`);
    }
  }
  if (!out.length) return null;
  return { caps: out, message: out.join('\n') };
}

/**
 * מאחד אזהרות רכות לתשובת 409 אחת — כך שאישור אחד (confirm_warnings, או
 * confirm_gap הוותיק) מכסה את כולן, ולא נוצר מצב של אישור, ושוב 409 על
 * אזהרה אחרת.
 */
export function softWarning(...warnings) {
  const list = warnings.filter(Boolean);
  if (!list.length) return null;
  return { ...list[0], message: list.map((w) => w.message).join('\n\n'), all: list };
}

/** האם הבקשה מאשרת את האזהרות הרכות (שם חדש, והוותיק שהלקוח עוד שולח) */
export const warningsConfirmed = (b) => !!(b?.confirm_warnings || b?.confirm_gap);
