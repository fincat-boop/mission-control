/**
 * קיבולת ונתחים — מקור אחד לשאלה "כמה מקום מגיע לקמפיין, וכמה מזה באמת נכנס".
 *
 * עד עכשיו היו שלוש נוסחאות נתח (הרשת של הקמפיין, ציר האסטרטגיה, החוב
 * במנוע) ושתי נוסחאות תקציב לערוץ, והן לא הסכימו זו עם זו: הרשת דרשה תוכן
 * שהמנוע לא יכול לשבץ, וציר האסטרטגיה הראה חלוקה אחרת ממה שהמנוע רדף אחריו.
 * כאן יושבים החישובים, וכל השאר קוראים להם.
 *
 * מודול טהור — בלי גישה למסד, כדי שאפשר יהיה לבדוק אותו ולהשתמש בו גם
 * בתצוגה מקדימה של קמפיין שעוד לא נשמר.
 */

const DAY = 86400000;

/**
 * תאריך כ-YYYY-MM-DD — ההשוואות כאן הן השוואות מחרוזת, כמו במנוע. עמודות
 * date מגיעות מהמסד כמחרוזת (db.js); Date נקרא לפי היום המקומי שלו, כמו ymd.
 */
const ymdOf = (s) => {
  if (s == null) return null;
  if (s instanceof Date) {
    return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${
      String(s.getDate()).padStart(2, '0')}`;
  }
  return String(s).slice(0, 10);
};

/** YYYY-MM-DD → מילישניות UTC של חצות. בלי מעבר שעון. */
const utc = (s) => {
  const [y, m, d] = ymdOf(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/**
 * המפתח של קמפיין במפה ש-normalizeShares מחזירה: המזהה שלו. קמפיין שעוד לא
 * נשמר (תצוגה מקדימה בטופס) נקרא 'draft' — ולכן ברשימה אחת יכולה להיות
 * טיוטה אחת בלבד. מי שמחפש נתח של קמפיין קורא לפונקציה הזו, לא בונה מפתח לבד.
 */
export const shareKey = (c) => c.id ?? 'draft';

/** האם הקמפיין חופף לטווח. תאריך חסר (בקמפיין או בטווח) = פתוח לאותו כיוון. */
function overlaps(c, from, to) {
  const s = ymdOf(c.starts_on);
  const e = ymdOf(c.ends_on);
  return (!e || !from || e >= from) && (!s || !to || s <= to);
}

/**
 * הנתח המנורמל של כל קמפיין שמתחרה על השטח בטווח [from, to].
 *
 * מתחרים: פעיל, לא מושהה, וחופף לטווח. החשבון:
 *   1. share_pct מפורש קודם. אם הסכום עולה על 100% — כולם מוקטנים באותו יחס
 *      ל-100%, והאוטומטיים מקבלים 0 (אין להם מקום).
 *   2. היתרה (100% פחות המפורשים) מתחלקת בין נקודות הקצה של הקמפיינים
 *      האוטומטיים לפי החשיבות של נקודת הקצה (בלי ערך — 5),
 *   3. וחלק נקודת הקצה מתחלק שווה בשווה בין הקמפיינים האוטומטיים שלה.
 *
 * כך החשיבות של נקודת הקצה היא המקור היחיד ל"כמה מקום", קמפיין קבוע הוא
 * חריגה, והסכום לעולם לא עובר 100%. כשיש רק מפורשים והם מתחת ל-100% — היתרה
 * לא מוקצית לאף קמפיין (היא של התוכן השוטף).
 *
 * @param campaigns שורות עם id, endpoint_id, share_pct, active, paused_at,
 *        starts_on, ends_on, endpoint_importance (CAMPAIGNS_WEIGHTED_SQL)
 * @returns {Map<number|'draft', number>} מפתח = shareKey(c), נתח 0..1.
 *          קמפיין שלא מתחרה בטווח לא מופיע במפה.
 */
export function normalizeShares(campaigns, { from = null, to = null } = {}) {
  const f = ymdOf(from);
  const t = ymdOf(to);
  const live = campaigns.filter((c) => c.active && !c.paused_at && overlaps(c, f, t));

  const out = new Map();
  const explicit = live.filter((c) => c.share_pct != null);
  const auto = live.filter((c) => c.share_pct == null);

  const explicitSum = explicit.reduce((s, c) => s + Math.max(0, Number(c.share_pct)), 0);
  const scale = explicitSum > 100 ? 100 / explicitSum : 1;
  for (const c of explicit) out.set(shareKey(c), (Math.max(0, Number(c.share_pct)) * scale) / 100);

  const rest = Math.max(0, 1 - Math.min(100, explicitSum) / 100);
  const byEndpoint = new Map();
  for (const c of auto) {
    const k = c.endpoint_id ?? null;
    if (!byEndpoint.has(k)) byEndpoint.set(k, []);
    byEndpoint.get(k).push(c);
  }
  // המשקל של נקודה = החשיבות שלה, פעם אחת — לא פעם לכל קמפיין שלה
  const weight = (list) => Math.max(0, Number(list[0].endpoint_importance ?? 5));
  const totalWeight = [...byEndpoint.values()].reduce((s, list) => s + weight(list), 0);
  for (const list of byEndpoint.values()) {
    // כל הנקודות בחשיבות 0 — חלוקה שווה ביניהן, ולא חלוקה באפס
    const part = totalWeight > 0 ? rest * (weight(list) / totalWeight) : rest / byEndpoint.size;
    for (const c of list) out.set(shareKey(c), part / list.length);
  }
  return out;
}

/**
 * הנתח של קמפיין אחד, על פני החלון שלו (starts_on..ends_on). הקמפיין עצמו
 * נספר תמיד — גם אם הוא לא ברשימה, לא פעיל או מושהה — כדי שהטופס והרשת
 * יראו כמה הוא *יקבל* כשירוץ. הערכים שבידי הקורא גוברים על השורה ברשימה
 * (טיוטה שמשנה share_pct), אבל החשיבות של נקודת הקצה נלקחת מהרשימה כשאין
 * אותה בקמפיין עצמו.
 */
export function shareOf(campaign, concurrent = []) {
  const listed = campaign.id != null ? concurrent.find((x) => x.id === campaign.id) : null;
  const self = {
    ...listed,
    ...campaign,
    endpoint_importance: campaign.endpoint_importance ?? listed?.endpoint_importance,
    active: true,
    paused_at: null,
  };
  const key = shareKey(self);
  const others = concurrent.filter((x) => shareKey(x) !== key);
  const shares = normalizeShares([...others, self],
    { from: campaign.starts_on ?? null, to: campaign.ends_on ?? null });
  return shares.get(key) ?? 0;
}

/**
 * כמה פוסטים בשבוע המנוע רשאי לשבץ בערוץ: התקרה פחות השמורה לדחופים.
 * אותו מספר ש-buildUsage במנוע אוכף — מקור אחד.
 */
export function channelBudget(channel) {
  const max = Number(channel.max_per_week ?? 1);
  const reserved = Math.floor(max * (Number(channel.urgent_reserve_pct ?? 20) / 100));
  return Math.max(0, max - reserved);
}

/**
 * כמה פוסטים באמת נכנסים לקמפיין בערוץ אחד בטווח [from, to], מול כמה
 * שהקצב של הערוץ "רוצה".
 *
 *   wanted    = max_per_week × שבועות × נתח (מינימום 1) — החשבון הישן
 *   rateCap   = התקציב של המנוע (בלי השמורה לדחופים) × שבועות × נתח
 *   gapCap    = כמה ימים פנויים אפשר לבחור עם מרווח gapDays לפחות ביניהם
 *               (המנוע לא שם שני פוסטים של אותה נקודה באותו ערוץ בתוך המרווח)
 *   capacity  = הקטן מביניהם; לפחות 1 כשיש יום פנוי ונתח, 0 כשאין יום פנוי
 *   limitedBy = 'blocked' (כל הימים חסומים) / 'gap' (המרווח הוא המגביל) / 'rate'
 *
 * ימים חסומים: blocked_days הם מספרי ימים בשבוע (0 = ראשון), כמו
 * Date.getDay() במנוע (buildSlots / allows).
 *
 * @returns {{wanted:number, capacity:number, rateCap:number, gapCap:number,
 *            availableDays:number, limitedBy:'blocked'|'gap'|'rate'}}
 *          availableDays = מספר הימים הפנויים בטווח
 */
export function channelCapacity({ from, to, channel, share, gapDays = 7 }) {
  const start = utc(from);
  const end = utc(to);
  const span = Math.max(0, Math.round((end - start) / DAY)) + 1;
  const weeks = span / 7;
  const blocked = new Set((channel.blocked_days ?? []).map(Number));

  const available = [];
  for (let i = 0; i < span; i += 1) {
    if (!blocked.has(new Date(start + i * DAY).getUTCDay())) available.push(i);
  }

  const max = Number(channel.max_per_week ?? 1);
  const wanted = Math.max(1, Math.round(max * weeks * share));
  const rateCap = Math.round(channelBudget(channel) * weeks * share);

  // חמדני מהיום הראשון: בוחרים כל יום פנוי שרחוק מספיק מהקודם — זה המקסימום
  const step = Math.max(1, Number(gapDays ?? 7));
  let gapCap = 0;
  let last = -Infinity;
  for (const d of available) {
    if (d - last >= step) { gapCap += 1; last = d; }
  }

  let capacity = 0;
  if (available.length && share > 0) capacity = Math.max(1, Math.min(rateCap, gapCap));
  const limitedBy = !available.length ? 'blocked' : (gapCap < rateCap ? 'gap' : 'rate');

  return { wanted, capacity, rateCap, gapCap, availableDays: available.length, limitedBy };
}
