import { query, rows, one } from './db.js';
import { weekMeta, ymd } from './board.js';
import {
  addGroupDay, buildUsage, COMPLETE_SPREAD_COLUMNS, contentGap, LINK_LIVE_STATUSES, linkDayTaken,
  nearestDays, outsideCampaignWindow,
} from './engine.js';
import { effectiveGap } from './capacity.js';

/**
 * הזזת קמפיין בזמן (שינוי תאריך היעד לפוסט הראשון בעריכה) גוררת איתה את
 * הפוסטים שלו — אבל רק לאן שהמנוע עצמו היה מסכים לשבץ אותם.
 *
 * קודם זה היה update גורף של scheduled_at + N ימים: הזזה אחורה הנחיתה פוסטים
 * בעבר (מאושר היה יוצא מיד או נכשל כ"מאוחר מדי"), וכל הזזה יכלה לנחות על
 * יום חסום, על יום שכבר יש בו פוסט של אותה נקודה באותו ערוץ, בתוך המרווח,
 * מעבר לתקרה השבועית, ביום של פוסט מקושר או מחוץ לחלון החדש.
 *
 * עכשיו כל פוסט זז רק אם המועד החדש עוד לא עבר (היום — השעה העגולה הבאה,
 * כמו במנוע) ועובר את הכללים הקשיחים של המנוע. פוסט שלא עובר
 * יורד מהלוח (שורת הפוסט נמחקת, התוכן נשאר), והמילוי של הקמפיין שרץ מיד
 * אחר כך משבץ את התוכן שלו מחדש לפי הכללים. מאושר שירד מאבד את האישור —
 * המילוי משבץ אותו כמתוכנן.
 */

/** מה זז עם הקמפיין: מה שעוד לא יצא. פורסם / בפרסום — לעולם לא זזים */
export const SHIFT_STATUSES = ['scheduled', 'approved', 'failed', 'pending_approval'];

/** הסטטוסים שתופסים מקום על הלוח — אותם שהמנוע סופר (existing ב-planWeek) */
const ON_BOARD = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];

/** שעת ברירת המחדל והשעה המאוחרת ביותר שהמנוע משבץ בהן — כמו ב-planWeek */
const DEFAULT_HOUR = 10;
const LAST_HOUR = 22;

/**
 * מתכנן את ההזזה (טהורה).
 *
 * moving — הפוסטים של הקמפיין שזזים (SHIFT_STATUSES, עתידיים), עם עמודות
 *   התוכן והקמפיין שהמנוע צריך (contentGap, outsideCampaignWindow,
 *   links_apart): campaign_id, campaign_min_gap_days, campaign_starts_on/
 *   ends_on (החדשים), עמודות קמפיין מוכן, content_id, linked_to_id,
 *   campaign_links_apart.
 * fixed — כל שאר הפוסטים החיים סביב התאריכים החדשים (גם של הקמפיין עצמו
 *   שלא זזים — היסטוריה, פורסם). מולם נבדק כל פוסט, ומול מה שכבר התקבל
 *   לפניו — כך שגם הפוסטים של הקמפיין נבדקים זה מול זה: בהזזה אחידה זה
 *   כמעט תמיד עובר, ובבדיקה בלי הזזה (days = 0, revalidateCampaignPosts) זה
 *   מה שתופס מרווח שגדל או זוג מקושר באותו יום.
 * channels — כל הערוצים (גם לא פעילים: פוסט על ערוץ כבוי לא יורד בגלל זה).
 *
 * @returns {{moves:{post:object, at:Date}[], drops:object[]}}
 */
