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

/** ברירת המחדל של המרווח כשגם להגדרות המנוע אין ערך (engine_settings.min_gap_days) */
export const DEFAULT_GAP_DAYS = 7;

/**
 * המרווח בימים בין שני פוסטים של אותה נקודת קצה באותו ערוץ, כשהתוכן שנכנס
 * שייך לקמפיין campaign: המרווח של הקמפיין (min_gap_days), ובלעדיו ברירת
 * המחדל הכללית (engine_settings.min_gap_days), ובלעדיה 7.
 *
 * מקור אחד לשאלה "כמה ימים בין פוסטים" — המנוע, אזהרות הלוח, ההזזה מחדש
 * וחשבון הקיבולת קוראים לכאן, כדי שהרשת לא תדרוש מה שהמנוע לא ישבץ. תוכן
 * בלי קמפיין (שוטף, מבצע דחוף) — campaign = null, ומקבל את הכללי.
 * 0 בהגדרה הכללית = בלי מרווח (רק אותו יום אסור, בכלל נפרד).
 * @param {{min_gap_days?:number|null}|null} campaign
 * @param {{min_gap_days?:number|null}|null} settings שורת engine_settings
 */
export function effectiveGap(campaign, settings) {
  const own = campaign?.min_gap_days;
  if (own != null) return Number(own);
  const global = settings?.min_gap_days;
  return global != null ? Number(global) : DEFAULT_GAP_DAYS;
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
 *               (המנוע לא שם שני פוסטים של אותה נקודה באותו ערוץ בתוך המרווח),
 *               מחולק בין siblings — הקמפיינים של אותה נקודה שחולקים את
 *               הערוץ בחלון (siblingsOf): כל אחד floor(ימים/k), והשארית —
 *               יום נוסף לכל אחד מהראשונים לפי siblingRank. כך סכום החלקים
 *               לא עובר את מה שהמרווח מאפשר, ואח יכול לקבל 0.
 *               קירוב: אח שחופף רק לחלק מהחלון נספר כאילו חופף לכולו,
 *               והמרווח של האחים נחשב שווה לזה של הקמפיין — המנוע אוכף את
 *               המרווח של כל מועמד בנפרד, וכאן רק מעריכים כמה נכנס.
 *   capacity  = הקטן מביניהם; לפחות 1 כשיש יום פנוי, נתח וחלק במרווח. 0
 *               כשאין יום פנוי, כשהתקציב של הערוץ 0 (תקרה 0, או 100% שמורים
 *               לדחופים), או כשהאחים תפסו את כל הימים — המנוע לא ישבץ שם,
 *               ולכן גם לא דורשים בשבילו תוכן
 *   limitedBy = 'blocked' (כל הימים חסומים) / 'budget' (תקציב 0) /
 *               'gap' (המרווח הוא המגביל, כולל חלק 0 בין אחים) / 'rate'
 *
 * ימים חסומים: blocked_days הם מספרי ימים בשבוע (0 = ראשון), כמו
 * Date.getDay() במנוע (buildSlots / allows).
 *
 * @returns {{wanted:number, capacity:number, rateCap:number, gapCap:number, siblings:number,
 *            availableDays:number, limitedBy:'blocked'|'budget'|'gap'|'rate'}}
 *          availableDays = מספר הימים הפנויים בטווח
 */
export function channelCapacity({ from, to, channel, share, gapDays = DEFAULT_GAP_DAYS,
                                  siblings = 1, siblingRank = 0 }) {
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

  return { wanted, capacity, rateCap, gapCap, siblings: k, availableDays: available.length,
           limitedBy };
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
