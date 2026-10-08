import { rows } from './db.js';
import { POST_AT, inLocalDays, periodOf } from './stats.js';
import { presetRange } from '../public/js/core/dataPeriod.js';

/**
 * יעילות נמדדת — כמה טוב באמת עבד כל שילוב של נקודת קצה, ערוץ וזמן.
 *
 * שתי החלטות מרכזיות שבלעדיהן המספרים כאן היו חסרי משמעות:
 *
 * 1. ריק אינו אפס. מדד שלא מולא לא נחשב "0" — הוא פשוט לא משתתף
 *    בחישוב, לא במונה ולא במכנה. אפשר למלא רק את מה שבאמת יש.
 *
 * 2. נרמול בתוך הערוץ, ואז כיווץ לכיוון ניטרלי. 5,000 חשיפות בפייסבוק
 *    ו-300 בוואטסאפ הן אותו דבר אם זה הממוצע של אותו ערוץ, ולכן כל מדד
 *    מומר ליחס מול הממוצע של הערוץ שלו. ומכיוון שפוסט בודד מוצלח אינו
 *    ראיה, כל צבירה מכווצת לכיוון 1.0 לפי גודל המדגם — עם אפס דגימות
 *    התוצאה היא בדיוק ניטרלית.
 *
 * הקובץ הזה לא כותב כלום ולא תלוי במנוע, כדי ששניהם יוכלו לצרוך אותו.
 */

export const METRICS = ['reach', 'engagement', 'clicks', 'leads'];

/** ליד שווה יותר מחשיפה פסיבית — המשקל משקף את הקרבה לתוצאה העסקית */
export const METRIC_WEIGHTS = { leads: 4, clicks: 2, engagement: 1.5, reach: 1 };

export const METRIC_HE = {
  reach: 'חשיפות',
  engagement: 'מעורבות',
  clicks: 'קליקים',
  leads: 'לידים',
};

/** הגבול העליון של int ב-Postgres */
export const METRIC_MAX = 2147483647;

/**
 * המרת ערך שהוזן בטופס למספר או ל-null.
 *
 * חי כאן ולא ב-route כי זה בדיוק הכלל שכל החישוב נשען עליו: מחרוזת
 * ריקה, רווחים בלבד, או ערך חסר — כולם "לא נמדד" (null), ולא אפס.
 * אפס מפורש הוא מדידה לגיטימית ונשמר כמו שהוא.
 *
 * @throws {Error} על ערך שאינו מספר אי-שלילי, או גדול מ-METRIC_MAX
 */
export function parseMetric(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('הערכים חייבים להיות מספרים אי-שליליים');
  }
  const r = Math.round(n);
  // העמודות הן int של Postgres — מעל התקרה המסד היה זורק 500 באמצע השמירה
  if (r > METRIC_MAX) throw new Error('המספר גדול מדי');
  return r;
}

/** תקרה ליחס של פוסט בודד — פוסט ויראלי אחד לא הופך נקודה ל"יעילה" */
const RATIO_CAP = 3;

/** כמה דגימות דמה ניטרליות מתווספות לכל צבירה. גדול יותר = שמרני יותר. */
export const SHRINK_K = 5;

const NEUTRAL = 1;

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * שלושה חלונות ולא 24 שעות נפרדות: ברזולוציה של שעה בודדת כמעט לכל
 * תא יהיו אפס-שתי דגימות, והמספר לא יגיד כלום.
 */
export const HOUR_BUCKETS = {
  morning: 'בוקר (5–11)',
  noon: 'צהריים (12–16)',
  evening: 'ערב ולילה (17–4)',
};

export function hourBucket(hour) {
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 16) return 'noon';
  return 'evening';
}

/**
 * ממוצע לכל מדד בכל ערוץ, על הפוסטים שבהם המדד קיים בלבד.
 * זה בסיס ההשוואה שהופך מספרים גולמיים ליחסים בני-השוואה.
 */
export function channelBaselines(results) {
  const acc = new Map();
  for (const r of results) {
    if (!acc.has(r.channel_id)) acc.set(r.channel_id, {});
    const perMetric = acc.get(r.channel_id);
    for (const m of METRICS) {
      const v = r[m];
      if (v == null) continue;                 // ריק ≠ אפס
      if (!perMetric[m]) perMetric[m] = { sum: 0, n: 0 };
      perMetric[m].sum += Number(v);
      perMetric[m].n += 1;
    }
  }

  const out = new Map();
  for (const [channelId, perMetric] of acc) {
    const avg = {};
    for (const [m, { sum, n }] of Object.entries(perMetric)) {
      avg[m] = n > 0 ? sum / n : null;
    }
    out.set(channelId, avg);
  }
  return out;
}

/**
 * ציון יחסי לפוסט בודד: 1.0 = בדיוק ממוצע הערוץ שלו, 2.0 = פי שניים.
 * מחזיר null אם אין בפוסט אף מדד שאפשר להשוות — פוסט כזה לא נספר בכלל.
 */