export function planCampaignShift({ moving, fixed, channels, settings, days, now = new Date() }) {
  const today = ymd(now);
  const dayOf = (p) => ymd(new Date(p.scheduled_at));
  // רק הכללים הקשיחים של התקרה: תקציב הערוץ, ימים חסומים, תקרות לסוג
  // ומכירתי ליום — בלי שער היחס (min_value_per_promo), שאיננו חלק מהכלל
  // הזה וקמפיין מכירתי היה יורד בגללו כולו מהלוח
  const hard = { ...(settings ?? {}), min_value_per_promo: 0 };

  // התקרה השבועית לפי שבועות הלוח — usage של המנוע לכל שבוע, מהפוסטים הקבועים בו
  const weeks = new Map();
  const usageFor = (dateKey) => {
    const wk = weekMeta(`${dateKey}T12:00:00`).start;
    if (!weeks.has(wk)) {
      const inWeek = fixed.filter((p) => weekMeta(new Date(p.scheduled_at)).start === wk);
      weeks.set(wk, buildUsage(channels, inWeek, hard));
    }
    return weeks.get(wk);
  };

  // הימים התפוסים לכל נקודה×ערוץ (אותו יום + מרווח), וימי קבוצות הקישור
  const pairs = new Map();
  const addPair = (p, key) => {
    if (!p.endpoint_id) return;
    const k = `${p.endpoint_id}:${p.channel_id}`;
    pairs.set(k, [...(pairs.get(k) ?? []), key]);
  };
  const groupDays = new Map();
  const root = (p) => p.linked_to_id ?? p.content_id;
  for (const p of fixed) {
    addPair(p, dayOf(p));
    if (p.content_id && LINK_LIVE_STATUSES.includes(p.status)) {
      addGroupDay(groupDays, root(p), p.content_id, dayOf(p));
    }
  }

  const moves = [];
  const drops = [];
  const order = [...moving].sort((a, b) =>
    new Date(a.scheduled_at) - new Date(b.scheduled_at) || a.id - b.id);
  for (const p of order) {
    const at = new Date(p.scheduled_at);
    // setDate ולא +N×24 שעות — השעה המקומית נשמרת גם במעבר שעון
    at.setDate(at.getDate() + days);
    let key = ymd(at);
    if (at <= now) {
      // היום, אחרי שהשעה עברה — השעה העגולה הבאה, כמו במנוע. יום שעבר — לא
      if (key !== today) { drops.push(p); continue; }
      at.setHours(Math.max(DEFAULT_HOUR, now.getHours() + 1), 0, 0, 0);
      key = ymd(at);
      if (key !== today || at.getHours() > LAST_HOUR) { drops.push(p); continue; }
    }
    const usage = usageFor(key);
    const list = p.endpoint_id ? pairs.get(`${p.endpoint_id}:${p.channel_id}`) ?? [] : [];
    const fits =
      !outsideCampaignWindow(p, key) &&
      // יום חסום, תקציב שבועי של הערוץ, תקרה לסוג, מכירתי ליום
      usage.allows(p.channel_id, key, p.kind) &&
      // אותה נקודה, אותו ערוץ, אותו יום — ומרווח מהשכן הקרוב לשני הכיוונים
      !list.includes(key) &&
      nearestDays(list, key) >= contentGap(p, settings) &&
      !(p.content_id && p.campaign_links_apart !== false &&
        linkDayTaken(groupDays, root(p), p.content_id, key));
    if (!fits) { drops.push(p); continue; }

    // שעה תפוסה באותו ערוץ באותו יום — השעה הפנויה הבאה, כמו במנוע
    let hour = at.getHours();
    while (usage.hourTaken(p.channel_id, key, hour) && hour < LAST_HOUR) hour += 1;
    if (usage.hourTaken(p.channel_id, key, hour)) { drops.push(p); continue; }
    if (hour !== at.getHours()) at.setHours(hour, 0, 0, 0);

    usage.take(p.channel_id, key, p.kind, hour);
    addPair(p, key);
    if (p.content_id && LINK_LIVE_STATUSES.includes(p.status)) {
      addGroupDay(groupDays, root(p), p.content_id, key);
    }
    moves.push({ post: p, at });
  }
  return { moves, drops };
}

/**
 * מזיז את הפוסטים של הקמפיין ב-days ימים (בתוך הבקשה, אחרי שהקמפיין עצמו
 * כבר נשמר עם התאריכים החדשים, ותחת נעילת המנוע — lockEngine). מה שלא עובר
 * את הכללים יורד מהלוח, והמילוי של הקמפיין שאחרי משבץ אותו מחדש.
 * @returns {Promise<{moved:number, rescheduled:number, approved:number}>}
 *   approved — כמה מאלה שירדו היו מאושרים (יצטרכו אישור מחדש)
 */
export async function shiftCampaignPosts(campaignId, days, now = new Date()) {
  if (!days) return { moved: 0, rescheduled: 0, approved: 0 };
  return reschedule(campaignId, days, now);
}

