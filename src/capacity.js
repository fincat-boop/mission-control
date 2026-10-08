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

import { urgentReserve } from '../public/js/core/reserve.js';

const DAY = 86400000;

/** ברירת המחדל של המרווח כשגם להגדרות המנוע אין ערך (engine_settings.min_gap_days) */
export const DEFAULT_GAP_DAYS = 7;

/**
 * המרווח שנגזר מהקצב של הערוץ (סעיף 5): כמה ימים בין פוסטים של נקודה אחת
 * כדי שכל הנקודות שמתחרות בערוץ ימלאו יחד את התקציב השבועי שלו —
 * floor(7 × נקודות / תקציב), בין 1 ל-7. נקודה אחת בערוץ של 5 בשבוע (תקציב 4
 * אחרי השמורה) → 1: כל יום מותר. שלוש נקודות בערוץ של 4 (בלי שמורה) → 5.
 * תקציב 0 — 7 (אין מה למלא, אין סיבה לקצר).
 * @param channel שורת channels (max_per_week, urgent_reserve_pct)
 * @param endpoints כמה נקודות מתחרות בערוץ (לפחות 1) — channelEndpoints
 */
export function derivedGap(channel, endpoints = 1) {
  const budget = channelBudget(channel);
  if (budget <= 0) return DEFAULT_GAP_DAYS;
  const n = Math.max(1, Math.floor(Number(endpoints) || 1));
  return Math.min(DEFAULT_GAP_DAYS, Math.max(1, Math.floor((7 * n) / budget)));
}

/**
 * המרווח בימים בין שני פוסטים של אותה נקודת קצה באותו ערוץ, כשהתוכן שנכנס
 * שייך לקמפיין campaign: המרווח של הקמפיין (min_gap_days) גובר תמיד.
 * בלעדיו — ברירת המחדל: ההגדרה הכללית (engine_settings.min_gap_days, ובלעדיה
 * 7), ובערוץ ידוע — הקטן מבינה לבין המרווח שנגזר מהקצב של הערוץ (derivedGap,
 * סעיף 5). קודם 7 קבוע = פוסט אחד בשבוע לנקודה×ערוץ: ארגון עם נקודה אחת
 * וערוץ של 5 בשבוע קיבל 1.
 *
 * מקור אחד לשאלה "כמה ימים בין פוסטים" — המנוע, אזהרות הלוח, ההזזה מחדש,
 * הדחוף וחשבון הקיבולת קוראים לכאן, כדי שהרשת לא תדרוש מה שהמנוע לא ישבץ. תוכן
 * בלי קמפיין (שוטף, מבצע דחוף, פוסט חסר תוכן) — campaign = null.
 * 0 בהגדרה הכללית = בלי מרווח (רק אותו יום אסור, בכלל נפרד).
 * בלי ערוץ (on.channel) — ההגדרה הכללית בלבד: שימוש חוזר בתוכן evergreen
 * (reusable במנוע) ואופק השאילתות, שאינם "מרווח בערוץ".
 * @param {{min_gap_days?:number|null}|null} campaign
 * @param {{min_gap_days?:number|null}|null} settings שורת engine_settings
 * @param {{channel?:object|null, endpoints?:number}} [on] הערוץ וכמה נקודות מתחרות בו (gapOn)
 */
export function effectiveGap(campaign, settings, { channel = null, endpoints = 1 } = {}) {
  const own = campaign?.min_gap_days;
  if (own != null) return Number(own);
  const global = settings?.min_gap_days != null ? Number(settings.min_gap_days) : DEFAULT_GAP_DAYS;
  if (!channel) return global;
  return Math.min(global, derivedGap(channel, endpoints));
}

/**
 * המרווח הנדרש בין פוסט מועמד לשכן של אותה נקודה באותו ערוץ (סעיף 11, D2/D4) —
 * פונקציה אחת למנוע (gapViolation) ולאזהרות הלוח (gapWarning):
 *   מרווח מפורש של קמפיין (min_gap_days) — של כל אחד מהצדדים — נספר תמיד;
 *   שכן בלי מרווח מפורש תורם את ברירת המחדל רק כשגם למועמד אין מרווח מפורש
 *   (אחרת קמפיין שביקש מרווח 1 היה נחסם בברירת המחדל של שכן שוטף).
 * required = max(מועמד ?? ברירת מחדל, שכן ?? (מועמד מפורש ? 0 : ברירת מחדל)).
 * חשבון הקיבולת (channelCapacity.gapCap) לא מכיר שכנים — הערכה בלבד.
 * @param candidate min_gap_days של הקמפיין של המועמד, או null
 * @param neighbour min_gap_days של הקמפיין של השכן, או null
 * @param defaultGap effectiveGap(null, settings, on) — ברירת המחדל בערוץ
 */
export function pairGap(candidate, neighbour, defaultGap) {
  const own = candidate ?? defaultGap;
  const theirs = neighbour ?? (candidate != null ? 0 : defaultGap);
  return Math.max(Number(own), Number(theirs));
}

/**
 * מי מתחרה על כל ערוץ בטווח [from, to] — לנקודות שהמרווח נגזר מהן
 * (derivedGap) ולמגבלת המרווח בלוח (weekGapLimit). נקודה מתחרה בערוץ כשיש
 * לה שם קמפיין חי (פעיל, לא מושהה, נקודה פעילה, חופף לטווח, יושב בערוץ) או
 * תוכן שוטף שעוד יכול לצאת בו (standalone).
 * @param campaigns שורות CAMPAIGNS_WEIGHTED_SQL (channel_ids, min_gap_days, endpoint_active)
 * @param standalone Map<channelId, Iterable<endpointId>> — STANDALONE_SQL (capacity-db.js)
 * @returns {Map<number, Map<number, (number|null)[]>>} ערוץ → (נקודה → המרווחים של
 *          המקורות שלה בערוץ: min_gap_days של קמפיין, או null = ברירת המחדל)
 */
