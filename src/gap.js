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

import { one, rows } from './db.js';
import { weekMeta, ymd } from './board.js';
import { effectiveGap, gapOn, MAX_GAP_DAYS, pairGap } from './capacity.js';
import { loadGapContext } from './capacity-db.js';
import { LINK_LIVE_STATUSES, takesRoom, takesRoomSql } from './engine.js';
import { postIsLiveSql } from './live.js';

const LIVE = "('scheduled','approved','publishing','failed','published','pending_approval')";
const LIVE_LIST = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];
// מהחיים — רק מה שתופס מקום: נכשל שהמועד שלו עבר לא עלה לאוויר (takesRoom,
// כמו במנוע), ולכן לא נספר במרווח ובמכסות
const ROOM = takesRoomSql('p');

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
 * contentId → הקמפיין של התוכן), ובלעדיו ברירת המחדל — בערוץ ידוע
 * (channelId + when) נגזרת מהקצב של הערוץ בשבוע של המועד (effectiveGap,
 * סעיף 5), אחרת הכללית. פוסט בלי קמפיין (מבצע דחוף, פוסט ידני בלי תוכן) —
 * ברירת המחדל.
 * @returns {Promise<{min:number, campaign:{id:number,name:string}|null, derived:boolean}>}
 *          campaign — רק כשהמרווח בא ממנו; derived — ברירת המחדל קוצרה לפי הערוץ
 */
export async function gapFor({ campaignId = null, contentId = null, channelId = null,
                               when = null } = {}) {
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
    return { min: effectiveGap(c, null), campaign: { id: c.id, name: c.name }, derived: false };
  }
  const settings = await one('select * from engine_settings limit 1');
  const global = effectiveGap(null, settings);
  if (!channelId || !when) return { min: global, campaign: null, derived: false };
  const week = weekMeta(when);
  const ctx = await loadGapContext(week.start, week.end, { settings });
  const min = effectiveGap(null, settings, gapOn(ctx, channelId));
  return { min, campaign: null, derived: min < global };
}

/**
 * השכן הקרוב (לפני או אחרי) של אותה נקודה באותו ערוץ, כשהוא בתוך המרווח.
 * המרווח לכל שכן — pairGap (capacity.js), אותה פונקציה כמו המנוע
 * (gapViolation): המרווח המפורש של הקמפיין של הפוסט שזז/נוצר (campaignId או
 * contentId) ושל הקמפיין של השכן נספרים שניהם; שכן בלי מרווח מפורש תורם את
 * ברירת המחדל רק כשגם לפוסט אין (D4).
 * @returns {null | {days:number, min:number, other:object, channel_name:string, message:string}}
 */