/**
 * בדיקה מחדש של הפוסטים העתידיים של הקמפיין מול הכללים הקשיחים של המנוע,
 * בלי להזיז אותם בזמן (אותה בדיקה כמו בהזזה, עם 0 ימים). אחרי שינוי שמהדק
 * את הכללים — סיום מוקדם יותר, התחלה מאוחרת יותר בלי הזזה, מרווח גדול יותר,
 * "לא באותו יום" שנדלק, קישור למשבצת שכבר משובצת — פוסט שכבר על הלוח היה
 * נשאר שובר את הכלל, בלי התראה ובלי שמשהו יזיז אותו. מה שלא עובר יורד מהלוח
 * (פורסם / בפרסום — לעולם לא), והמילוי של הקמפיין שאחרי משבץ אותו מחדש.
 * הקורא אחראי לנעילת המנוע (lockEngine) לפני כל כתיבה בבקשה.
 *
 * הסדר: לפי המועד — הפוסט המוקדם נשאר, וזה שאחריו נבדק מולו (המרווח, אותו
 * יום של פוסט מקושר).
 * @returns {Promise<{kept:number, rescheduled:number, approved:number}>}
 *   kept — מה שנשאר במקומו (או זז שעה באותו יום, כששעה תפוסה); approved — כמה
 *   מאלה שירדו היו מאושרים (יצטרכו אישור מחדש)
 */
export async function revalidateCampaignPosts(campaignId, now = new Date()) {
  const { moved, rescheduled, approved } = await reschedule(campaignId, 0, now);
  return { kept: moved, rescheduled, approved };
}

/** ההזזה / הבדיקה עצמה — days = 0: בדיקה בלבד, בלי הזזה בזמן */
async function reschedule(campaignId, days, now) {
  const none = { moved: 0, rescheduled: 0, approved: 0 };
  // רק מה שעוד לא יצא ועוד לא עבר. היסטוריה לא מזיזים.
  const moving = await rows(
    `select p.id, p.channel_id, p.endpoint_id, p.content_id, p.kind, p.status, p.scheduled_at,
            ci.linked_to_id, ci.campaign_id,
            ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
            ca.min_gap_days as campaign_min_gap_days, ca.links_apart as campaign_links_apart,
            ${COMPLETE_SPREAD_COLUMNS}
       from posts p
       join content_items ci on ci.id = p.content_id
       join campaigns ca on ca.id = ci.campaign_id
      where ci.campaign_id = $1
        and p.status = any($2)
        and p.scheduled_at >= $3
      order by p.scheduled_at, p.id`,
    [campaignId, SHIFT_STATUSES, now]);
  if (!moving.length) return none;

  const settings = await one('select * from engine_settings limit 1');
  const channels = await rows('select * from channels');
  // השכנים: שבועות שלמים סביב המועדים החדשים, ועוד המרווח הגדול ביותר
  // שאפשר (30 — התקרה של מרווח קמפיין — או הכללי), כמו במנוע
  const horizon = Math.max(30, effectiveGap(null, settings)) + 7;
  const shifted = moving.map((p) => {
    const d = new Date(p.scheduled_at);
    d.setDate(d.getDate() + days);
    return d;
  });
  const from = new Date(Math.min(...shifted));
  const to = new Date(Math.max(...shifted));
  // שיבוץ של קמפיין מושהה לא תופס מקום (אלא אם פורסם) — כמו existing במנוע
  const fixed = await rows(
    `select p.id, p.channel_id, p.endpoint_id, p.content_id, p.kind, p.status, p.scheduled_at,
            ci.linked_to_id
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca on ca.id = ci.campaign_id
      where p.status = any($1)
        and not (p.id = any($2::int[]))
        and (ca.paused_at is null or p.status = 'published')
        and p.scheduled_at >= $3::timestamptz - make_interval(days => $5)
        and p.scheduled_at <= $4::timestamptz + make_interval(days => $5)`,
    [ON_BOARD, moving.map((p) => p.id), from, to, horizon]);

  const { moves, drops } = planCampaignShift({ moving, fixed, channels, settings, days, now });
  for (const m of moves) {
    // בבדיקה בלי הזזה רוב הפוסטים נשארים בדיוק במקום — אין מה לכתוב
    if (+m.at === +new Date(m.post.scheduled_at)) continue;
    await query('update posts set scheduled_at = $1 where id = $2', [m.at, m.post.id]);
  }
  if (drops.length) {
    // בלי engine_dismissals — המטרה היא שהמילוי שאחרי ישבץ את התוכן מחדש
    await query(
      `delete from posts where id = any($1::int[]) and status not in ('published','publishing')`,
      [drops.map((p) => p.id)]);
  }
  return {
    moved: moves.length,
    rescheduled: drops.length,
    approved: drops.filter((p) => p.status === 'approved').length,
  };
}
