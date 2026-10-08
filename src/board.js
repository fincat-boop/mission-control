import { one, rows } from './db.js';
import { contentHints } from './candidates.js';
import { itemAssetsSql } from './links.js';
import { contentState } from './publish/readiness.js';
import { postIsLiveSql } from './live.js';

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

/**
 * כל כמה ימים נקודת קצה אמורה להתפרסם, בפועל — לפי החשיבות בלבד:
 * round(60 / חשיבות), בין 2 ל-30. חשיבות גבוהה יותר ⇒ קצב תכוף יותר.
 *
 * פעם היה לנקודה גם "תדירות — פעם ב-X ימים" ידנית (endpoints.min_days_between),
 * שסתרה גם את החשיבות וגם את המרווח בין פוסטים של המנוע. מ-6.10.26 היא
 * אוחדה: המרווח בין פוסטים יושב על הקמפיין (campaigns.min_gap_days, ברירת
 * מחדל — ההגדרה הכללית), והתדירות בין קמפיינים נגזרת מהחשיבות. העמודה
 * נשארת במסד, ואין מי שקורא אותה.
 */
export function effectiveCadenceDays(e) {
  return Math.min(30, Math.max(2, Math.round(60 / Math.max(1, e.importance))));
}

/** YYYY-MM-DD בזמן מקומי (בלי קפיצות UTC) */
export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** תחילת השבוע (יום ראשון) של תאריך נתון, בחצות מקומית */
export function weekStart(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error('תאריך לא תקין');
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // getDay: 0 = ראשון
  return d;
}

export function weekMeta(anchorDate) {
  const start = weekStart(anchorDate);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      date: ymd(d),
      dow: HE_DAYS[i],
      label: `${HE_DAYS[i]} ${d.getDate()}.${d.getMonth() + 1}`,
    };
  });
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  const label =
    start.getMonth() === end.getMonth()
      ? `${start.getDate()}–${end.getDate()} ${HE_MONTHS[start.getMonth()]}`
      : `${start.getDate()} ${HE_MONTHS[start.getMonth()]} – ${end.getDate()} ${HE_MONTHS[end.getMonth()]}`;

  const prev = new Date(start); prev.setDate(start.getDate() - 7);
  const next = new Date(start); next.setDate(start.getDate() + 7);

  return {
    start: ymd(start),
    end: ymd(end),
    label,
    days,
    prevWeek: ymd(prev),
    nextWeek: ymd(next),
    startDate: start,
    endDate: end,
  };
}

/**
 * מרכיב את כל מה שמסך "הלוח" צריך: השיבוצים של השבוע,
 * ניצול הקיבולת בכל ערוץ, מצב החמצן של כל נקודת קצה, וסיכום היחסים.
 */