export function postScore(result, baselines) {
  const base = baselines.get(result.channel_id);
  if (!base) return null;

  let num = 0;
  let den = 0;
  for (const m of METRICS) {
    const v = result[m];
    if (v == null) continue;                   // ריק ≠ אפס
    const avg = base[m];
    if (!avg) continue;                        // אין בסיס להשוואה בערוץ הזה
    const w = METRIC_WEIGHTS[m];
    num += w * Math.min(RATIO_CAP, Number(v) / avg);
    den += w;
  }
  return den > 0 ? num / den : null;
}

/**
 * ממוצע מכווץ לכיוון ניטרלי לפי גודל המדגם.
 * n=0 מחזיר בדיוק 1.0, ולכן ממד בלי נתונים לא משפיע על כלום.
 */
export function shrink(scores, k = SHRINK_K) {
  const n = scores.length;
  if (n === 0) return { score: NEUTRAL, n: 0, raw: null };
  const raw = scores.reduce((s, v) => s + v, 0) / n;
  return { score: (n * raw + k * NEUTRAL) / (n + k), n, raw };
}

/** מקבץ ציונים לפי מפתח ומכווץ כל קבוצה בנפרד */
export function aggregateBy(scored, keyFn, k = SHRINK_K) {
  const groups = new Map();
  for (const s of scored) {
    const key = keyFn(s);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.score);
  }
  const out = new Map();
  for (const [key, scores] of groups) out.set(key, shrink(scores, k));
  return out;
}

/**
 * הופך שורות גולמיות (פוסט + תוצאותיו) לציונים, ומחזיר גם את הבסיס
 * לכל ערוץ — שכבה טהורה, כדי שאפשר יהיה לבדוק אותה בלי מסד נתונים.
 */
export function scoreAll(results) {
  const baselines = channelBaselines(results);
  const scored = [];
  for (const r of results) {
    const score = postScore(r, baselines);
    if (score == null) continue;               // אין בו שום מדד להשוואה
    const at = new Date(r.published_at ?? r.scheduled_at);
    scored.push({
      post_id: r.post_id,
      endpoint_id: r.endpoint_id,
      channel_id: r.channel_id,
      dow: at.getDay(),
      bucket: hourBucket(at.getHours()),
      score,
    });
  }
  return { baselines, scored };
}

/** כל השורות שיש להן תוצאה כלשהי בתקופה ({from, to} — ימים בשעון ישראל) */
async function loadResults(period) {
  return rows(
    `select r.post_id, r.reach, r.engagement, r.clicks, r.leads,
            p.endpoint_id, p.channel_id, p.published_at, p.scheduled_at
       from post_results r
       join posts p on p.id = r.post_id
      where p.status = 'published'
        and ${inLocalDays(POST_AT)}`,
    [period.from, period.to]
  );
}

/** כמה ימים אחורה המנוע לומד (endpointNudges) — וגם השורה "מה המנוע לומד" במסך הנתונים */
export const ENGINE_WINDOW_DAYS = 180;

/** מכמה תוצאות מדודות לנקודה הביצועים שלה משפיעים על השיבוץ (סעיף 33) */
export const PERF_MIN_RESULTS = 5;

/** עד כמה הביצועים מזיזים את החשיבות — ±15% */
export const PERF_BAND = 0.15;

/**
 * המכפיל על החשיבות של נקודה לפי הביצועים שלה (סעיף 33): הציון המכווץ
 * (shrink), חסום ל-±15%, ורק מ-5 תוצאות מדודות בחלון של המנוע. פחות מזה —
 * בדיוק 1.0: נקודה לא "מרוויחה" או "מפסידה" מקום על סמך פוסט או שניים.
 * רק הממד של נקודת הקצה נכנס למנוע; ערוץ / יום / שעה מוצגים בלבד.
 * @param agg {score, n} — aggregateBy לנקודה, או null כשאין לה תוצאות
 */
export function importanceNudge(agg) {
  if (!agg || !(agg.n >= PERF_MIN_RESULTS) || !Number.isFinite(agg.score)) return NEUTRAL;
  return Math.min(NEUTRAL + PERF_BAND, Math.max(NEUTRAL - PERF_BAND, agg.score));
}

/**
 * הציון של כל נקודה בחלון של המנוע, והמכפיל שהוא נותן לחשיבות.
 * פונקציה טהורה מעל scoreAll — לבדיקות ולמסך הנתונים.
 * @returns {Map<number, {score:number, n:number, nudge:number}>}
 */
export function nudgesFrom(results) {
  const { scored } = scoreAll(results);
  const out = new Map();
  for (const [id, agg] of aggregateBy(scored, (s) => s.endpoint_id)) {
    out.set(id, { score: agg.score, n: agg.n, nudge: importanceNudge(agg) });
  }
  return out;
}