export function channelEndpoints(campaigns, standalone = new Map(), { from = null, to = null } = {}) {
  const f = ymdOf(from);
  const t = ymdOf(to);
  const out = new Map();
  const add = (ch, ep, gap) => {
    const k = Number(ch);
    if (!out.has(k)) out.set(k, new Map());
    const m = out.get(k);
    if (!m.has(Number(ep))) m.set(Number(ep), []);
    m.get(Number(ep)).push(gap == null ? null : Number(gap));
  };
  for (const c of campaigns) {
    if (!c.active || c.paused_at || c.endpoint_active === false || !overlaps(c, f, t)) continue;
    for (const ch of c.channel_ids ?? []) add(ch, c.endpoint_id, c.min_gap_days);
  }
  for (const [ch, eps] of standalone) for (const ep of eps) add(ch, ep, null);
  return out;
}

/**
 * הערוץ וכמה נקודות מתחרות בו, בצורה ש-effectiveGap מקבל. ctx — {channels:
 * Map<id, שורה>, endpoints: channelEndpoints(...)} (loadGapContext); בלי ctx
 * — {} (ההגדרה הכללית בלבד). לפחות נקודה אחת: מי ששואל על הערוץ מתחרה בו.
 */
export function gapOn(ctx, channelId) {
  const channel = ctx?.channels?.get(Number(channelId));
  if (!channel) return {};
  return { channel, endpoints: Math.max(1, ctx.endpoints?.get(Number(channelId))?.size ?? 0) };
}

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
 *        starts_on, ends_on, endpoint_importance, endpoint_active (CAMPAIGNS_WEIGHTED_SQL;
 *        נקודה מושבתת — לא מתחרה, כמו מושהה)
 * @returns {Map<number|'draft', number>} מפתח = shareKey(c), נתח 0..1.
 *          קמפיין שלא מתחרה בטווח לא מופיע במפה.
 */
