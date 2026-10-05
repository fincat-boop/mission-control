/**
 * תוצאות הפוסטים — הזנה מרוכזת וסיכומים גולמיים.
 *
 * performance.js עונה על "מה עבד יחסית לממוצע" (ציון מנורמל). הקובץ הזה
 * עונה על השאלה הפשוטה שלפניה: כמה פורסם, כמה מזה נמדד, וכמה חשיפות,
 * מעורבות, קליקים ולידים יצאו — במספרים כמו שהוזנו, לפי ערוץ, נקודת קצה,
 * סוג וקמפיין.
 *
 * אותו כלל יסוד כמו שם: ריק אינו אפס. מדד שלא מולא לא נכנס לסכום ולא
 * למכנה של הממוצע, ופוסט שאין בו אף מדד אינו "נמדד".
 */

import { one, rows, tx } from './db.js';
import { METRICS, parseMetric } from './performance.js';
import { POST_AT, inLocalDays, periodOf } from './stats.js';

/** כמה שורות לכל היותר בשמירה אחת — הגנה מפני גוף ענק, לא מגבלה מעשית */
export const MAX_BATCH = 300;

export const KIND_LABELS = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };

/** סדר ההכרעה של "הכי טוב": לידים, ואם אין לידים בכלל — קליקים, ואז מעורבות */
export const TOP_ORDER = ['leads', 'clicks', 'engagement'];

/** פוסט נחשב "נמדד" רק אם יש בו לפחות מדד אחד */
export const isMeasured = (r) => METRICS.some((m) => r[m] != null);

/* ========================= צבירה (טהור) ========================= */

function emptyBucket(key, name) {
  const b = { key, name, posts: 0, measured: 0 };
  for (const m of METRICS) { b[m] = 0; b[`n_${m}`] = 0; }
  return b;
}

function addPost(b, r) {
  b.posts += 1;
  if (isMeasured(r)) b.measured += 1;
  for (const m of METRICS) {
    if (r[m] == null) continue;               // ריק ≠ אפס
    b[m] += Number(r[m]);
    b[`n_${m}`] += 1;
  }
}

/**
 * הופך דלי צבירה לשורה לתצוגה: סכומים, ממוצע לפוסט שבו המדד נמדד
 * (null כשאין אף מדידה), ואחוז הפוסטים שנמדדו.
 */
function finish(b) {
  const out = { key: b.key, name: b.name, posts: b.posts, measured: b.measured };
  for (const m of METRICS) {
    const n = b[`n_${m}`];
    out[m] = n > 0 ? b[m] : null;              // אין אף מדידה — אין סכום, לא 0
    out[`avg_${m}`] = n > 0 ? +(b[m] / n).toFixed(1) : null;
  }
  out.measured_pct = b.posts ? Math.round((b.measured / b.posts) * 100) : 0;
  return out;
}

/**
 * מסמן את השורה הטובה בטבלה. המדד: ממוצע לפוסט נמדד — לא הסכום, שמעדיף
 * סתם קבוצה גדולה. לידים קודם; אם אין בלידים במה להשוות (פחות משתי שורות
 * עם מדידה, או שכולן אפס) — קליקים, ואז מעורבות. שובר שוויון לפי הסכום.
 * @returns {{metric: string|null}} המדד שלפיו נבחר (או null — אין סימון)
 */
export function markTop(list) {
  for (const r of list) r.top = false;
  for (const m of TOP_ORDER) {
    const cands = list.filter((r) => r[`avg_${m}`] != null);
    if (cands.length < 2) continue;
    const best = cands.reduce((a, b) => {
      if (b[`avg_${m}`] !== a[`avg_${m}`]) return b[`avg_${m}`] > a[`avg_${m}`] ? b : a;
      return (b[m] ?? 0) > (a[m] ?? 0) ? b : a;
    });
    // ממוצע 0 אינו "הכי טוב" — זה רק הכי פחות גרוע
    if (best[`avg_${m}`] <= 0) continue;
    best.top = true;
    return { metric: m };
  }
  return { metric: null };
}

/**
 * הסיכום כולו משורות פוסט גולמיות — שכבה טהורה, נבדקת בלי מסד.
 * כל שורה: { channel_id, channel_name, endpoint_id, endpoint_name, kind,
 *            campaign_id, campaign_name, reach, engagement, clicks, leads }
 */