export async function buildBoard(anchorDate) {
  const week = weekMeta(anchorDate);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  // בזו אחר זו: כל השאילתות רצות על ה-client של הבקשה, ו-pg לא מריץ
  // שאילתות במקביל על client אחד (Promise.all רק מתור אותן ומזהיר)
  const channels = await rows('select * from channels where active = true order by sort_order, id');
  const posts = await
    // שיבוצים של קמפיין מושהה, ערוץ מושבת או נקודת קצה מושבתת יורדים
    // מהלוח ולא נספרים (postIsLiveSql). הם נשארים במסד — הכול הפיך.
    // מה שכבר פורסם נשאר — זו עובדה.
    // v.status — הגרסה הספציפית למדיה שהפוסט הזה משודר בה, כדי שהלוח
    // יוכל להראות "יש תוכן" (מוכן) לעומת "יש טיוטה", לא רק "יש/אין".
    rows(
      `select p.*, u.name as assignee_name, e.name as endpoint_name, v.status as variant_status,
              v.body as variant_body, v.meta as variant_meta, chn.platform,
              -- סעיף 23: הכותרת העדכנית של התוכן (posts.title הוא העתק מרגע השיבוץ)
              ci.title as content_title,
              pr.post_id is not null as has_results
         from posts p
         left join channels chn     on chn.id = p.channel_id
         left join users u          on u.id = p.assignee_id
         left join endpoints e      on e.id = p.endpoint_id
         left join content_items ci on ci.id = p.content_id
         left join campaigns ca     on ca.id = ci.campaign_id
         left join content_variants v on v.content_id = p.content_id and v.channel_id = p.channel_id
         -- "לא נמדד" על פוסט שפורסם: שורה אחת לפוסט לכל היותר (post_id הוא המפתח)
         left join post_results pr  on pr.post_id = p.id
        where p.scheduled_at >= $1 and p.scheduled_at <= $2
          and (p.status = 'published' or ${postIsLiveSql('p')})
        order by p.scheduled_at`,
      [from, to]
    );
  const endpoints = await rows('select * from endpoints where active = true order by importance desc, id');
  const settings = await one('select * from engine_settings limit 1');

  // content_hint — לפוסט חסר תוכן: האם יש לנקודה תוכן עם ניסוח לערוץ
  // הזה שאפשר לשייך ('ready' / 'draft'), כדי שהלוח יראה "יש טיוטה". אותו
  // כלל כמו רשימת "שייך תוכן" (candidates.js) — כולל התאריך המתוכנן של
  // קמפיין מוכן — כך שהרמז לא מבטיח תוכן שהרשימה לא תציג.
  const hints = await contentHints(posts, ymd);
  for (const p of posts) p.content_hint = hints.get(p.id) ?? null;

  // תוכן ריק (כותרת בלבד) = "אין תוכן", ו"מוכן" שלא יעבור את בדיקת הפרסום =
  // "מוכן ⚠" — אותם כללים כמו בטבלת הקמפיין (סעיפים 20–21)
  const states = await postContentStates(posts);
  for (const p of posts) {
    const st = states.get(p.id);
    p.content_empty = st?.empty ?? false;
    p.ready_warn = st?.warn ?? null;
  }

  const hybridWeight = Number(settings?.hybrid_weight ?? 0.5);

  // שיבוצים לפי ערוץ ולפי יום
  const byChannel = channels.map((ch) => {
    const mine = posts.filter((p) => p.channel_id === ch.id);
    const real = mine.filter((p) => p.status !== 'hole');
    return {
      ...ch,
      used: real.length,
      days: week.days.map((day) => ({
        date: day.date,
        posts: mine
          .filter((p) => ymd(new Date(p.scheduled_at)) === day.date)
          .map(shapePost),
      })),
    };
  });

  // חמצן: כמה זמן כל נקודת קצה לא פורסמה, וכמה היא משובצת השבוע
  const lastPublished = await rows(
    `select endpoint_id, max(published_at) as last_at
       from posts
      where status = 'published' and endpoint_id is not null
      group by endpoint_id`
  );
  const lastMap = new Map(lastPublished.map((r) => [r.endpoint_id, r.last_at]));
  const now = new Date();

  const oxygen = endpoints.map((e) => {
    const lastAt = lastMap.get(e.id) ?? null;
    // תאריך פרסום עתידי לא אמור לקרות, אבל אם קרה — 0 ולא מספר שלילי
    const daysSince = lastAt
      ? Math.max(0, Math.floor((now - new Date(lastAt)) / 86400000))
      : null;
    const scheduledThisWeek = posts.filter(
      (p) => p.endpoint_id === e.id && p.status !== 'hole'
    ).length;
    const stale = daysSince === null || daysSince > effectiveCadenceDays(e);
    return {
      endpoint_id: e.id,
      name: e.name,
      days_since: daysSince,
      last_published_at: lastAt,
      scheduled_this_week: scheduledThisWeek,
      stale,
    };
  });

  // סיכום היחס בין מכירתי לערך
  const real = posts.filter((p) => p.status !== 'hole');
  const promo = real.filter((p) => p.kind === 'promo').length;
  const value = real.filter((p) => p.kind === 'value').length;
  const hybrid = real.filter((p) => p.kind === 'hybrid').length;
  const promoWeight = promo + hybrid * hybridWeight;
  const valueWeight = value + hybrid * (1 - hybridWeight);

  // מה מוסתר בגלל השהיה — כדי שהלוח לא ייראה ריק בלי הסבר
  const held = await rows(
    `select ca.name, count(*)::int as n
       from posts p
       join content_items ci on ci.id = p.content_id
       join campaigns ca     on ca.id = ci.campaign_id
      where ca.paused_at is not null and p.status <> 'published'
        and p.scheduled_at >= $1 and p.scheduled_at <= $2
      group by ca.name order by ca.name`,
    [from, to]
  );
  // נקודות מושבתות (סעיף 16) — כמו השהיה: הפוסטים שלהן לא על הלוח, וכאן
  // כמה ומי, עם קישור להפעלה מחדש. רק בערוצים פעילים (ערוץ מושבת — אין שורה)
  const heldEndpoints = await rows(
    `select e.id, e.name, count(*)::int as n
       from posts p
       join endpoints e on e.id = p.endpoint_id and not e.active
       join channels c  on c.id = p.channel_id and c.active
      where p.status <> 'published'
        and p.scheduled_at >= $1 and p.scheduled_at <= $2
      group by e.id, e.name order by e.name`,
    [from, to]
  );

  return {
    week: {
      start: week.start,
      end: week.end,
      label: week.label,
      days: week.days,
      prevWeek: week.prevWeek,
      nextWeek: week.nextWeek,
    },
    held,
    held_endpoints: heldEndpoints,
    channels: byChannel,
    oxygen,
    summary: {
      total: real.length,
      promo,
      value,
      hybrid,
      value_per_promo: promoWeight > 0 ? Number((valueWeight / promoWeight).toFixed(1)) : null,
      // הלקוח משווה מול הערך הזה במקום מול מספר קבוע — 0 אומר "בלי דרישה"
      min_value_per_promo: Number(settings?.min_value_per_promo ?? 3),
    },
  };
}

