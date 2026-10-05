/**
 * התקופה של טאב הנתונים: "14 ימים", "החודש", "החודש הקודם" — וטווח התאריכים
 * שנגזר ממנה.
 *
 * שכבה 0 — פונקציות טהורות בלבד. משותף לשני הצדדים: הטאב מחשב מכאן את
 * from/to שהוא שולח, והשרת (src/routes/stats.js) מקבל ?preset= ומחשב מאותה
 * פונקציה. חודש קלנדרי נקבע לפי שעון ישראל ולא לפי השעון של הדפדפן או של
 * התהליך — אחרת ב-1 לחודש בחצות "החודש הקודם" היה זז ביום.
 */

export const LOCAL_TZ = 'Asia/Jerusalem';

/** האפשרויות בסרגל, לפי הסדר. 'custom' פותח שני שדות תאריך. */
export const DATA_PERIODS = [
  ['7', '7 ימים'], ['14', '14 ימים'], ['30', '30 יום'], ['90', '90 יום'],
  ['365', 'שנה'], ['this_month', 'החודש'], ['prev_month', 'החודש הקודם'],
  ['custom', 'טווח מותאם'],
];

/** ברירת המחדל: שבועיים — חלון סביר להזנת תוצאות של מה שיצא לאחרונה */
export const DEFAULT_DATA_PERIOD = '14';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** YYYY-MM-DD של הרגע הנתון בשעון ישראל */
export function localYmd(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** YYYY-MM-DD + ימים, דרך UTC כדי שמעבר שעון לא יזיז יום */
function addDays(s, days) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** האם הערך הוא אחת התקופות המוכרות (לא כולל 'custom') */
export const isPreset = (p) =>
  DATA_PERIODS.some(([v]) => v === p) && p !== 'custom';

/**
 * טווח התאריכים (כולל שני הקצוות) של תקופה מוכנה.
 *  - מספר ימים: N הימים האחרונים כולל היום.
 *  - 'this_month': מה-1 בחודש ועד היום — לא עד סוף החודש, כדי ש"בשבוע"
 *    לא יתחלק בימים שעוד לא היו.
 *  - 'prev_month': החודש הקלנדרי הקודם במלואו.
 * @returns {{from:string,to:string}|null} null לערך לא מוכר
 */
export function presetRange(preset, now = new Date()) {
  const today = localYmd(now);
  const [y, m] = today.split('-').map(Number);

  if (preset === 'this_month') return { from: fmt(y, m, 1), to: today };
  if (preset === 'prev_month') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    return { from: fmt(py, pm, 1), to: fmt(py, pm, last) };
  }
  const days = Number(preset);
  if (!Number.isInteger(days) || days < 1 || days > 3660) return null;
  return { from: addDays(today, -(days - 1)), to: today };
}
