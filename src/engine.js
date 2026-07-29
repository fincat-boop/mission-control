import { one, rows } from './db.js';
import { weekMeta, ymd } from './board.js';

/**
 * מנוע השיבוץ.
 *
 * הכלל המרכזי: המנוע לא נוגע בשום דבר שכבר על הלוח. הוא ממלא רק שטח פנוי,
 * ולכן אפשר להריץ אותו שוב ושוב על אותו שבוע בלי לשבור כלום.
 *
 * לכל נקודת קצה מחושב "חוב אוויר" משלושה מרכיבים, וההצעה הולכת תמיד
 * לנקודה עם החוב הגבוה ביותר שיש לה תוכן מוכן ומקום שמותר לה לשבת בו.
 */

// משקלים של רכיבי החוב. שינוי כאן משנה את אופי המנוע:
// יותר STALENESS = "אף אחד לא נשכח", יותר STRATEGY = "נצמדים ליעדי הרבעון".
const W_STALENESS = 1.0;  // כמה זמן עבר מאז שהנקודה פורסמה, ביחס לקצב שהוגדר לה
const W_STRATEGY  = 0.8;  // כמה היא מפגרת אחרי יעד האסטרטגיה
const W_IMPORTANCE = 0.5; // החשיבות הידנית שהוגדרה לה

const DEFAULT_HOUR = 10;
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * מתכנן שבוע. לא כותב כלום.
 * @param {string|Date} [anchorDate] תאריך כלשהו בתוך השבוע המבוקש
 * @returns {Promise<{week:object, placements:object[], holes:object[], notes:string[]}>}
 */
export async function planWeek(anchorDate) {
  const week = weekMeta(anchorDate);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const [settings, channels, endpoints, content, existing, campaigns] = await Promise.all([
    one('select * from engine_settings where id = 1'),
    rows('select * from channels where active = true order by sort_order, id'),
    rows('select * from endpoints where active = true'),
    rows('select * from content_items order by created_at'),
    rows(
      `select id, channel_id, endpoint_id, content_id, kind, scheduled_at, status
         from posts
        where scheduled_at >= $1 and scheduled_at <= $2
          and status in ('scheduled','published','pending_approval')`,
      [from, to]
    ),
    rows('select * from campaigns where active = true'),
  ]);

  const notes = [];
  if (channels.length === 0) notes.push('אין ערוצים פעילים.');
  if (endpoints.length === 0) notes.push('אין נקודות קצה פעילות.');
  if (content.length === 0) notes.push('אין תוכן מוכן — המנוע יסמן חורים בלבד.');

  const debts = await computeDebts(endpoints, settings);

  // מצב מתגלגל של הקיבולת. מתעדכן תוך כדי התכנון.
  const usage = buildUsage(channels, existing, settings);

  // תוכן שכבר משובץ השבוע לא יוצע שוב לאותו ערוץ
  const usedContent = new Set(
    existing.filter((p) => p.content_id).map((p) => `${p.channel_id}:${p.content_id}`)
  );

  // המרווח האחרון של כל נקודה בכל ערוץ, כדי לכבד min_gap_days
  const lastPerPair = await lastPostPerEndpointChannel();

  const placements = [];

  // כל שילוב (ערוץ, יום) שעוד יש בו מקום — מסודר כך שימים ריקים נתפסים ראשונים
  const slots = buildSlots(week, channels, usage);

  for (const slot of slots) {
    if (!usage.channelHasRoom(slot.channel_id)) continue;

    const pick = chooseForSlot({
      slot, endpoints, content, campaigns, debts, usage,
      usedContent, lastPerPair, settings, placements,
    });
    if (!pick) continue;

    const at = new Date(slot.date);
    at.setHours(DEFAULT_HOUR, 0, 0, 0);
    // התנגשות שעה באותו ערוץ באותו יום — מזיזים שעה קדימה
    let hour = DEFAULT_HOUR;
    while (usage.hourTaken(slot.channel_id, slot.dateKey, hour) && hour < 22) hour += 1;
    at.setHours(hour, 0, 0, 0);

    const placement = {
      channel_id: slot.channel_id,
      channel_name: slot.channel_name,
      endpoint_id: pick.endpoint.id,
      endpoint_name: pick.endpoint.name,
      content_id: pick.content.id,
      title: pick.content.title,
      kind: pick.content.kind,
      scheduled_at: at.toISOString(),
      date: slot.dateKey,
      day_label: `${HE_DAYS[at.getDay()]} ${at.getDate()}.${at.getMonth() + 1}`,
      time: `${String(hour).padStart(2, '0')}:00`,
      reason: pick.reason,
      score: Number(pick.score.toFixed(2)),
    };
    placements.push(placement);

    usage.take(slot.channel_id, slot.dateKey, pick.content.kind, hour);
    usedContent.add(`${slot.channel_id}:${pick.content.id}`);
    lastPerPair.set(`${pick.endpoint.id}:${slot.channel_id}`, slot.dateKey);
    debts.markScheduled(pick.endpoint.id);
  }

  const holes = findHoles({ endpoints, content, debts, channels, usage, week, existing });

  const ratio = usage.ratioReport();
  if (ratio.promoBlocked > 0) {
    notes.push(
      `נחסמו פוסטים מכירתיים כדי לשמור על יחס של ${ratio.minRatio} ערך לכל מכירתי. ` +
      `כדי לפרסם יותר מכירתי — צריך יותר תוכן ערך מוכן.`
    );
  }

  return {
    week: { start: week.start, end: week.end, label: week.label },
    placements,
    holes,
    ratio,
    notes,
  };
}

