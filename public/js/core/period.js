/**
 * תקופת קמפיין: "שבוע", "חודש", "5 שבועות" — ותאריך הסיום שנגזר ממנה.
 *
 * שכבה 0 — פונקציות טהורות בלבד. הקובץ משותף לשני הצדדים: השרת
 * (src/routes/campaigns.js) מחשב ממנו את ends_on שנשמר, והטופס מציג ממנו
 * "רץ עד…" בזמן אמת. מקור אחד, כדי שמה שרואים בטופס הוא מה שנשמר.
 *
 * ערכים: '<N>w' (N שבועות), '<N>m' (N חודשים קלנדריים), 'custom' (תאריך
 * סיום ידני), 'open' (בלי תאריך סיום — רק לקמפיינים ישנים לפי זוויות שנשמרו
 * כך, כדי ששמירה בלי שינוי לא תמציא להם סוף). הסיום כולל: שבוע מ-1.11
 * רץ עד 7.11.
 */

/** האפשרויות בטופס, לפי הסדר. "אחר" ו"ידני" מטופלים בנפרד. */
export const PERIOD_PRESETS = [
  ['1w', 'שבוע'], ['2w', 'שבועיים'], ['3w', '3 שבועות'],
  ['1m', 'חודש'], ['2m', 'חודשיים'], ['3m', '3 חודשים'],
];

export const MAX_WEEKS = 104;
export const MAX_MONTHS = 24;

/** מפרק ערך תקופה. null = לא תקין. */
export function parsePeriod(p) {
  if (p === 'custom') return { unit: 'custom' };
  if (p === 'open') return { unit: 'open' };
  const m = /^(\d{1,3})([wm])$/.exec(String(p ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (n < 1 || (unit === 'w' && n > MAX_WEEKS) || (unit === 'm' && n > MAX_MONTHS)) return null;
  return { n, unit };
}

const parts = (s) => String(s).slice(0, 10).split('-').map(Number);
const fmt = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/** YYYY-MM-DD + ימים. דרך UTC, כדי שמעבר שעון לא יזיז יום. */
export function addDays(s, days) {
  const [y, m, d] = parts(s);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * תאריך הסיום (כולל) של תקופה שמתחילה ב-start. null לתקופה ידנית או לא תקינה.
 *
 * חודשים קלנדריים: חודש מ-15.1 רץ עד 14.2. כשאותו יום לא קיים בחודש היעד
 * (31.1 + חודש = "31.2"), התקופה נגמרת ביום האחרון של חודש היעד — 28.2
 * (או 29.2 בשנה מעוברת). כך חודש אף פעם לא "גולש" לחודש שאחריו.
 */
export function periodEnd(start, period) {
  const p = parsePeriod(period);
  if (!p || p.unit === 'custom' || p.unit === 'open' || !start) return null;
  if (p.unit === 'w') return addDays(start, p.n * 7 - 1);

  const [y, m, d] = parts(start);
  const idx = (m - 1) + p.n;               // חודש היעד, מאופס מ-0
  const ty = y + Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  if (d > lastDay(ty, tm)) return fmt(ty, tm, lastDay(ty, tm));
  return addDays(fmt(ty, tm, d), -1);
}

/**
 * התקופה שמתאימה לטווח קיים — לקמפיינים מלפני השדה, ולתאריכים שהגיעו
 * בלי תקופה (גרירה בציר האסטרטגיה). חודשים קודם (1.11–30.11 = "חודש"),
 * אחר כך שבועות שלמים, ואחרת ידני.
 */
export function inferPeriod(start, end) {
  if (!start || !end || end < start) return 'custom';
  for (let n = 1; n <= MAX_MONTHS; n += 1) {
    const e = periodEnd(start, `${n}m`);
    if (e === end) return `${n}m`;
    if (e > end) break;
  }
  const [ay, am, ad] = parts(start);
  const [by, bm, bd] = parts(end);
  const days = Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
  if (days % 7 === 0 && days / 7 <= MAX_WEEKS) return `${days / 7}w`;
  return 'custom';
}

/** שם התקופה לתצוגה: "חודש", "5 שבועות", "תאריך סיום ידני" */
export function periodLabel(period) {
  const preset = PERIOD_PRESETS.find(([v]) => v === period);
  if (preset) return preset[1];
  const p = parsePeriod(period);
  if (!p) return '';
  if (p.unit === 'custom') return 'תאריך סיום ידני';
  if (p.unit === 'open') return 'בלי תאריך סיום';
  return p.unit === 'w' ? `${p.n} שבועות` : `${p.n} חודשים`;
}

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                   'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * שם ברירת המחדל להרצה חדשה של קמפיין מחזורי: "השקה · נובמבר 2026", לפי
 * חודש הפוסט הראשון. הטופס מציע אותו לעריכה, והשרת משתמש בו כששם לא נשלח.
 */
export function runName(name, start) {
  if (!start) return name;
  const [y, m] = parts(start);
  return `${name} · ${HE_MONTHS[m - 1]} ${y}`;
}

/** מספר הימים בטווח, כולל שני הקצוות (1.11–7.11 = 7) */
export function spanDays(start, end) {
  const [ay, am, ad] = parts(start);
  const [by, bm, bd] = parts(end);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
}

/**
 * התקופה של הרצה חדשה של קמפיין מחזורי שמתחילה ב-start: אותו אורך כמו
 * המקור. תקופה קבועה ('2w', '1m') נשמרת כמו שהיא והסיום מחושב מההתחלה
 * החדשה (חודש מ-31.1 נגמר ב-28.2, חודש מ-31.3 ב-30.4). מקור עם סיום ידני,
 * או מלפני שדה התקופה, מקבל את אותו מספר ימים בתאריך סיום ידני — אלא אם
 * התאריכים שלו הם תקופה שלמה. מקור בלי תאריך סיום — null: צריך לבחור.
 * @returns {{period:string, ends_on?:string}|null}
 */
export function rerunPeriod(src, start) {
  const fixed = (p) => p && /^\d+[wm]$/.test(p);
  if (fixed(src.period)) return { period: src.period };
  if (!src.starts_on || !src.ends_on || !start) return null;
  if (src.period == null) {
    const inferred = inferPeriod(src.starts_on, src.ends_on);
    if (fixed(inferred)) return { period: inferred };
  }
  return { period: 'custom', ends_on: addDays(start, spanDays(src.starts_on, src.ends_on) - 1) };
}

/**
 * התאריך של פריט מספר i (מאופס מ-0) מתוך total, פרוסים אחיד על התקופה
 * [start, end]: התקופה מחולקת ל-total מקטעים שווים, וכל פריט בתחילת המקטע
 * שלו — start + floor(i × ימים / total). הראשון ביום ההתחלה ("תאריך היעד
 * לפוסט הראשון"), והאחרון מקטע אחד לפני הסוף — כך שאם המשבצת שלו
 * מתפספסת, נשאר לו מקום לצאת לפני ends_on. total ≤ 1 או בלי סוף → יום
 * ההתחלה. null בלי התחלה.
 *
 * מקור אחד לשני הצרכנים: הרשת במסך התוכן (src/campaigns.js) והמנוע
 * (src/engine.js, "קמפיין מוכן") — כדי שהתאריך שרואים הוא התאריך שהמנוע
 * מכבד.
 */
export function spreadDate(start, end, i, total) {
  if (!start) return null;
  if (total <= 1 || !end) return String(start).slice(0, 10);
  const [ay, am, ad] = parts(start);
  const [by, bm, bd] = parts(end);
  const days = Math.max(1, Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1);
  return addDays(start, Math.floor((i * days) / total));
}