export function summarize(posts) {
  const total = emptyBucket('all', 'הכול');
  const dims = {
    by_channel: [(p) => p.channel_id, (p) => p.channel_name ?? 'ערוץ שנמחק'],
    by_endpoint: [(p) => p.endpoint_id, (p) => p.endpoint_name ?? 'בלי נקודת קצה'],
    by_kind: [(p) => p.kind, (p) => KIND_LABELS[p.kind] ?? p.kind],
    by_campaign: [(p) => p.campaign_id, (p) => p.campaign_name ?? 'בלי קמפיין'],
  };
  const maps = Object.fromEntries(Object.keys(dims).map((k) => [k, new Map()]));

  for (const p of posts) {
    addPost(total, p);
    for (const [dim, [keyFn, nameFn]] of Object.entries(dims)) {
      const key = keyFn(p) ?? null;
      const map = maps[dim];
      if (!map.has(key)) map.set(key, emptyBucket(key, nameFn(p)));
      addPost(map.get(key), p);
    }
  }

  const out = { totals: finish(total) };
  for (const dim of Object.keys(dims)) {
    // הגדול קודם; "בלי קמפיין" / "בלי נקודת קצה" תמיד בסוף
    const list = [...maps[dim].values()].map(finish)
      .sort((a, b) => (a.key == null) - (b.key == null) || b.posts - a.posts);
    out[dim] = { rows: list, top_metric: markTop(list).metric };
  }
  return out;
}

/* ========================= ולידציה (טהור) ========================= */

/** השדות שאפשר לעדכן בשורת תוצאות */
export const RESULT_FIELDS = [...METRICS, 'note'];

/**
 * בודק את כל השורות לפני שנוגעים במסד. אותם כללים כמו בהזנה מתוך חלון
 * הפוסט (PUT /posts/:id/results): ריק = null ("לא נמדד"), אחרת מספר
 * אי-שלילי שמעוגל לשלם.
 *
 * עדכון חלקי: רק שדה שמופיע בשורה נחשב "נשלח". שדה שלא נשלח לא נוגעים
 * בו — כך שני אנשים שממלאים שדות שונים של אותו פוסט לא דורסים זה את זה.
 * כל שורה מוחזרת כ-{ post_id, set: {שדה: ערך} } עם השדות שנשלחו בלבד.
 *
 * @param {unknown} items
 * @param {Map<number,string>} statusById הסטטוס של כל פוסט שנמצא במסד
 * @returns {{ok: {post_id:number, set:object}[], errors: {index:number, post_id:any, error:string}[]}}
 */
export function validateBatch(items, statusById) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: [], errors: [{ index: -1, post_id: null, error: 'אין שורות לשמירה' }] };
  }
  if (items.length > MAX_BATCH) {
    return { ok: [], errors: [{ index: -1, post_id: null,
      error: `אפשר לשמור עד ${MAX_BATCH} שורות בפעם אחת` }] };
  }

  const ok = [];
  const errors = [];
  const seen = new Set();
  items.forEach((it, index) => {
    const fail = (error) => errors.push({ index, post_id: it?.post_id ?? null, error });
    const id = Number(it?.post_id);
    if (!Number.isInteger(id) || id <= 0) return fail('מזהה פוסט לא תקין');
    if (seen.has(id)) return fail('הפוסט מופיע פעמיים באותה שמירה');
    seen.add(id);

    const status = statusById.get(id);
    if (!status) return fail('הפוסט לא נמצא');
    if (status !== 'published') return fail('אפשר להזין תוצאות רק לפוסט שפורסם');

    const set = {};
    const sent = (f) => Object.prototype.hasOwnProperty.call(it, f);
    try {
      for (const m of METRICS) if (sent(m)) set[m] = parseMetric(it[m]);
    } catch (e) {
      return fail(e.message);
    }
    if (sent('note')) set.note = it.note == null ? null : String(it.note).trim() || null;
    ok.push({ post_id: id, set });
  });
  return { ok, errors };
}

/**
 * המצב המלא של שורת התוצאות אחרי העדכון: מה שנשלח גובר, השאר נשאר כמו
 * שהיה במסד (או null אם אין עדיין שורה). clear = אחרי המיזוג לא נשאר
 * שום מדד ושום הערה — אז מוחקים את השורה והפוסט חוזר ל"לא נמדד".
 * @returns {{row: object, clear: boolean}}
 */
export function mergeResult(existing, set) {
  const row = {};
  for (const f of RESULT_FIELDS) {
    row[f] = Object.prototype.hasOwnProperty.call(set, f) ? set[f] : existing?.[f] ?? null;
  }
  return { row, clear: !isMeasured(row) && !row.note };
}

/* ========================= מסד ========================= */

/** הסינון המשותף: פורסם, ובתקופה לפי אותה הגדרה כמו /stats ו-/performance */
const IN_PERIOD = `p.status = 'published' and ${inLocalDays(POST_AT)}`;

/**
 * הפוסטים שפורסמו בתקופה, לטבלת ההזנה. בלי all — רק מי שאין לו עדיין
 * שורת תוצאות.
 */