/* ========================= חוב אוויר ========================= */

async function computeDebts(endpoints, settings) {
  const lastPublished = await rows(
    `select endpoint_id, max(published_at) as last_at
       from posts where status = 'published' and endpoint_id is not null
      group by endpoint_id`
  );
  const lastMap = new Map(lastPublished.map((r) => [r.endpoint_id, r.last_at]));

  // פער מיעד האסטרטגיה של התקופה שרלוונטית להיום
  const today = ymd(new Date());
  const allocs = await rows(
    `select endpoint_id, target_pct from strategy_allocations
      where starts_on <= $1 and ends_on >= $1 and period_kind = 'quarter'`,
    [today]
  );
  const published = await rows(
    `select p.endpoint_id, count(*)::int as n
       from posts p
      where p.status = 'published' and p.endpoint_id is not null
        and p.published_at >= (select min(starts_on) from strategy_allocations
                                where starts_on <= $1 and ends_on >= $1 and period_kind = 'quarter')
      group by p.endpoint_id`,
    [today]
  );
  const totalPublished = published.reduce((s, p) => s + p.n, 0);
  const actualPct = new Map(
    published.map((p) => [p.endpoint_id, totalPublished ? (p.n / totalPublished) * 100 : 0])
  );
  const targetPct = new Map(allocs.map((a) => [a.endpoint_id, a.target_pct]));

  const now = new Date();
  const scheduledBoost = new Map(); // כמה כבר הצענו לה בריצה הזו

  const parts = new Map();
  for (const e of endpoints) {
    const lastAt = lastMap.get(e.id) ?? null;
    const daysSince = lastAt ? (now - new Date(lastAt)) / 86400000 : null;
    // נקודה שמעולם לא פורסמה מקבלת את החוב הגבוה ביותר
    const staleness = daysSince === null
      ? 2
      : daysSince / Math.max(1, e.min_days_between);

    const target = targetPct.get(e.id) ?? 0;
    const actual = actualPct.get(e.id) ?? 0;
    const deficit = Math.max(0, target - actual) / 100;

    parts.set(e.id, { staleness, deficit, importance: e.importance / 10, daysSince });
  }

  return {
    score(endpointId) {
      const p = parts.get(endpointId);
      if (!p) return 0;
      // כל שיבוץ שכבר הוצע בריצה הזו מקטין את החוב, כדי שהמנוע יתפזר
      const already = scheduledBoost.get(endpointId) ?? 0;
      return W_STALENESS * p.staleness
           + W_STRATEGY * p.deficit
           + W_IMPORTANCE * p.importance
           - already * 0.6;
    },
    parts: (id) => parts.get(id),
    markScheduled(id) {
      scheduledBoost.set(id, (scheduledBoost.get(id) ?? 0) + 1);
    },
    scheduledCount: (id) => scheduledBoost.get(id) ?? 0,
  };
}

/* ========================= קיבולת ========================= */

