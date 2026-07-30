import { one, rows } from './db.js';

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

/**
 * כל כמה ימים נקודת קצה אמורה להתפרסם, בפועל.
 *
 * min_days_between ריק (ברירת המחדל לנקודה חדשה) אומר "תן למערכת להחליט
 * לפי החשיבות" — אחרת שני השדות (חשיבות + קצב ידני) היו סותרים זה את
 * זה בלי שום סדר. מספר מפורש הוא override מודע למקרה שיש צורך ספציפי.
 * חשיבות גבוהה יותר ⇒ קצב תכוף יותר.
 */
export function effectiveCadenceDays(e) {
  if (e.min_days_between != null) return e.min_days_between;
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

  const [channels, posts, endpoints, settings] = await Promise.all([
    rows('select * from channels where active = true order by sort_order, id'),
    // שיבוצים של קמפיין מושהה יורדים מהלוח ולא נספרים בקיבולת.
    // הם נשארים במסד — ההשהיה הפיכה.
    rows(
      `select p.*, u.name as assignee_name, e.name as endpoint_name
         from posts p
         left join users u          on u.id = p.assignee_id
         left join endpoints e      on e.id = p.endpoint_id
         left join content_items ci on ci.id = p.content_id
         left join campaigns ca     on ca.id = ci.campaign_id
        where p.scheduled_at >= $1 and p.scheduled_at <= $2
          and (ca.paused_at is null or p.status = 'published')
        order by p.scheduled_at`,
      [from, to]
    ),
    rows('select * from endpoints where active = true order by importance desc, id'),
    one('select * from engine_settings where id = 1'),
  ]);

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

function shapePost(p) {
  return {
    id: p.id,
    channel_id: p.channel_id,
    endpoint_id: p.endpoint_id,
    endpoint_name: p.endpoint_name,
    content_id: p.content_id,
    title: p.title,
    kind: p.kind,
    status: p.status,
    urgent: p.urgent,
    note: p.note,
    assignee_id: p.assignee_id,
    assignee_name: p.assignee_name,
    scheduled_at: p.scheduled_at,
    time: new Date(p.scheduled_at).toTimeString().slice(0, 5),
    published_at: p.published_at,
  };
}