/** החלון של המנוע: ENGINE_WINDOW_DAYS הימים האחרונים כולל היום */
const engineRange = (days = ENGINE_WINDOW_DAYS) => presetRange(String(days + 1));

/**
 * טבלאות היעילות לתקופה. מחזיר לכל ממד מפה של ערך -> {score, n}.
 * צרכנים: מסך "נתונים". הטבלאות — לתקופה שנבחרה; engine — מה שהמנוע
 * באמת משתמש בו: נקודות הקצה בחלון של ENGINE_WINDOW_DAYS ימים.
 */
export async function buildPerformance(from, to) {
  const period = periodOf(from, to);
  const results = await loadResults(period);
  const endpoints = await rows('select id, name from endpoints order by id');
  const channels = await rows('select id, name from channels order by sort_order, id');

  const { scored } = scoreAll(results);

  const byEndpoint = aggregateBy(scored, (s) => s.endpoint_id);
  const byChannel = aggregateBy(scored, (s) => s.channel_id);
  const byDow = aggregateBy(scored, (s) => s.dow);
  const byBucket = aggregateBy(scored, (s) => s.bucket);

  // שילובים שנצפו בפועל, ולא מכפלה — כאן המשתמש רואה "פייסבוק · ראשון
  // בוקר" אמיתי. מוצגים רק כשיש מספיק דגימות שהמספר יגיד משהו.
  const MIN_COMBO_SAMPLES = 3;
  const combos = [...aggregateBy(scored, (s) => `${s.channel_id}|${s.dow}|${s.bucket}`)]
    .filter(([, v]) => v.n >= MIN_COMBO_SAMPLES)
    .map(([key, v]) => {
      const [channelId, dow, bucket] = key.split('|');
      return {
        channel_id: Number(channelId),
        channel_name: channels.find((c) => c.id === Number(channelId))?.name ?? '—',
        dow: Number(dow),
        dow_label: HE_DAYS[Number(dow)],
        bucket,
        bucket_label: HOUR_BUCKETS[bucket],
        ...v,
      };
    })
    .sort((a, b) => b.score - a.score);

  const named = (map, list) => list.map((x) => ({
    id: x.id,
    name: x.name,
    ...(map.get(x.id) ?? { score: NEUTRAL, n: 0, raw: null }),
  })).sort((a, b) => b.score - a.score);

  // רשימת "ממתינים להזנה" שהייתה כאן עברה ל-GET /results (src/results.js)

  // מה המנוע לומד: אותו חלון ואותו כלל כמו planWeek (endpointNudges)
  const range = engineRange();
  const nudges = nudgesFrom(await loadResults(range));

  return {
    period: { from: period.from, to: period.to, days: period.days },
    measured: scored.length,
    shrink_k: SHRINK_K,
    // תאימות ל-API (/api/v1, results.read): היה המתג מניהול; מאז סעיף 33 אין מתג,
    // והשדה נגזר — true כשלפחות נקודה אחת מקבלת עכשיו מכפיל שונה מ-1
    use_performance: [...nudges.values()].some((x) => x.nudge !== NEUTRAL),
    engine: {
      window_days: ENGINE_WINDOW_DAYS,
      from: range.from,
      to: range.to,
      min_results: PERF_MIN_RESULTS,
      band_pct: Math.round(PERF_BAND * 100),
      endpoints: endpoints.map((e) => {
        const x = nudges.get(e.id);
        return { id: e.id, name: e.name, n: x?.n ?? 0, nudge: x?.nudge ?? NEUTRAL };
      }),
    },
    endpoints: named(byEndpoint, endpoints),
    channels: named(byChannel, channels),
    days: [...byDow].map(([dow, v]) => ({ dow, label: HE_DAYS[dow], ...v }))
      .sort((a, b) => a.dow - b.dow),
    buckets: Object.keys(HOUR_BUCKETS).map((b) => ({
      bucket: b,
      label: HOUR_BUCKETS[b],
      ...(byBucket.get(b) ?? { score: NEUTRAL, n: 0, raw: null }),
    })),
    combos,
  };
}

/**
 * המכפיל על החשיבות של כל נקודה, למנוע (סעיף 33) — ENGINE_WINDOW_DAYS ימים
 * אחורה: לשיבוץ עדיף בסיס רחב ויציב על פני התקופה שמוצגת במסך. נקודה
 * בלי 5 תוצאות לא במפה (= 1.0). אין מתג: זה נדלק לבד לכל נקודה שצברה.
 * @returns {Promise<Map<number, number>>} נקודה → מכפיל (0.85..1.15)
 */
export async function endpointNudges(days = ENGINE_WINDOW_DAYS) {
  const out = new Map();
  for (const [id, x] of nudgesFrom(await loadResults(engineRange(days)))) {
    if (x.nudge !== NEUTRAL) out.set(id, x.nudge);
  }
  return out;
}
