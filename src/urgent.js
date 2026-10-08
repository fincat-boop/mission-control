import { one, rows } from './db.js';
import { weekMeta, weekStart, ymd } from './board.js';
import { gapWarning } from './gap.js';
import { takesRoomSql } from './engine.js';
import { urgentReserve } from '../public/js/core/reserve.js';

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DEFAULT_TIME = '10:00';
// השעה האחרונה ביום שבה עוד משבצים "היום" — מאוחר מזה עוברים למחר
export const LAST_URGENT_HOUR = 21;

const pad = (n) => String(n).padStart(2, '0');

/** "HH:MM" תקין → [h, m]; אחרת null */
export function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? [h, min] : null;
}

/**
 * מתי לשבץ ביום נתון: בשעה שנבחרה, אם היא עוד לא עברה. היום, כשהשעה כבר
 * עברה — השעה העגולה הבאה (לפחות רבע שעה מעכשיו), עד LAST_URGENT_HOUR.
 * null = אין מועד ביום הזה (עבר, או מאוחר מדי היום) — עוברים ליום הבא.
 */
export function urgentSlotTime(day, [h, m], now = new Date()) {
  const at = new Date(day);
  at.setHours(h, m, 0, 0);
  if (at.getTime() > now.getTime()) return at;
  if (ymd(day) !== ymd(now)) return null;
  const next = new Date(now.getTime() + 15 * 60000);
  if (next.getMinutes() || next.getSeconds() || next.getMilliseconds()) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  }
  return ymd(next) === ymd(now) && next.getHours() <= LAST_URGENT_HOUR ? next : null;
}

/**
 * "מה יקרה" של מבצע דחוף: מחפש לכל ערוץ מבוקש את היום הקרוב ביותר
 * שבו עוד יש שטח, בלי לדחוף שום דבר מתוכנן.
 *
 * @param {{title?:string, until?:string, channel_ids?:number[], endpoint_id?:number}} input
 * @param {{now?:Date}} [opts] now — לבדיקות; ברירת מחדל: עכשיו
 */