function buildUsage(channels, existing, settings) {
  const byChannel = new Map();
  for (const ch of channels) {
    // חלק מהקיבולת נשמר לדברים דחופים ולכן המנוע לא נוגע בו
    const reserved = Math.floor(ch.max_per_week * (ch.urgent_reserve_pct / 100));
    byChannel.set(ch.id, {
      ch,
      budget: Math.max(0, ch.max_per_week - reserved),
      used: 0,
      byKind: { promo: 0, value: 0, hybrid: 0 },
      perDay: new Map(),   // dateKey -> count
      hours: new Set(),    // `${channel}:${date}:${hour}`
    });
  }

  const promoPerDay = new Map(); // dateKey -> count (חוצה ערוצים)
  const weekKind = { promo: 0, value: 0, hybrid: 0 }; // סך השבוע בכל הערוצים
  let promoBlocked = 0; // כמה פעמים שער היחס חסם מכירתי

  for (const p of existing) {
    const u = byChannel.get(p.channel_id);
    const dateKey = ymd(new Date(p.scheduled_at));
    if (u) {
      u.used += 1;
      u.byKind[p.kind] = (u.byKind[p.kind] ?? 0) + 1;
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${p.channel_id}:${dateKey}:${new Date(p.scheduled_at).getHours()}`);
    }
    if (p.kind === 'promo') {
      promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
    }
    weekKind[p.kind] = (weekKind[p.kind] ?? 0) + 1;
  }

  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;
  const hybridWeight = Number(settings?.hybrid_weight ?? 0.5);
  const minRatio = Number(settings?.min_value_per_promo ?? 3);

  // "משולב" נספר חלקית בשני הצדדים, לפי hybrid_weight
  const promoWeight = () => weekKind.promo + weekKind.hybrid * hybridWeight;
  const valueWeight = () => weekKind.value + weekKind.hybrid * (1 - hybridWeight);

  return {
    channelHasRoom: (channelId) => {
      const u = byChannel.get(channelId);
      return !!u && u.used < u.budget;
    },
    dayCount: (channelId, dateKey) => byChannel.get(channelId)?.perDay.get(dateKey) ?? 0,
    hourTaken: (channelId, dateKey, hour) =>
      byChannel.get(channelId)?.hours.has(`${channelId}:${dateKey}:${hour}`) ?? false,

    /** האם מותר להכניס פוסט מסוג kind לערוץ ביום הזה */
    allows(channelId, dateKey, kind) {
      const u = byChannel.get(channelId);
      if (!u || u.used >= u.budget) return false;

      const capField = { promo: 'max_promo_per_week', value: 'max_value_per_week',
                         hybrid: 'max_hybrid_per_week' }[kind];
      const cap = u.ch[capField];
      if (cap != null && u.byKind[kind] >= cap) return false;

      if (kind === 'promo') {
        if ((promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return false;
        // שער היחס: מכירתי נוסף מותר רק אם יש מספיק ערך בשבוע שיאזן אותו
        if (valueWeight() < minRatio * (promoWeight() + 1)) {
          promoBlocked += 1;
          return false;
        }
      }

      return true;
    },

    take(channelId, dateKey, kind, hour) {
      const u = byChannel.get(channelId);
      if (!u) return;
      u.used += 1;
      u.byKind[kind] = (u.byKind[kind] ?? 0) + 1;
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${channelId}:${dateKey}:${hour}`);
      if (kind === 'promo') promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
      weekKind[kind] = (weekKind[kind] ?? 0) + 1;
    },

    remaining: (channelId) => {
      const u = byChannel.get(channelId);
      return u ? Math.max(0, u.budget - u.used) : 0;
    },

    ratioReport: () => ({
      promoBlocked,
      minRatio,
      value_per_promo: promoWeight() > 0
        ? Number((valueWeight() / promoWeight()).toFixed(1)) : null,
      counts: { ...weekKind },
    }),
  };
}

/**
 * כל המשבצות האפשריות, ממוינות כך שהמנוע ממלא קודם ימים ריקים —
 * ככה השבוע יוצא מפוזר ולא נערם על יום אחד.
 */
function buildSlots(week, channels, usage) {
  const slots = [];
  for (const ch of channels) {
    for (const day of week.days) {
      slots.push({
        channel_id: ch.id,
        channel_name: ch.name,
        date: new Date(`${day.date}T00:00:00`),
        dateKey: day.date,
        label: day.label,
      });
    }
  }
  return slots.sort((a, b) => {
    const busyA = usage.dayCount(a.channel_id, a.dateKey);
    const busyB = usage.dayCount(b.channel_id, b.dateKey);
    if (busyA !== busyB) return busyA - busyB;
    return a.dateKey.localeCompare(b.dateKey);
  });
}

/* ========================= בחירה למשבצת ========================= */