export async function listForEntry(from, to, { all = false } = {}) {
  const period = periodOf(from, to);
  const list = await rows(
    `select p.id, p.title, p.kind, coalesce(p.published_at, p.scheduled_at) as published_at,
            p.channel_id, c.name as channel_name, e.name as endpoint_name,
            r.post_id is not null as has_results,
            r.reach, r.engagement, r.clicks, r.leads, r.note
       from posts p
       left join channels c      on c.id = p.channel_id
       left join endpoints e     on e.id = p.endpoint_id
       left join post_results r  on r.post_id = p.id
      where ${IN_PERIOD}
        ${all ? '' : 'and r.post_id is null'}
      order by coalesce(p.published_at, p.scheduled_at) desc, p.id desc
      limit 500`,
    [period.from, period.to]
  );
  // המונה בכותרת תמיד סופר את מי שעוד לא נמדד, גם כשמוצגים כולם; וכמה
  // פורסמו בכלל — כדי שמצב ריק ידע להבדיל בין "אין כלום" ל"הכול נמדד"
  const counts = await one(
    `select count(*)::int as published,
            count(*) filter (where r.post_id is null)::int as pending
       from posts p left join post_results r on r.post_id = p.id
      where ${IN_PERIOD}`,
    [period.from, period.to]
  );
  return {
    period: { from: period.from, to: period.to, days: period.days },
    published: counts.published,
    pending: counts.pending,
    posts: list,
  };
}

/** הסיכום הגולמי והפילוחים לתקופה */
export async function buildResultsSummary(from, to) {
  const period = periodOf(from, to);
  const posts = await rows(
    `select p.id, p.kind, p.channel_id, c.name as channel_name,
            p.endpoint_id, e.name as endpoint_name,
            ci.campaign_id, ca.name as campaign_name,
            r.reach, r.engagement, r.clicks, r.leads
       from posts p
       left join channels c       on c.id = p.channel_id
       left join endpoints e      on e.id = p.endpoint_id
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
       left join post_results r   on r.post_id = p.id
      where ${IN_PERIOD}`,
    [period.from, period.to]
  );
  return {
    period: { from: period.from, to: period.to, days: period.days },
    ...summarize(posts),
  };
}

/**
 * ה-upsert של שורה אחת. שורה חדשה נכנסת במצב הממוזג המלא; בהתנגשות
 * (שורה שנוצרה במקביל אחרי הקריאה) מתעדכנים רק השדות שנשלחו — שמות
 * העמודות מגיעים מ-RESULT_FIELDS בלבד, לא מהבקשה.
 */
export function upsertSql(set) {
  const cols = RESULT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(set, f));
  const updates = [...cols.map((f) => `${f} = excluded.${f}`), 'updated_at = now()'];
  return `insert into post_results (post_id, reach, engagement, clicks, leads, note)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (post_id) do update set ${updates.join(', ')}
     returning post_id, reach, engagement, clicks, leads, note`;
}

/**
 * שמירה מרוכזת. קודם בודקים הכול, ורק אם כל השורות תקינות כותבים — כולן
 * בטרנזקציה אחת. שורה לא תקינה דוחה את כל השמירה ומחזירה שגיאה לכל
 * שורה, כדי שהמסך יסמן בדיוק את מה שצריך לתקן ולא יישאר חצי שמור.
 *
 * כל שורה מעדכנת רק את השדות שנשלחו (ראו validateBatch/mergeResult).
 * השורות הקיימות ננעלות (for update) לפני המיזוג, כדי ששמירה מקבילה לא
 * תיכנס בין הקריאה לכתיבה. שורה שאחרי המיזוג ריקה לגמרי נמחקת.
 *
 * @returns {{saved:number, cleared:number, errors:object[], results:object[]}}
 */
export async function saveBatch(items) {
  const ids = Array.isArray(items)
    ? [...new Set(items.map((it) => Number(it?.post_id)).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  const found = ids.length
    ? await rows('select id, status from posts where id = any($1::int[])', [ids])
    : [];
  const { ok, errors } = validateBatch(items, new Map(found.map((p) => [p.id, p.status])));
  if (errors.length) return { saved: 0, cleared: 0, errors, results: [] };

  return tx(async (c) => {
    const { rows: current } = await c.query(
      `select post_id, reach, engagement, clicks, leads, note
         from post_results where post_id = any($1::int[]) for update`,
      [ok.map((r) => r.post_id)]
    );
    const existing = new Map(current.map((r) => [r.post_id, r]));

    const results = [];
    let cleared = 0;
    for (const { post_id, set } of ok) {
      const { row, clear } = mergeResult(existing.get(post_id), set);
      if (clear) {
        await c.query('delete from post_results where post_id = $1', [post_id]);
        cleared += 1;
        results.push({ post_id, cleared: true });
        continue;
      }
      const { rows: [saved] } = await c.query(upsertSql(set),
        [post_id, row.reach, row.engagement, row.clicks, row.leads, row.note]);
      results.push(saved);
    }
    return { saved: results.length - cleared, cleared, errors: [], results };
  });
}