export async function gapWarning({ endpointId, channelId, when, excludePostId = null,
                                   campaignId = null, contentId = null }) {
  if (!endpointId || !channelId || !when) return null;

  const { min, campaign, derived } = await gapFor({ campaignId, contentId, channelId, when });
  // המרווח המפורש של הפוסט (null — ברירת המחדל, ואז min היא ברירת המחדל בערוץ)
  const own = campaign ? min : null;

  // השכנים בטווח שבו מרווח כלשהו יכול לחול (עד 30 — התקרה של מרווח קמפיין),
  // לפני או אחרי. "יום" = יום בלוח של ישראל בשני הצדדים (כמו sameDayClash
  // והמנוע): ::date לבד לוקח את היום באזור הזמן של החיבור (UTC), ופוסט בין
  // 00:00 ל-03:00 נספר ליום הקודם — המרחק יצא גדול או קטן ביום
  const horizon = Math.max(min, MAX_GAP_DAYS);
  const near = await rows(
    `with x as (
       select p.id, p.title, p.scheduled_at, c.name as channel_name,
              ca.min_gap_days as their_gap, ca.name as their_campaign,
              abs((p.scheduled_at at time zone 'Asia/Jerusalem')::date
                - ($3::timestamptz at time zone 'Asia/Jerusalem')::date) as days
         from posts p join channels c on c.id = p.channel_id
         left join content_items ci on ci.id = p.content_id
         left join campaigns ca     on ca.id = ci.campaign_id
        where p.endpoint_id = $1 and p.channel_id = $2
          and p.status in ${LIVE} and ${ROOM}
          and ($4::int is null or p.id <> $4)
          -- טווח גס סביב המועד (האינדקס), והמרחק המדויק בימי ישראל למטה
          and p.scheduled_at between $3::timestamptz - make_interval(days => $5 + 2)
                                 and $3::timestamptz + make_interval(days => $5 + 2))
     select * from x where days between 1 and $5
      order by days, scheduled_at`,
    [endpointId, channelId, when, excludePostId, horizon]
  );
  const hit = near.map((n) => ({ ...n, need: pairGap(own, n.their_gap, min) }))
    .find((n) => Number(n.days) < n.need);
  if (!hit) return null;

  const days = Number(hit.days);
  const need = hit.need;
  // מי קבע את המרווח: השכן (מפורש וגדול משל הפוסט), הקמפיין של הפוסט, או ברירת המחדל
  const theirs = hit.their_gap != null && Number(hit.their_gap) === need &&
    (own == null || Number(hit.their_gap) > own);
  const rule = theirs
    ? `המרווח שהוגדר לקמפיין "${hit.their_campaign}" של הפוסט השכן הוא ${need} ימים.`
    : campaign
      ? `המרווח שהוגדר לקמפיין "${campaign.name}" הוא ${need} ימים.`
      : derived
        ? `המרווח שהוגדר בערוץ הזה הוא ${need} ימים (נגזר מכמה פוסטים בשבוע הערוץ מפרסם).`
        : `המרווח שהוגדר הוא ${need} ימים.`;
  return {
    days,
    min: need,
    other: { id: hit.id, title: hit.title, scheduled_at: hit.scheduled_at },
    channel_name: hit.channel_name,
    message: days === 1
      ? `יש כבר פוסט לאותה נקודת קצה ב${hit.channel_name} יום לפני או אחרי ` +
        `("${hit.title}", ${ymd(new Date(hit.scheduled_at))}). ${rule}`
      : `יש כבר פוסט לאותה נקודת קצה ב${hit.channel_name} במרחק ${days} ימים ` +
        `("${hit.title}", ${ymd(new Date(hit.scheduled_at))}). ${rule}`,
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
 * נספרים הפוסטים החיים שתופסים מקום (LIVE + takesRoom), בלי הפוסט עצמו (excludePostId).
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
  const curLive = cur && LIVE_LIST.includes(cur.status) && takesRoom(cur);
  const curAt = curLive ? new Date(cur.scheduled_at) : null;
  const sameWeek = curLive && cur.channel_id === Number(channelId) && curAt >= from && curAt <= to;

  // פוסט מוחזק (קמפיין מושהה, ערוץ / נקודה מושבתים — postIsLiveSql) ירד מהלוח
  // ולא תופס מקום (אלא אם כבר פורסם) — כמו במנוע
  const n = await one(
    `select count(*)::int as total,
            count(*) filter (where p.kind = $5)::int as of_kind
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.channel_id = $1 and p.status = any($4) and ${ROOM}
        and (p.status = 'published' or ${postIsLiveSql('p')})
        and p.scheduled_at >= $2 and p.scheduled_at <= $3
        and ($6::int is null or p.id <> $6)`,
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
      `select count(*)::int as n
         from posts p
         left join content_items ci on ci.id = p.content_id
         left join campaigns ca     on ca.id = ci.campaign_id
        where p.kind = 'promo' and p.status = any($2) and ${ROOM}
          and (p.status = 'published' or ${postIsLiveSql('p')})
          and (p.scheduled_at at time zone 'Asia/Jerusalem')::date
            = ($1::timestamptz at time zone 'Asia/Jerusalem')::date
          and ($3::int is null or p.id <> $3)`,
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