export function normalizeShares(campaigns, { from = null, to = null } = {}) {
  const f = ymdOf(from);
  const t = ymdOf(to);
  // נקודה מושבתת = כמו השהיה (סעיף 16). שורה בלי endpoint_active — פעילה
  const live = campaigns.filter((c) => c.active && !c.paused_at && c.endpoint_active !== false &&
    overlaps(c, f, t));

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
 * האם הקמפיין יושב על הערוץ (channel_ids — CAMPAIGNS_WEIGHTED_SQL). שורה בלי
 * channel_ids בכלל (לא נטענו) נחשבת על כל ערוץ — אין לפי מה לסנן.
 */
export const onChannel = (c, channelId) => c.channel_ids == null ||
  c.channel_ids.map(Number).includes(Number(channelId));

/** כל הערוצים שמופיעים ב-channel_ids של הרשימה */
const channelsOf = (campaigns) =>
  [...new Set(campaigns.flatMap((c) => (c.channel_ids ?? []).map(Number)))];

/**
 * הנתחים לכל ערוץ בנפרד (סעיף 4): בכל ערוץ מתחלקים רק הקמפיינים שיושבים
 * עליו — אותו חשבון כמו normalizeShares (מפורש קודם, היתרה לפי חשיבות
 * הנקודות שיש להן קמפיין בערוץ, שווה בשווה בתוך נקודה), רק על הקבוצה של
 * הערוץ. קמפיין שלבד בוואטסאפ מקבל את כל וואטסאפ, גם כשבפייסבוק יש עוד
 * שלושה; ו-share_pct 100 בוואטסאפ לא מאפס את האוטומטיים בפייסבוק.
 * share_pct מפורש חל בכל אחד מהערוצים של הקמפיין.
 *
 * @param opts.channelIds הערוצים לחשב (ברירת מחדל — כל מי שמופיע ב-channel_ids)
 * @returns {Map<number, Map<number|'draft', number>>} ערוץ → (shareKey → נתח 0..1).
 *          ערוץ בלי מתחרים — מפה ריקה.
 */
export function normalizeSharesByChannel(campaigns, { from = null, to = null, channelIds = null } = {}) {
  const ids = (channelIds ?? channelsOf(campaigns)).map(Number);
  const out = new Map();
  for (const ch of ids) {
    out.set(ch, normalizeShares(campaigns.filter((c) => onChannel(c, ch)), { from, to }));
  }
  return out;
}

/** YYYY-MM-DD + n ימים, בלי מעבר שעון */
const addDays = (s, n) => new Date(utc(s) + n * DAY).toISOString().slice(0, 10);

/**
 * הגבולות שבהם הנתח היומי יכול להשתנות בטווח [f, t]: ההתחלה, תחילה של
 * קמפיין, והיום שאחרי סיום של קמפיין. בתוך קטע בין שני גבולות הנתח קבוע.
 * @returns {{points:string[], totalDays:number}} points ממוינים, כולל f והיום שאחרי t
 */
function segments(campaigns, f, t) {
  const end = addDays(t, 1);               // סוף פתוח: היום שאחרי הטווח
  const cuts = new Set([f, end]);
  for (const c of campaigns) {
    const s = ymdOf(c.starts_on);
    const e = ymdOf(c.ends_on);
    if (s && s > f && s < end) cuts.add(s);
    if (e) {
      const after = addDays(e, 1);
      if (after > f && after < end) cuts.add(after);
    }
  }
  return { points: [...cuts].sort(), totalDays: (utc(end) - utc(f)) / DAY };
}

/**
 * הנתח של כל קמפיין בממוצע על פני טווח של כמה ימים — ממוצע משוקלל בזמן של
 * הנתח היומי, ולא נרמול אחד על כל הטווח.
 *
 * למה: normalizeShares על טווח ארוך מחשיב כל מי שנוגע בו כמתחרה לכל אורכו.
 * קמפיין אוטומטי של אוק׳–דצמ׳ מול 60% קבוע באוקטובר ו-50% קבוע בדצמבר — שני
 * הקבועים לא נפגשים אף פעם, אבל יחד הם "110%" והאוטומטי קיבל 0, הרשת שלו
 * קרסה ל-0/0 והוא הוצג "מלא". כאן כל יום נמדד לבד (40% באוקטובר, 100%
 * בנובמבר, 50% בדצמבר) ואז ממוצע.
 *
 * בפועל לא עוברים יום-יום: הנתח קבוע בין שני גבולות (תחילה / יום אחרי
 * סיום של קמפיין כלשהו), ולכן מחשבים פעם אחת לכל קטע ומשקללים במספר הימים
 * שלו — אותה תוצאה.
 *
 * טווח בלי התחלה או בלי סוף אי אפשר למצע — נופלים לנרמול אחד על כל הטווח.
 * חשבון בלי ערוצים (כולם מתחרים בכולם) — נשאר לבדיקות ולשורות בלי
 * channel_ids; הקיבולת, המנוע והתצוגה עובדים לפי averageSharesByChannel.
 * @returns {Map<number|'draft', number>} כמו normalizeShares: רק מי שמתחרה
 *          לפחות ביום אחד בטווח מופיע במפה
 */
export function averageShares(campaigns, { from = null, to = null } = {}) {
  const f = ymdOf(from);
  const t = ymdOf(to);
  if (!f || !t || t < f) return normalizeShares(campaigns, { from: f, to: t });

  const { points, totalDays } = segments(campaigns, f, t);
  const out = new Map();
  for (let i = 0; i < points.length - 1; i += 1) {
    const days = (utc(points[i + 1]) - utc(points[i])) / DAY;
    // בתוך קטע אין גבול, ולכן היום הראשון שלו מייצג את כולו
    const day = normalizeShares(campaigns, { from: points[i], to: points[i] });
    for (const [k, v] of day) out.set(k, (out.get(k) ?? 0) + (v * days) / totalDays);
  }
  return out;
}

/**
 * כמו averageShares, לכל ערוץ בנפרד (normalizeSharesByChannel בכל קטע).
 * @returns {Map<number, Map<number|'draft', number>>} ערוץ → (shareKey → נתח ממוצע);
 *          כל ערוץ מ-channelIds מופיע, גם בלי מתחרים (מפה ריקה)
 */
export function averageSharesByChannel(campaigns, { from = null, to = null, channelIds = null } = {}) {
  const f = ymdOf(from);
  const t = ymdOf(to);
  const ids = (channelIds ?? channelsOf(campaigns)).map(Number);
  if (!f || !t || t < f) {
    return normalizeSharesByChannel(campaigns, { from: f, to: t, channelIds: ids });
  }
  const { points, totalDays } = segments(campaigns, f, t);
  const out = new Map(ids.map((ch) => [ch, new Map()]));
  for (let i = 0; i < points.length - 1; i += 1) {
    const days = (utc(points[i + 1]) - utc(points[i])) / DAY;
    const day = normalizeSharesByChannel(campaigns,
      { from: points[i], to: points[i], channelIds: ids });
    for (const [ch, shares] of day) {
      const acc = out.get(ch);
      for (const [k, v] of shares) acc.set(k, (acc.get(k) ?? 0) + (v * days) / totalDays);
    }
  }
  return out;
}

/**
 * הקמפיין כפי שהוא נספר בנתח שלו: פעיל, לא מושהה, נקודה פעילה — גם אם בפועל
 * לא — כדי שהטופס והרשת יראו כמה הוא *יקבל* כשירוץ. הערכים שבידי הקורא
 * גוברים על השורה ברשימה (טיוטה שמשנה share_pct), אבל החשיבות של נקודת
 * הקצה נלקחת מהרשימה כשאין אותה בקמפיין עצמו.
 */
function asCompeting(campaign, concurrent, channelIds) {
  const listed = campaign.id != null ? concurrent.find((x) => x.id === campaign.id) : null;
  const self = {
    ...listed,
    ...campaign,
    endpoint_importance: campaign.endpoint_importance ?? listed?.endpoint_importance,
    active: true,
    paused_at: null,
    endpoint_active: true,
  };
  if (channelIds) self.channel_ids = channelIds.map(Number);
  const key = shareKey(self);
  return { self, key, others: concurrent.filter((x) => shareKey(x) !== key) };
}

/**
 * הנתח של קמפיין בכל אחד מהערוצים שלו, על פני החלון שלו (starts_on..ends_on)
 * — ממוצע הנתח היומי לכל ערוץ (averageSharesByChannel). הקמפיין עצמו נספר
 * תמיד (asCompeting).
 * @param channelIds הערוצים של הקמפיין (ברירת מחדל — campaign.channel_ids)
 * @returns {Map<number, number>} ערוץ → נתח 0..1
 */
export function channelSharesOf(campaign, concurrent = [], channelIds = null) {
  const ids = (channelIds ?? campaign.channel_ids ?? []).map(Number);
  const { self, key, others } = asCompeting(campaign, concurrent, ids);
  const by = averageSharesByChannel([...others, self],
    { from: campaign.starts_on ?? null, to: campaign.ends_on ?? null, channelIds: ids });
  return new Map(ids.map((ch) => [ch, by.get(ch)?.get(key) ?? 0]));
}

/**
 * הנתח של קמפיין אחד כמספר אחד, על פני החלון שלו — לתצוגה ("אוטומטי = X%").
 *
 * עם ערוצים (שורות channels, או campaign.channel_ids): הנתח בכל ערוץ
 * (channelSharesOf), משוקלל בתקציב הערוצים (blendShares; בלי שורות — משקל
 * שווה); רשימת ערוצים ריקה — 0. בלי מידע על ערוצים בכלל (בלי channels ובלי
 * channel_ids) — כולם מתחרים בכולם (averageShares), כמו לפני סעיף 4.
 */
export function shareOf(campaign, concurrent = [], channels = null) {
  const rows = channels ?? (campaign.channel_ids
    ? campaign.channel_ids.map((id) => ({ id: Number(id) })) : null);
  if (rows) {
    if (!rows.length) return 0;   // בלי ערוצים אין לקמפיין מקום באף ערוץ
    const per = channelSharesOf(campaign, concurrent, rows.map((ch) => ch.id));
    // שורה בלי max_per_week (רק מזהה) — משקל שווה
    return rows.every((ch) => ch.max_per_week != null)
      ? blendShares(per, rows)
      : [...per.values()].reduce((s, v) => s + v, 0) / rows.length;
  }
  const { self, key, others } = asCompeting(campaign, concurrent, null);
  const shares = averageShares([...others, self],
    { from: campaign.starts_on ?? null, to: campaign.ends_on ?? null });
  return shares.get(key) ?? 0;
}

/**
 * נתח אחד לקמפיין מתוך הנתחים שלו לכל ערוץ: ממוצע משוקלל בתקציב של כל ערוץ
 * (channelBudget) — "איזה חלק מהפוסטים בערוצים האלה הוא שלו". לתצוגה בלבד;
 * כל חשבון של קיבולת עובד לפי הערוץ. תקציב 0 בכל הערוצים — ממוצע פשוט.
 * @param perChannel Map<channelId, נתח> (ערוץ שלא במפה = 0)
 * @param channels שורות channels של הערוצים לשקלל
 */
export function blendShares(perChannel, channels) {
  if (!channels.length) return 0;
  const w = channels.map((ch) => channelBudget(ch));
  const total = w.reduce((s, x) => s + x, 0);
  const at = (ch) => perChannel.get(Number(ch.id)) ?? 0;
  if (total <= 0) return channels.reduce((s, ch) => s + at(ch), 0) / channels.length;
  return channels.reduce((s, ch, i) => s + at(ch) * w[i], 0) / total;
}

/**
 * נתח כולל לכל קמפיין מתוך מפת נתחים לכל ערוץ — blendShares על הערוצים
 * שיש בהם מתחרים בכלל (ערוץ בלי קמפיינים לא נספר: היתרה שם של התוכן
 * השוטף). לציר האסטרטגיה ולטבלת "בפועל מול נתח", שבהן הבסיס הוא הפוסטים
 * של הקמפיינים.
 * @param byChannel normalizeSharesByChannel / averageSharesByChannel
 * @param channelById Map<id, שורת channels>
 * @returns {Map<number|'draft', number>}
 */
export function blendByChannel(byChannel, channelById) {
  const used = [...byChannel].filter(([, m]) => m.size > 0)
    .map(([ch]) => channelById.get(Number(ch))).filter(Boolean);
  const keys = new Set([...byChannel.values()].flatMap((m) => [...m.keys()]));
  const out = new Map();
  for (const k of keys) {
    const per = new Map([...byChannel].map(([ch, m]) => [Number(ch), m.get(k) ?? 0]));
    out.set(k, blendShares(per, used));
  }
  return out;
}

/**
 * כמה קמפיינים של אותה נקודת קצה חולקים את המרווח בערוץ channelId בחלון
 * של campaign (starts_on..ends_on), כולל הקמפיין עצמו.
 *
 * המרווח הוא לנקודה × ערוץ, לא לקמפיין: שני קמפיינים חופפים של אותה נקודה
 * באותו ערוץ לא יכולים לשבץ כל אחד פוסט כל gap ימים — הם חולקים את אותם
 * ימים. נספרים: פעיל, לא מושהה, אותה נקודה, חופף לחלון ויושב על הערוץ
 * (channel_ids — CAMPAIGNS_WEIGHTED_SQL). שורה בלי channel_ids לא נספרת.
 * הקמפיין עצמו (אותו shareKey) נספר פעם אחת, גם אם הוא ברשימה.
 *
 * rank = המקום של הקמפיין בין האחים לפי מזהה (טיוטה בלי מזהה — אחרונה).
 * לפיו מתחלקת השארית כשהימים לא מתחלקים שווה (channelCapacity), כך שסכום
 * החלקים של כל האחים לא עובר את מה שהמרווח מאפשר.
 * @returns {{count:number, rank:number}}
 */
export function siblingsOf(campaign, concurrent, channelId) {
  const key = shareKey(campaign);
  const f = ymdOf(campaign.starts_on);
  const t = ymdOf(campaign.ends_on);
  const others = concurrent.filter((x) => shareKey(x) !== key &&
    Number(x.endpoint_id) === Number(campaign.endpoint_id) &&
    x.active && !x.paused_at && x.endpoint_active !== false && overlaps(x, f, t) &&
    (x.channel_ids ?? []).map(Number).includes(Number(channelId)));
  const order = (c) => (c.id == null ? Infinity : Number(c.id));
  const rank = others.filter((x) => order(x) < order(campaign)).length;
  return { count: 1 + others.length, rank };
}

/**
 * המשקל של כל צד: "משולב" נספר hybrid_weight כמכירתי והשאר כערך.
 * אותה נוסחה בשער היחס של המנוע, בקיבולת של קמפיין ובכרטיס "ערך לכל מכירתי".
 */
export function kindWeights({ promo = 0, value = 0, hybrid = 0 }, hybridWeight) {
  const hw = Number(hybridWeight);
  return { promo: promo + hybrid * hw, value: value + hybrid * (1 - hw) };
}

/** החלון של שער היחס בין ערך למכירתי, בימים — לכל ערוץ בנפרד (סעיף 6) */
export const RATIO_WINDOW_DAYS = 28;

/**
 * היום הראשון (YYYY-MM-DD) של החלון המתגלגל שמסתיים בשבוע weekStart: 28
 * הימים של RATIO_WINDOW_DAYS — שלושת השבועות שלפני השבוע המתוכנן והשבוע
 * עצמו. אותו חלון בשער היחס (priorKinds במנוע) ובפער מהנתח (strategyTargets,
 * סעיף 9) — קמפיין ותיק לא נמדד מתחילתו, אלא מהחודש האחרון כמו כולם.
 * @param weekStart תחילת השבוע המתוכנן, YYYY-MM-DD
 */
export function ratioWindowStart(weekStart) {
  return addDays(ymdOf(weekStart), -(RATIO_WINDOW_DAYS - 7));
}

/**
 * כמה פוסטי ערך נדרשים לכל מכירתי בערוץ בפועל: min_value_per_promo (0 = השער
 * כבוי), אבל לא יותר ממה שהערוץ מכיל ב-28 יום פחות המכירתי עצמו. ערוץ של
 * פוסט אחד בשבוע (4 בחלון) ביחס 5 היה חוסם מכירתי לתמיד — כאן הוא מקבל
 * מכירתי אחד על כל 4 (היחס לא חל מעבר לגודל הערוץ).
 * @param budget channelBudget של הערוץ
 */
export function windowRatio(minRatio, budget) {
  const r = Number(minRatio) || 0;
  if (r <= 0) return 0;
  return Math.min(r, Math.max(0, (budget * RATIO_WINDOW_DAYS) / 7 - 1));
}

/**
 * שער היחס — פונקציה אחת לכל מילוי של המנוע (רגיל, יומי, מרוסן לקמפיין)
 * ולקיבולת: האם פוסט מסוג kind נכנס לחדר המכירתי, מול המשקל המכירתי
 * (kindWeights) של מה שכבר בחלון. "משולב" נספר hybrid_weight כמכירתי —
 * ולכן גם הוא עובר בשער, על אותו חדר. ערך — תמיד נכנס.
 * room — החדר במשקל מכירתי: ratioPromoLimit של החלון (28 יום), או
 * weeklyPromoCap לשבוע אחד; Infinity — השער כבוי (יחס 0). המשקל אחרי הפוסט ≤ room.
 * קודם השבועות הקרובים נבדקו מול הערך שכבר בחלון ושבוע מרוסן מול התקרה —
 * שני שערים, והרשת הבטיחה משולבים שהשבוע הקרוב לא הכניס.
 * @param weights {promo} — kindWeights של מה שכבר בחלון
 */
export function promoRoomAllows(kind, weights, { room = Infinity, hybridWeight = 0.5 } = {}) {
  const add = kindWeights({ [kind]: 1 }, hybridWeight).promo;
  if (add <= 0 || room === Infinity) return true;
  // שבר עשרוני (משולב 0.3) — סובלנות לעיגול
  return (weights.promo ?? 0) + add <= room + 1e-9;
}

/**
 * כמה מכירתיים בשבוע אחד לכל היותר כשהיחס נאכף בלי לדעת כמה ערך יהיה (שבוע
 * מרוסן במנוע, קיבולת של קמפיין): רבע מהתקרה של 28 יום, למעלה — כדי שלא
 * ייערמו כולם בשבוע הראשון. Infinity — השער כבוי.
 */
export function weeklyPromoCap(budget, minRatio) {
  const cap = ratioPromoCap(budget, RATIO_WINDOW_DAYS, minRatio);
  return cap === Infinity ? Infinity : Math.ceil(cap / 4);
}

/**
 * כמה מכירתיים (במשקל) נכנסים לקמפיין בערוץ בטווח של days ימים שנוגע
 * ב-weeksTouched שבועות בלוח: הקטן מבין התקרה של היחס על הטווח
 * (ratioPromoCap) לבין weeklyPromoCap × השבועות — אותו כלל כמו המילוי המרוסן
 * במנוע (buildUsage), ולכן קמפיין קצר לא מקבל את כל התקרה של 28 יום בשבוע אחד.
 */
export function ratioPromoLimit(budget, days, weeksTouched, minRatio) {
  return Math.min(ratioPromoCap(budget, days, minRatio),
    weeklyPromoCap(budget, minRatio) * Math.max(1, weeksTouched));
}

/**
 * כמה מכירתיים (במשקל — משולב נספר חלקית) נכנסים לערוץ בטווח של days ימים
 * אם שאר הפוסטים בו ערך — ערך ≥ יחס × מכירתי בערוץ מלא:
 * floor(תקציב × שבועות / (1 + יחס)). טווח קצר מ-28 יום נמדד כחלון שלם —
 * שער היחס של המנוע מסתכל על 28 הימים שמסביב. Infinity — השער כבוי.
 * לקיבולת של קמפיין ולמילוי המרוסן במנוע (שבועות שעוד אין בהם ערך לספור).
 */
export function ratioPromoCap(budget, days, minRatio) {
  const r = windowRatio(minRatio, budget);
  if (r <= 0) return Infinity;
  return Math.floor((budget * Math.max(days, RATIO_WINDOW_DAYS)) / 7 / (1 + r));
}

/**
 * כמה פוסטים בשבוע המנוע רשאי לשבץ בערוץ: התקרה פחות השמורה לדחופים
 * (urgentReserve — מעוגלת לקרוב, סעיף 7). אותו מספר ש-buildUsage במנוע
 * אוכף — מקור אחד.
 */
export function channelBudget(channel) {
  const max = Number(channel.max_per_week ?? 1);
  return Math.max(0, max - urgentReserve(max, channel.urgent_reserve_pct ?? 20));
}

/**
 * כמה פוסטים באמת נכנסים לקמפיין בערוץ אחד בטווח [from, to], מול כמה
 * שהקצב של הערוץ "רוצה".
 *
 *   wanted    = max_per_week × שבועות × נתח (מינימום 1) — החשבון הישן
 *   rateCap   = התקציב של המנוע (בלי השמורה לדחופים) × שבועות × נתח
 *   gapCap    = כמה ימים פנויים אפשר לבחור עם מרווח gapDays לפחות ביניהם
 *               (המנוע לא שם שני פוסטים של אותה נקודה באותו ערוץ בתוך המרווח),
 *               מחולק בין siblings — הקמפיינים של אותה נקודה שחולקים את
 *               הערוץ בחלון (siblingsOf): כל אחד floor(ימים/k), והשארית —
 *               יום נוסף לכל אחד מהראשונים לפי siblingRank. כך סכום החלקים
 *               לא עובר את מה שהמרווח מאפשר, ואח יכול לקבל 0.
 *               לא מכיר את השכנים של קמפיינים אחרים (pairGap — מרווח מפורש של
 *               השכן) — הערכה; המנוע והאזהרות אוכפים אותם.
 *               קירוב: אח שחופף רק לחלק מהחלון נספר כאילו חופף לכולו,
 *               והמרווח של האחים נחשב שווה לזה של הקמפיין — המנוע אוכף את
 *               המרווח של כל מועמד בנפרד, וכאן רק מעריכים כמה נכנס.
 *   capacity  = הקטן מביניהם; לפחות 1 כשיש יום פנוי, נתח וחלק במרווח. 0
 *               כשאין יום פנוי, כשהתקציב של הערוץ 0 (תקרה 0, או 100% שמורים
 *               לדחופים), או כשהאחים תפסו את כל הימים — המנוע לא ישבץ שם,
 *               ולכן גם לא דורשים בשבילו תוכן
 *   limitedBy = 'blocked' (כל הימים חסומים) / 'budget' (תקציב 0) /
 *               'gap' (המרווח הוא המגביל, כולל חלק 0 בין אחים) / 'rate' /
 *               מגבלה לפי סוג (סעיף 6, רק עם mix): 'ratio' / 'promo_week' /
 *               'promo_day' / 'hybrid_week' / 'value_week' (kindLimited)
 *   kinds     = כמה מכל סוג נכנס (עם mix), kindWanted — כמה ביקשו לפני
 *               המגבלות, kindLimits — המספרים של כל מגבלה (להודעות)
 *
 * ימים חסומים: blocked_days הם מספרי ימים בשבוע (0 = ראשון), כמו
 * Date.getDay() במנוע (buildSlots / allows).
 *
 * @returns {{wanted:number, capacity:number, rateCap:number, gapCap:number, siblings:number,
 *            availableDays:number, limitedBy:'blocked'|'budget'|'gap'|'rate'}}
 *          availableDays = מספר הימים הפנויים בטווח
 */
export function channelCapacity({ from, to, channel, share, gapDays = DEFAULT_GAP_DAYS,
                                  siblings = 1, siblingRank = 0, mix = null, settings = null,
                                  promoDayCap = null }) {
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
  const budget = channelBudget(channel);
  const rateCap = Math.round(budget * weeks * share);

  // חמדני מהיום הראשון: בוחרים כל יום פנוי שרחוק מספיק מהקודם — זה המקסימום
  const step = Math.max(1, Number(gapDays ?? DEFAULT_GAP_DAYS));
  let alone = 0;
  let last = -Infinity;
  for (const d of available) {
    if (d - last >= step) { alone += 1; last = d; }
  }
  // אחים באותה נקודה×ערוץ חולקים את הימים האלה (ראו siblingsOf): חלק שווה,
  // והשארית לראשונים לפי הסדר — הסכום של כולם = alone בדיוק
  const k = Math.max(1, Math.floor(Number(siblings) || 1));
  const rank = Math.max(0, Math.floor(Number(siblingRank) || 0));
  const gapCap = Math.floor(alone / k) + (rank < alone % k ? 1 : 0);

  let capacity = 0;
  if (available.length && share > 0 && budget > 0 && gapCap > 0) {
    capacity = Math.max(1, Math.min(rateCap, gapCap));
  }
  let limitedBy = 'rate';
  if (!available.length) limitedBy = 'blocked';
  else if (budget <= 0) limitedBy = 'budget';
  else if (gapCap === 0 || gapCap < rateCap) limitedBy = 'gap';

  // סעיף 6: מגבלות לפי סוג — רק כשידוע מה התוכן של הקמפיין בערוץ (mix)
  const dow0 = new Date(start).getUTCDay();
  const weeksTouched = new Set(available.map((d) => Math.floor((d + dow0) / 7))).size;
  const kind = mix && capacity > 0
    ? kindLimited({ S: capacity, mix, channel, settings, weeksTouched, span,
                    availableDays: available.length, promoDayCap })
    : null;
  if (kind && kind.capacity < capacity) {
    capacity = kind.capacity;
    limitedBy = kind.binding;
  } else if (kind && limitedBy === 'gap' && rateCap > capacity) {
    // המרווח מקצץ, אבל גם בלעדיו המגבלה לפי סוג לא הייתה נותנת יותר — היא
    // המגביל האמיתי (דחיסה לא תעזור, ולכן גם לא שואלים עליה)
    const atRate = kindLimited({ S: rateCap, mix, channel, settings, weeksTouched, span,
                                 availableDays: available.length, promoDayCap });
    if (atRate?.binding && atRate.capacity <= capacity) limitedBy = atRate.binding;
  }

  return { wanted, capacity, rateCap, gapCap, siblings: k, availableDays: available.length,
           limitedBy, kinds: kind?.kinds ?? null, kindWanted: kind?.wanted ?? null,
           kindLimits: kind?.limits ?? null };
}

/**
 * החלק של קיבולת הקמפיין שנשאר אחרי המגבלות לפי סוג (סעיף 6), מתוך S = מה
 * שהנתח, הקצב והמרווח מאפשרים. התוכן של הקמפיין בערוץ (mix — כמה מכל סוג)
 * מחלק את S לפי אותו יחס, וכל סוג נחתך במגבלות שהמנוע אוכף:
 *   promo_week / hybrid_week / value_week — התקרה לסוג בערוץ × השבועות בלוח
 *     שהטווח נוגע בהם (שבוע ראשון–שבת, כמו buildUsage)
 *   promo_day — מכירתי ליום (max_promo_per_day, בכל הערוצים) × הימים הפנויים,
 *     או promoDayCap — החלק של הערוץ כשלקמפיין כמה ערוצים (channelCapacities)
 *   ratio — שער היחס: ratioPromoLimit (משקל מכירתי, משולב נספר חלקית). שני
 *     הסוגים עוברים באותו שער (promoRoomAllows — אותה פונקציה כמו המנוע):
 *     קודם המשולבים, ומה שנשאר מהחדר — למכירתיים (החלטת משתמש), כמו סדר
 *     הבחירה במנוע (contentOrder: משולב לפני מכירתי כשקמפיין רץ)
 * קירוב: התקרות לערוץ שלמות לקמפיין הזה — קמפיין מכירתי נוסף באותו ערוץ
 * חולק אותן בפועל; המנוע אוכף, וכאן רק מעריכים כמה נכנס.
 * @returns {{capacity:number, kinds:object, wanted:object, limits:object,
 *            binding:'ratio'|'promo_week'|'promo_day'|'hybrid_week'|'value_week'|null}|null}
 */
function kindLimited({ S, mix, channel, settings, weeksTouched, span, availableDays, promoDayCap }) {
  const n = { promo: Number(mix.promo ?? 0), value: Number(mix.value ?? 0),
              hybrid: Number(mix.hybrid ?? 0) };
  const total = n.promo + n.value + n.hybrid;
  if (!total) return null;
  const P = Math.round((S * n.promo) / total);
  const H = Math.min(S - P, Math.round((S * n.hybrid) / total));
  const V = S - P - H;
  const capOf = (field) => (channel[field] != null ? Number(channel[field]) * weeksTouched : Infinity);
  const perDay = Number(settings?.max_promo_per_day ?? 1);
  const hw = Number(settings?.hybrid_weight ?? 0.5);
  const limits = {
    promo_week: capOf('max_promo_per_week'),
    hybrid_week: capOf('max_hybrid_per_week'),
    value_week: capOf('max_value_per_week'),
    promo_day: promoDayCap ?? perDay * availableDays,
    ratio: ratioPromoLimit(channelBudget(channel), span, weeksTouched,
      settings?.min_value_per_promo ?? 3),
  };
  const pMax = Math.min(P, limits.promo_week, limits.promo_day);
  const hMax = Math.min(H, limits.hybrid_week);
  const v = Math.min(V, limits.value_week);
  // החדר המכירתי של היחס — משולבים קודם, מכירתיים במה שנשאר (promoRoomAllows)
  const gate = { room: limits.ratio, hybridWeight: hw };
  const used = { promo: 0, value: 0 };
  let h = 0;
  while (h < hMax && promoRoomAllows('hybrid', used, gate)) { h += 1; used.promo += hw; }
  let p = 0;
  while (p < pMax && promoRoomAllows('promo', used, gate)) { p += 1; used.promo += 1; }
  const ratioCut = p < pMax || h < hMax;
  let binding = null;
  if (ratioCut) binding = 'ratio';
  else if (P > limits.promo_week && limits.promo_week <= limits.promo_day) binding = 'promo_week';
  else if (P > limits.promo_day) binding = 'promo_day';
  else if (H > limits.hybrid_week) binding = 'hybrid_week';
  else if (V > limits.value_week) binding = 'value_week';
  return { capacity: p + h + v, kinds: { promo: p, hybrid: h, value: v },
           wanted: { promo: P, hybrid: H, value: V }, limits, binding };
}

/**
 * כמה פוסטים בטווח [from, to] המרווח מאפשר בערוץ לכל הנקודות שמתחרות בו
 * יחד — לשורת הערוץ בלוח ("מוגבל במרווח בין פוסטים", סעיף 5). לכל נקודה
 * המרווח המקל מבין המקורות שלה (קמפיין עם מרווח משלו, או ברירת המחדל
 * — effectiveGap עם הערוץ), וכמה ימים פנויים אפשר לבחור בו (channelCapacity
 * .gapCap). אותו חשבון כמו הרשת, בלי נוסחה שנייה.
 * @param endpoints channelEndpoints(...).get(channelId) — נקודה → מרווחים
 * @returns {number|null} null — אין אף נקודה בערוץ (אין מה למדוד)
 */
export function weekGapLimit({ from, to, channel, endpoints, settings }) {
  if (!endpoints?.size) return null;
  const on = { channel, endpoints: endpoints.size };
  let total = 0;
  for (const gaps of endpoints.values()) {
    const g = Math.min(...gaps.map((x) => (x == null ? effectiveGap(null, settings, on) : x)));
    total += channelCapacity({ from, to, channel, share: 1, gapDays: g }).gapCap;
  }
  return total;
}

/**
 * כמה שבועות לכל היותר המילוי של קמפיין עובר עליהם בשמירה (campaignFillWeeks
 * ב-routes/_shared.js) — חצי שנה. מה שאחריהם מתמלא כשהשבועות מתקרבים.
 */
export const FILL_HORIZON_WEEKS = 26;

/** השעה האחרונה שבה המנוע עוד משבץ היום (planWeek: עד 22:00) */
const LAST_ENGINE_HOUR = 22;

/**
 * החלון שבו אפשר באמת לשבץ לקמפיין עכשיו — לחלון ההתאמה (סעיף "חלון
 * ההתאמה מבטיח יותר מדי"):
 *   from  — לא לפני היום: קמפיין שהתחיל בעבר נספר מהיום (והיום — רק אם
 *           נשארה שעה שהמנוע משבץ בה, אחרת ממחר)
 *   to    — לא אחרי סוף השבוע ה-26 מהשבוע של from (FILL_HORIZON_WEEKS) —
 *           עד שם המילוי של השמירה מגיע
 *   later — מה שאחרי האופק: {from, to}, או null. מתמלא כשמתקרבים, לא עכשיו
 *   started_past — הקמפיין התחיל לפני from
 * null — בלי תאריכים. from > to — הקמפיין כבר נגמר (אין חלון).
 * @param now Date — "עכשיו" (בדיקות)
 */
export function placeableWindow(campaign, now = new Date()) {
  const s = ymdOf(campaign?.starts_on);
  const e = ymdOf(campaign?.ends_on);
  if (!s || !e) return null;
  let first = ymdOf(now);
  if (now.getHours() + 1 > LAST_ENGINE_HOUR) first = addDays(first, 1);
  const from = s > first ? s : first;
  // סוף השבוע ה-26: השבועות מתחילים בראשון, כמו weekMeta
  const dow = new Date(utc(from)).getUTCDay();
  const horizonEnd = addDays(from, FILL_HORIZON_WEEKS * 7 - 1 - dow);
  const to = e < horizonEnd ? e : horizonEnd;
  return {
    from, to,
    later: e > horizonEnd ? { from: addDays(horizonEnd, 1), to: e } : null,
    started_past: s < from,
  };
}

/** התקרה של מרווח לקמפיין — כמו האילוץ campaigns_min_gap_days_range */
export const MAX_GAP_DAYS = 30;

/**
 * המרווח הגדול ביותר (1..30) שבו הקיבולת בערוץ מגיעה ל-target — "לדחוס":
 * כמה אפשר להשאיר מרווח ועדיין להכניס את מה שרוצים. null כשגם מרווח 1 לא
 * מספיק (הקצב, ימים חסומים או אחים מגבילים — לא המרווח).
 *
 * gapOnly: נמדד רק מה שהמרווח מאפשר (gapCap), בלי הקצב — לקמפיין מוכן,
 * שבו השאלה היא "באיזה מרווח התוכן שנכתב נכנס בימים", והקצב נבדק בנפרד
 * (rate_short בתצוגה המקדימה).
 * @param params כמו channelCapacity בלי gapDays: {from, to, channel, share, siblings, siblingRank}
 * @param target כמה פוסטים צריכים להיכנס
 */
export function gapToFit(params, target, { gapOnly = false } = {}) {
  for (let g = MAX_GAP_DAYS; g >= 1; g -= 1) {
    const r = channelCapacity({ ...params, gapDays: g });
    if ((gapOnly ? r.gapCap : r.capacity) >= target) return g;
  }
  return null;
}

/**
 * תאריך הסיום המוקדם ביותר (YYYY-MM-DD, מ-from ועד maxDays ימים אחריו)
 * שבו הקיבולת מגיעה ל-target — "להאריך". capacityAt(to) מחשב את הקיבולת
 * לחלון from..to; הקורא בונה אותו, כי הנתח והאחים משתנים עם החלון.
 * null כשאין תאריך כזה בטווח.
 */
export function endToFit(from, capacityAt, target, maxDays = 365) {
  const start = ymdOf(from);
  if (!start) return null;
  for (let n = 0; n <= maxDays; n += 1) {
    const to = addDays(start, n);
    if (capacityAt(to) >= target) return to;
  }
  return null;
}
