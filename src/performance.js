import { rows } from './db.js';
import { periodOf } from './stats.js';

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

/**
 * המרת ערך שהוזן בטופס למספר או ל-null.
 *
 * חי כאן ולא ב-route כי זה בדיוק הכלל שכל החישוב נשען עליו: מחרוזת
 * ריקה, רווחים בלבד, או ערך חסר — כולם "לא נמדד" (null), ולא אפס.
 * אפס מפורש הוא מדידה לגיטימית ונשמר כמו שהוא.
 *
 * @throws {Error} על ערך שאינו מספר אי-שלילי
 */
export function parseMetric(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('הערכים חייבים להיות מספרים אי-שליליים');
  }
  return Math.round(n);
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

/** כל השורות שיש להן תוצאה כלשהי בתקופה */
async function loadResults(period) {
  return rows(
    `select r.post_id, r.reach, r.engagement, r.clicks, r.leads,
            p.endpoint_id, p.channel_id, p.published_at, p.scheduled_at
       from post_results r
       join posts p on p.id = r.post_id
      where p.status = 'published'
        and p.published_at between $1 and $2`,
    [period.start, period.end]
  );
}

/**
 * טבלאות היעילות לתקופה. מחזיר לכל ממד מפה של ערך -> {score, n}.
 * צרכנים: מסך "נתונים", והמנוע (כשהמתג use_performance דלוק).
 */
export async function buildPerformance(from, to) {
  const period = periodOf(from, to);
  const [results, endpoints, channels] = await Promise.all([
    loadResults(period),
    rows('select id, name from endpoints order by id'),
    rows('select id, name from channels order by sort_order, id'),
  ]);

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

  // פוסטים שפורסמו ועדיין אין להם שום תוצאה — רשימת המילוי
  const pending = await rows(
    `select p.id, p.title, p.published_at, p.scheduled_at,
            c.name as channel_name, e.name as endpoint_name
       from posts p
       left join channels c  on c.id = p.channel_id
       left join endpoints e on e.id = p.endpoint_id
       left join post_results r on r.post_id = p.id
      where p.status = 'published'
        and p.published_at between $1 and $2
        and r.post_id is null
      order by p.published_at desc
      limit 100`,
    [period.start, period.end]
  );

  return {
    period: { from: period.from, to: period.to, days: period.days },
    measured: scored.length,
    shrink_k: SHRINK_K,
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
    pending,
  };
}

/**
 * המפות שהמנוע צריך. תקופה ארוכה יותר מהתצוגה בכוונה — לשיבוץ עדיף
 * בסיס רחב ויציב על פני החודש האחרון בלבד.
 * @returns {Promise<{endpoint: Map<number,number>, channel: Map<number,number>,
 *                    dow: Map<number,number>, bucket: Map<string,number>}>}
 */
export async function performanceMultipliers(days = 180) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const results = await loadResults({ start, end });

  const { scored } = scoreAll(results);
  const flat = (map) => new Map([...map].map(([key, v]) => [key, v.score]));

  return {
    endpoint: flat(aggregateBy(scored, (s) => s.endpoint_id)),
    channel: flat(aggregateBy(scored, (s) => s.channel_id)),
    dow: flat(aggregateBy(scored, (s) => s.dow)),
    bucket: flat(aggregateBy(scored, (s) => s.bucket)),
    measured: scored.length,
  };
}