export async function planUrgent(input, { now = new Date() } = {}) {
  const title = String(input.title ?? '').trim();
  const channelIds = (input.channel_ids ?? []).map(Number).filter(Boolean);

  const errors = [];
  if (!title) errors.push('צריך לכתוב מה מפרסמים');
  if (channelIds.length === 0) errors.push('צריך לבחור לפחות ערוץ אחד');
  // אין פוסט בלי נקודת קצה (החלטת המשתמש 8.10.26) — גם לא במבצע דחוף
  const endpointId = Number(input.endpoint_id) || null;
  if (!endpointId) errors.push('צריך לבחור נקודת קצה');

  const until = input.until ? new Date(input.until) : null;
  if (until && Number.isNaN(until.getTime())) errors.push('תאריך "רלוונטי עד" לא תקין');
  const hm = parseTime(input.time || DEFAULT_TIME);
  if (!hm) errors.push('שעה לא תקינה');
  if (errors.length) return { ok: false, errors, placements: [], warnings: [], displaced: [] };

  const ep = await one('select active from endpoints where id = $1', [endpointId]);
  if (!ep?.active) {
    return { ok: false, errors: [ep ? 'נקודת הקצה שנבחרה מושבתת' : 'לא נמצאה נקודת קצה כזו'],
             placements: [], warnings: [], displaced: [] };
  }

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const lastDay = until ?? new Date(today.getTime() + 6 * 86400000);
  lastDay.setHours(23, 59, 59, 999);
  if (lastDay < today) {
    return { ok: false, errors: ['התאריך שנבחר כבר עבר'], placements: [], warnings: [], displaced: [] };
  }

  const settings = await one('select * from engine_settings limit 1');
  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;

  const channels = await rows(
    'select * from channels where active = true and id = any($1::int[]) order by sort_order, id',
    [channelIds]
  );
  if (channels.length === 0) {
    return { ok: false, errors: ['הערוצים שנבחרו לא פעילים'], placements: [], warnings: [], displaced: [] };
  }

  // כל מה שכבר משובץ בשבועות שהמבצע יכול לנחות בהם: מתחילת השבוע של היום
  // ועד סוף השבוע של היום האחרון — המכסה השבועית נספרת על כל השבוע, ולא רק
  // עד lastDay (קודם: דחוף עד שני בשבוע שמלא שלישי–שבת עוד נכנס לשני).
  // נכשל שהמועד שלו עבר לא עלה לאוויר ולא תופס מקום (takesRoom, כמו במנוע)
  const countFrom = weekStart(today);
  const countTo = new Date(weekMeta(lastDay).endDate);
  countTo.setHours(23, 59, 59, 999);
  const existing = await rows(
    `select id, channel_id, endpoint_id, kind, scheduled_at, urgent
       from posts p
      where status in ('scheduled','approved','publishing','failed','published','pending_approval')
        and ${takesRoomSql('p', '$3::timestamptz')}
        and scheduled_at >= $1 and scheduled_at <= $2`,
    [countFrom, countTo, now]
  );

  // אותה נקודת קצה לא מקבלת שני פוסטים באותה מדיה באותו יום —
  // אחרת מבצע דחוף יכול לנחות על יום שכבר יש בו תוכן ערך לאותה נקודה
  const sameDay = new Set(
    existing
      .filter((p) => p.endpoint_id && p.endpoint_id === endpointId)
      .map((p) => `${p.channel_id}:${ymd(new Date(p.scheduled_at))}`)
  );

  // ימי המועמדות: מהיום ועד התאריך האחרון
  const days = [];
  for (let d = new Date(today); d <= lastDay; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  const placements = [];
  const warnings = [];
  // שיבוצים שכבר תכננו בריצה הזו — נספרים יחד עם הקיים
  const planned = [];

  const countIn = (pred) => existing.filter(pred).length + planned.filter(pred).length;

  for (const ch of channels) {
    let placed = null;
    // למה כל יום נפסל — ההודעה כשלא נמצא יום אומרת את הסיבה, לא "הערוץ מלא" תמיד
    const why = new Map();
    const skip = (r) => why.set(r, (why.get(r) ?? 0) + 1);

    for (const day of days) {
      const dayKey = ymd(day);
      const wkKey = ymd(weekStart(day));

      if (endpointId && sameDay.has(`${ch.id}:${dayKey}`)) { skip('same_day'); continue; }

      // היום, כשהשעה כבר עברה — השעה העגולה הבאה; מאוחר מדי — מחר
      const at = urgentSlotTime(day, hm, now);
      if (!at) { skip('time'); continue; }

      // יום שהוגדר כחסום למדיה הזו — גם דחוף לא נכנס אליו
      if ((ch.blocked_days ?? []).includes(day.getDay())) { skip('blocked_day'); continue; }

      // דחוף נכנס גם לשמורה (max_per_week כולו, לא רק התקציב של המנוע)
      const inSameWeek = (p) =>
        p.channel_id === ch.id && ymd(weekStart(new Date(p.scheduled_at))) === wkKey;
      const usedThisWeek = countIn(inSameWeek);
      if (usedThisWeek >= ch.max_per_week) {
        // השמורה "בשימוש" רק כשיש באותו שבוע מבצע דחוף שתופס אותה
        skip(existing.some((p) => inSameWeek(p) && p.urgent) || planned.some(inSameWeek)
          ? 'full_urgent' : 'full');
        continue;
      }

      if (ch.max_promo_per_week != null) {
        const promoThisWeek = countIn((p) => inSameWeek(p) && p.kind === 'promo');
        if (promoThisWeek >= ch.max_promo_per_week) { skip('promo_week'); continue; }
      }

      // תקרת מכירתיים יומית — חוצה ערוצים
      const promoToday = countIn(
        (p) => ymd(new Date(p.scheduled_at)) === dayKey && p.kind === 'promo'
      );
      if (promoToday >= maxPromoPerDay) { skip('promo_day'); continue; }

      if (endpointId) sameDay.add(`${ch.id}:${dayKey}`);

      placed = {
        channel_id: ch.id,
        channel_name: ch.name,
        scheduled_at: at.toISOString(),
        day_label: `${HE_DAYS[at.getDay()]} ${at.getDate()}.${at.getMonth() + 1}`,
        time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
        note: null,
      };
      planned.push({ channel_id: ch.id, kind: 'promo', scheduled_at: at.toISOString() });

      // אזהרה אם השיבוץ הזה סוגר את מכסת המכירתיים השבועית
      if (ch.max_promo_per_week != null) {
        const promoAfter = countIn((p) => inSameWeek(p) && p.kind === 'promo');
        if (promoAfter >= ch.max_promo_per_week) {
          warnings.push(`${ch.name} יגיע לגבול המכירתיים השבועי`);
        }
      }
      break;
    }

    if (!placed) {
      warnings.push(urgentFullReason(ch, ymd(lastDay), why, maxPromoPerDay));
    } else {
      // המבצע נכנס לשטח פנוי, אבל הוא עדיין יכול לנחות צמוד לפוסט קיים
      // של אותה נקודה. זו לא סיבה לעצור מבצע דחוף — רק לומר את זה.
      // למבצע דחוף אין קמפיין — המרווח הכללי.
      const gap = await gapWarning({
        endpointId, channelId: ch.id, when: placed.scheduled_at,
      });
      if (gap) warnings.push(`${ch.name}: ${gap.message}`);
      placements.push(placed);
    }
  }

  return {
    ok: placements.length > 0,
    errors: [],
    placements,
    warnings,
    // התכנון לא מזיז כלום: הוא רק ממלא שטח פנוי
    displaced: [],
    summary: placements.length
      ? placements.map((p) => `${p.channel_name} ${p.day_label}`).join(' · ')
      : 'לא נמצא שטח פנוי',
  };
}

/**
 * למה מבצע דחוף לא נכנס לערוץ עד lastDay — הסיבה ששללה הכי הרבה ימים
 * (why: סיבה → כמה ימים). full_urgent = הערוץ מלא ויש באותו שבוע מבצע דחוף —
 * השמורה לדחופים (urgentReserve, סעיף 7) כבר בשימוש, ואומרים איפה מגדילים
 * אותה; full = מלא בלי דחוף (פוסטים ידניים תפסו גם את השמורה); time = השעה
 * שנבחרה כבר עברה בכל הימים שנשארו.
 */
export function urgentFullReason(ch, lastDay, why, maxPromoPerDay = 1) {
  const top = [...why].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'full_urgent';
  const head = `אין שטח פנוי ב${ch.name} עד ${lastDay}`;
  switch (top) {
    case 'promo_week':
      return `${head} — הערוץ מקבל עד ${ch.max_promo_per_week} מכירתיים בשבוע, והם כבר בשימוש ` +
        '(בהגדרות הערוץ, תחת "מתקדם")';
    case 'promo_day':
      return `${head} — בכל יום כבר יש ${maxPromoPerDay === 1 ? 'מכירתי' : `${maxPromoPerDay} מכירתיים`} ` +
        'בכל הערוצים יחד (המקסימום בכללי המנוע)';
    case 'same_day':
      return `${head} — בכל יום פנוי כבר יש פוסט לאותה נקודת קצה בערוץ`;
    case 'blocked_day':
      return `${head} — הימים שנשארו חסומים בערוץ`;
    case 'time':
      return `${head} — השעה שנבחרה כבר עברה, ואחרי ${LAST_URGENT_HOUR}:00 לא משבצים להיום. ` +
        'אפשר לבחור תאריך מאוחר יותר';
    case 'full': {
      const n = urgentReserve(ch.max_per_week, ch.urgent_reserve_pct);
      if (n === 0) {
        return `${head} — הערוץ מלא, ואין בו שטח שמור לדחופים. אפשר להגדיר אותו ` +
          'בהגדרות הערוץ, תחת "מתקדם"';
      }
      return `${head} — הערוץ מלא: כבר ${ch.max_per_week} מתוך ${ch.max_per_week} פוסטים בשבוע, ` +
        'כולל השטח ששמור לדחופים (תפוס בפוסטים רגילים). אפשר להגדיל את "פוסטים בשבוע" ' +
        'או את השמורה בהגדרות הערוץ';
    }
    default: {
      const n = urgentReserve(ch.max_per_week, ch.urgent_reserve_pct);
      if (n === 0) {
        return `${head} — הערוץ מלא, ואין בו שטח שמור לדחופים. אפשר להגדיר אותו ` +
          'בהגדרות הערוץ, תחת "מתקדם"';
      }
      return `${head} — הערוץ מלא, והשמורה לדחופים (${n === 1 ? 'פוסט אחד' : `${n} פוסטים`} בשבוע) ` +
        'כבר בשימוש השבוע. אפשר להגדיל אותה בהגדרות הערוץ, תחת "מתקדם"';
    }
  }
}