/**
 * מצב התוכן של פוסטים שיש להם תוכן משויך, בשאילתת קבצים אחת: Map(post_id →
 * {empty, warn}) מ-contentState (readiness.js) — "חסר תוכן" (טיוטה בלי טקסט
 * ובלי מדיה) ו"מוכן ⚠ <סיבה>". הקבצים — מה שהפריט יוצא איתו בערוץ
 * (itemAssetsSql: משבצת מקושרת — של המקור), כמו בפרסום ובטבלה.
 * @param list [{id, content_id, channel_id, platform, variant_status, variant_body, variant_meta}]
 *        (variant_status null = אין גרסה לערוץ)
 */
export async function postContentStates(list) {
  const mine = list.filter((p) => p.content_id);
  const out = new Map();
  if (!mine.length) return out;
  const files = await rows(
    `select x.post_id, f.id, f.mime, f.variant_id
       from unnest($1::int[], $2::int[], $3::int[]) as x(post_id, content_id, channel_id)
       cross join lateral (${itemAssetsSql('a.id, a.mime, a.variant_id',
         { item: 'x.content_id', channel: 'x.channel_id' })}) f`,
    [mine.map((p) => p.id), mine.map((p) => p.content_id), mine.map((p) => p.channel_id)]);
  for (const p of mine) {
    const variant = p.variant_status == null ? null
      : { status: p.variant_status, body: p.variant_body, meta: p.variant_meta };
    out.set(p.id, contentState({ platform: p.platform, variant,
                                 assets: files.filter((f) => f.post_id === p.id) }));
  }
  return out;
}

export function shapePost(p) {
  return {
    id: p.id,
    channel_id: p.channel_id,
    endpoint_id: p.endpoint_id,
    endpoint_name: p.endpoint_name,
    content_id: p.content_id,
    variant_status: p.variant_status,
    content_hint: p.content_hint ?? null,
    // סעיפים 20–21: תוכן משויך בלי טקסט ובלי מדיה; "מוכן" שלא יעבור פרסום
    content_empty: !!p.content_empty,
    ready_warn: p.ready_warn ?? null,
    // פוסט עם תוכן מציג את כותרת התוכן העדכנית (סעיף 23); בלי תוכן — את שלו
    title: p.content_title ?? p.title,
    kind: p.kind,
    status: p.status,
    urgent: p.urgent,
    note: p.note,
    assignee_id: p.assignee_id,
    assignee_name: p.assignee_name,
    scheduled_at: p.scheduled_at,
    time: new Date(p.scheduled_at).toTimeString().slice(0, 5),
    published_at: p.published_at,
    has_results: !!p.has_results,
    // ניוזלטר שהועבר ל-HUB — לתג "ממתין לאישור ב-HUB" (public/js/core/hubFill.js)
    ...(p.hub_transferred_at || p.hub_status
      ? { hub_status: p.hub_status ?? null, hub_transferred_at: p.hub_transferred_at ?? null } : {}),
  };
}