function chooseForSlot(ctx) {
  const { slot, endpoints, content, campaigns, debts, usage,
          usedContent, lastPerPair, settings } = ctx;

  const minGap = settings?.min_gap_days ?? 7;
  const candidates = [];

  for (const e of endpoints) {
    // מרווח מינימלי לאותה נקודה באותו ערוץ
    const lastKey = lastPerPair.get(`${e.id}:${slot.channel_id}`);
    if (lastKey) {
      const gapDays = Math.abs(
        (new Date(slot.dateKey) - new Date(lastKey)) / 86400000
      );
      if (gapDays < minGap) continue;
    }

    const ready = content.filter((c) =>
      c.endpoint_id === e.id &&
      (c.ready_channel_ids ?? []).includes(slot.channel_id) &&
      !usedContent.has(`${slot.channel_id}:${c.id}`) &&
      usage.allows(slot.channel_id, slot.dateKey, c.kind)
    );
    if (ready.length === 0) continue;

    // קמפיין שרץ בתאריך הזה מטה לכיוון תוכן מכירתי/משולב
    const inCampaign = campaigns.some((c) =>
      c.endpoint_id === e.id &&
      (!c.starts_on || c.starts_on <= slot.dateKey) &&
      (!c.ends_on || c.ends_on >= slot.dateKey)
    );
    const rank = inCampaign
      ? { promo: 0, hybrid: 1, value: 2 }
      : { value: 0, hybrid: 1, promo: 2 };
    ready.sort((a, b) => rank[a.kind] - rank[b.kind]);

    candidates.push({
      endpoint: e,
      content: ready[0],
      score: debts.score(e.id),
      inCampaign,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const p = debts.parts(best.endpoint.id);
  const bits = [];
  if (p.daysSince === null) bits.push('עוד לא פורסמה מעולם');
  else if (p.staleness >= 1) bits.push(`${Math.floor(p.daysSince)} ימים בלי פרסום`);
  if (p.deficit > 0.05) bits.push(`מפגרת ${Math.round(p.deficit * 100)} נק' אחרי יעד הרבעון`);
  if (best.inCampaign) bits.push('קמפיין רץ');
  bits.push(`חשיבות ${best.endpoint.importance}`);

  return { ...best, reason: bits.join(' · ') };
}

/* ========================= חורים ========================= */

/**
 * נקודה שהחוב שלה גבוה אבל אין לה תוכן מוכן — הלוח צריך להראות
 * שהוא מחכה לה, ולא סתם לדלג עליה בשקט.
 */
function findHoles({ endpoints, content, debts, channels, usage, week, existing }) {
  const holes = [];

  for (const e of endpoints) {
    const p = debts.parts(e.id);
    if (!p || p.staleness < 1) continue;                 // עוד בקצב
    if (debts.scheduledCount(e.id) > 0) continue;         // כבר קיבלה שיבוץ בריצה הזו
    if (existing.some((x) => x.endpoint_id === e.id)) continue; // כבר על הלוח השבוע

    const hasAnyContent = content.some((c) => c.endpoint_id === e.id);

    // ערוץ שיש בו מקום — שם נסמן את החור
    const target = channels.find((ch) => usage.remaining(ch.id) > 0);
    if (!target) continue;

    // אמצע השבוע, כדי שיישאר זמן לכתוב
    const day = week.days[3] ?? week.days[0];
    holes.push({
      channel_id: target.id,
      channel_name: target.name,
      endpoint_id: e.id,
      endpoint_name: e.name,
      kind: 'value',
      date: day.date,
      day_label: day.label,
      scheduled_at: new Date(`${day.date}T12:00:00`).toISOString(),
      reason: hasAnyContent
        ? 'יש תוכן, אבל לא מסומן כמוכן לאף ערוץ פנוי'
        : 'אין תוכן מוכן לנקודה הזו',
      days_since: p.daysSince === null ? null : Math.floor(p.daysSince),
    });
  }

  return holes;
}

/** המרווח האחרון בין נקודת קצה לערוץ, לצורך min_gap_days */
async function lastPostPerEndpointChannel() {
  const r = await rows(
    `select endpoint_id, channel_id, max(scheduled_at) as last_at
       from posts
      where endpoint_id is not null and status in ('scheduled','published','pending_approval')
      group by endpoint_id, channel_id`
  );
  return new Map(r.map((x) => [`${x.endpoint_id}:${x.channel_id}`, ymd(new Date(x.last_at))]));
}
