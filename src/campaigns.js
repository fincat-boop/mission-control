import { rows } from './db.js';
import { ymd } from './board.js';
import { assetView } from './media.js';
import { inferPeriod, parsePeriod, periodEnd } from '../public/js/core/period.js';

/**
 * קמפיין = זוויות × מדיות.
 *
 * כל זווית היא מסר אחד, וכל מדיה מקבלת ממנה גרסה בניסוח משלה.
 * הרשת הזו היא מה שמסך התוכן מצייר, ותא ריק בה הוא חוסר גלוי.
 *
 * כמה פוסטים מגיעים לקמפיין בכל מדיה נגזר מהקצב הרצוי של המדיה,
 * מאורך הקמפיין ומהנתח שהוקצה לו — לא מתדירות שמוגדרת על הקמפיין.
 */

const DAY = 86400000;

/**
 * מספר הימים בין שני תאריכים, כולל שניהם.
 * דרך Date.UTC ולא דרך הפרש מילישניות מקומי — מעבר שעון חורף/קיץ
 * מוסיף או מוריד שעה ומקצר טווח של חודשיים ביום שלם.
 */
const daysBetween = (a, b) => {
  const p = (s) => String(s).slice(0, 10).split('-').map(Number);
  const [ay, am, ad] = p(a);
  const [by, bm, bd] = p(b);
  return Math.max(0, Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY)) + 1;
};

/**
 * הנתח שהקמפיין תופס בפועל.
 *
 * share_pct מפורש מנצח. בלעדיו הנתח נגזר מהמשקל של הקמפיין מול הקמפיינים
 * שרצים במקביל — כי קמפיין בלי נתח מוגדר לא אמור לתפוס את כל השטח.
 */
export function effectiveShare(campaign, concurrent = []) {
  if (campaign.share_pct != null) return campaign.share_pct / 100;

  const overlapping = concurrent.filter((c) =>
    c.active &&
    (!c.ends_on || !campaign.starts_on || c.ends_on >= campaign.starts_on) &&
    (!c.starts_on || !campaign.ends_on || c.starts_on <= campaign.ends_on));

  const totalWeight = overlapping.reduce((s, c) => s + (c.importance ?? 5), 0);
  if (!totalWeight) return 1;
  return (campaign.importance ?? 5) / totalWeight;
}

/** כמה פוסטים הקמפיין צריך בכל אחת מהמדיות שלו */
export function channelNeeds(campaign, channels, concurrent = []) {
  const needs = new Map();
  if (!campaign.starts_on || !campaign.ends_on) return needs;

  const weeks = daysBetween(campaign.starts_on, campaign.ends_on) / 7;
  const share = effectiveShare(campaign, concurrent);

  for (const ch of channels) {
    const rate = Number(ch.target_per_week ?? ch.max_per_week ?? 1);
    needs.set(ch.id, Math.max(1, Math.round(rate * weeks * share)));
  }
  return needs;
}

/** כמה זוויות צריך: לפי המדיה התובענית ביותר, אלא אם נקבע ידנית */
export function angleCount(campaign, needs) {
  if (campaign.target_posts != null) return campaign.target_posts;
  if (needs.size === 0) return null;
  return Math.max(...needs.values());
}

/** התאריך של זווית מספר i, פרוס אחיד על אורך הקמפיין */
function angleDate(campaign, i, total) {
  if (!campaign.starts_on) return null;
  const start = new Date(campaign.starts_on + 'T00:00:00');
  if (total <= 1 || !campaign.ends_on) return ymd(start);

  const span = daysBetween(campaign.starts_on, campaign.ends_on) - 1;
  const d = new Date(start);
  d.setDate(start.getDate() + Math.round((span * i) / (total - 1)));
  return ymd(d);
}

/**
 * הרשת המלאה של קמפיין: שורה לכל זווית, עמודה לכל מדיה.
 * מצב התא: ready / draft / not_relevant / empty
 */
export function gridFor(campaign, content, campaignChannels, today = ymd(new Date()),
                        concurrent = []) {
  const needs = channelNeeds(campaign, campaignChannels, concurrent);
  const angles = angleCount(campaign, needs);
  // Object ולא Map — כמו במסלול היציאה השני, אחרת הצרכן מקבל טיפוס אחר
  // תלוי אם יצא תוכן או לא
  if (!angles) {
    return { angles: [], needs: Object.fromEntries(needs), total_cells: 0, missing: 0, ready: 0 };
  }

  const byOrder = new Map(content.map((c) => [c.sort_order, c]));
  let missing = 0;
  let ready = 0;
  let total = 0;

  const list = Array.from({ length: angles }, (_, i) => {
    const item = byOrder.get(i + 1) ?? null;
    const date = angleDate(campaign, i, angles);

    const cells = campaignChannels.map((ch) => {
      // מדיה שצריכה פחות פוסטים מכמה שיש זוויות — העודף לא נספר כחוסר
      const beyondNeed = (needs.get(ch.id) ?? 0) < i + 1;
      const v = item?.variants?.find((x) => x.channel_id === ch.id) ?? null;
      const state = v ? v.status : (beyondNeed ? 'not_needed' : 'empty');

      if (state !== 'not_relevant' && state !== 'not_needed') {
        total += 1;
        if (state === 'ready') ready += 1;
        else missing += 1;
      }
      return {
        channel_id: ch.id,
        channel_name: ch.name,
        variant_id: v?.id ?? null,
        state,
        has_text: !!v?.body,
      };
    });

    return {
      index: i + 1,
      date,
      past: date ? date < today : false,
      content: item,
      cells,
    };
  });

  return { angles: list, needs: Object.fromEntries(needs), total_cells: total, missing, ready };
}

/**
 * קמפיין "כללי": בלי זוויות. לכל מדיה רשימת משבצות משלה, באורך הצורך שלה
 * (אותו חשבון קצב × שבועות × נתח כמו ברשת הזוויות), וכל משבצת ממולאת
 * בפריט תוכן של אותה מדיה בלבד (slot_channel_id + sort_order).
 *
 * נדרש = סכום הצרכים, מוכן = משבצות שהגרסה שלהן "מוכן", חסר = משבצות
 * ריקות. טיוטה ממלאת משבצת (לא חסרה) אבל עוד לא מוכנה. פריט שמעבר לצורך
 * (העלאה מרוכזת שגלשה) מוצג כמשבצת נוספת ולא נספר.
 *
 * מצב משבצת: ready / draft / not_relevant / empty
 */
export function generalGridFor(campaign, content, campaignChannels, today = ymd(new Date()),
                               concurrent = []) {
  const needs = channelNeeds(campaign, campaignChannels, concurrent);
  let missing = 0;
  let ready = 0;
  let total = 0;
  if (needs.size === 0) {
    return { channels: [], needs: {}, total_cells: 0, missing: 0, ready: 0 };
  }

  const channels = campaignChannels.map((ch) => {
    const need = needs.get(ch.id) ?? 0;
    const mine = content.filter((x) => x.slot_channel_id === ch.id);
    const byOrder = new Map(mine.map((x) => [x.sort_order, x]));
    const count = Math.max(need, ...mine.map((x) => x.sort_order));

    const slots = Array.from({ length: count }, (_, i) => {
      const item = byOrder.get(i + 1) ?? null;
      const v = item?.variants?.find((x) => x.channel_id === ch.id) ?? null;
      const state = item ? (v?.status ?? 'draft') : 'empty';
      const extra = i + 1 > need;
      if (!extra) {
        total += 1;
        if (state === 'ready') ready += 1;
        if (!item) missing += 1;
      }
      const date = extra ? null : angleDate(campaign, i, need);
      return {
        index: i + 1,
        date,
        past: date ? date < today : false,
        extra,
        state,
        content: item,
        variant_id: v?.id ?? null,
        has_text: !!v?.body,
      };
    });

    return { channel_id: ch.id, channel_name: ch.name, need, slots };
  });

  return { channels, needs: Object.fromEntries(needs), total_cells: total, missing, ready };
}

/**
 * האם מותר לשנות את מבנה הקמפיין. מותר רק כל עוד אין לו תוכן — אחרת
 * זוויות היו נשארות בלי מקום ברשימות של "כללי", ולהפך.
 * @returns {string|null} הודעת שגיאה, או null כשמותר
 */
export function structureChangeError(current, next, contentCount) {
  if (next == null || next === current) return null;
  if (!['angles', 'general'].includes(next)) return 'מבנה קמפיין לא מוכר';
  if (contentCount > 0) {
    return 'אי אפשר לשנות את מבנה הקמפיין אחרי שכבר נוסף לו תוכן';
  }
  return null;
}

/**
 * תאריך הסיום והתקופה שנשמרים, מתוך מה שנשלח (ומהמצב הקודם בעדכון).
 *
 *   period נשלח       → ends_on נגזר ממנו (בתקופה ידנית — ends_on שנשלח)
 *   רק תאריכים נשלחו  → נשמרים כמו שהם, והתקופה מוסקת מהם (גרירה בציר
 *                        האסטרטגיה, העוזר) — כדי שהטופס יציג אותה נכון
 *   רק starts_on זז    → בקמפיין עם תקופה קבועה, הסיום זז איתו
 *
 * @returns {{error?:string, period?:string|null, ends_on?:string|null}}
 *          אובייקט ריק = אין מה לשנות
 */
export function resolvePeriod(b, before = null) {
  const start = b.starts_on !== undefined ? b.starts_on : (before?.starts_on ?? null);

  if (b.period != null) {
    const p = parsePeriod(b.period);
    if (!p) return { error: 'תקופת הקמפיין לא תקינה' };
    if (p.unit === 'custom') {
      const end = b.ends_on !== undefined ? b.ends_on : (before?.ends_on ?? null);
      if (!end) return { error: 'בתאריך סיום ידני צריך לבחור תאריך' };
      return { period: 'custom', ends_on: end };
    }
    if (!start) return { error: 'צריך תאריך יעד לפוסט הראשון כדי לחשב את סוף התקופה' };
    return { period: b.period, ends_on: periodEnd(start, b.period) };
  }

  if (b.ends_on !== undefined) {
    return { period: start && b.ends_on ? inferPeriod(start, b.ends_on) : null, ends_on: b.ends_on };
  }

  if (b.starts_on !== undefined && before?.period && before.period !== 'custom') {
    return { period: before.period, ends_on: b.starts_on ? periodEnd(b.starts_on, before.period) : null };
  }
  return {};
}

/** כל הקמפיינים עם מצב מלא */
export async function campaignsWithHealth() {
  const [list, content, posts, assets, variants, channels, links] = await Promise.all([
    rows(`select c.*, e.name as endpoint_name, e.importance as endpoint_importance
            from campaigns c join endpoints e on e.id = c.endpoint_id
           order by c.active desc, c.starts_on nulls last, c.id`),
    rows('select * from content_items order by campaign_id, sort_order, id'),
    rows(`select p.id, p.content_id, p.status, p.scheduled_at, p.published_at,
                 p.channel_id, p.title, ch.name as channel_name
            from posts p left join channels ch on ch.id = p.channel_id
           where p.content_id is not null`),
    rows(`select id, content_id, variant_id, filename, mime, size_bytes, storage_key
            from content_assets order by id`),
    rows('select * from content_variants order by content_id, channel_id'),
    rows('select * from channels order by sort_order, id'),
    rows('select * from campaign_channels'),
  ]);

  const today = ymd(new Date());
  const channelById = new Map(channels.map((c) => [c.id, c]));

  return list.map((c) => {
    const mine = content.filter((x) => x.campaign_id === c.id);
    const ids = new Set(mine.map((x) => x.id));
    const myPosts = posts.filter((p) => ids.has(p.content_id));

    const myChannels = links
      .filter((l) => l.campaign_id === c.id)
      .map((l) => channelById.get(l.channel_id))
      .filter(Boolean)
      .sort((a, b) => a.sort_order - b.sort_order);

    const shaped = mine.map((x) => ({
      id: x.id, title: x.title, kind: x.kind, sort_order: x.sort_order,
      slot_channel_id: x.slot_channel_id,
      evergreen: x.evergreen, reuse_after_days: x.reuse_after_days,
      endpoint_id: x.endpoint_id, campaign_id: x.campaign_id,
      // קבצים משותפים לזווית מול קבצים של גרסה מסוימת
      assets: assets.filter((a) => a.content_id === x.id && !a.variant_id).map(assetView),
      variant_assets: assets.filter((a) => a.content_id === x.id && a.variant_id).map(assetView),
      variants: variants.filter((v) => v.content_id === x.id),
      posts: myPosts.filter((p) => p.content_id === x.id).map((p) => ({
        id: p.id, status: p.status, scheduled_at: p.scheduled_at,
        channel_name: p.channel_name,
      })),
    }));

    // הקמפיינים האחרים נדרשים כדי לגזור נתח לקמפיין שלא הוגדר לו אחד.
    // בקמפיין כללי אין זוויות — הרשת היא רשימת משבצות לכל מדיה.
    const general = c.structure === 'general';
    const grid = general
      ? { ...generalGridFor(c, shaped, myChannels, today, list), angles: [] }
      : gridFor(c, shaped, myChannels, today, list);

    const scheduled = myPosts.filter(
      (p) => ['scheduled', 'approved', 'publishing', 'failed', 'pending_approval'].includes(p.status)).length;
    const published = myPosts.filter((p) => p.status === 'published').length;

    // מה שהמערכת גוזרת בעצמה. נשלח תמיד — גם כשיש ערך ידני — כדי
    // שהממשק יוכל להראות "אוטומטי = כך וכך" ולא לבקש מספר בלי הקשר.
    const autoShare = Math.round(
      effectiveShare({ ...c, share_pct: null }, list) * 100);
    const autoAngles = angleCount({ ...c, target_posts: null },
      channelNeeds(c, myChannels, list));

    return {
      ...c,
      channels: myChannels,
      share_auto: autoShare,
      angles_auto: autoAngles,
      angles_required: grid.angles.length,
      angles_written: general ? 0 : mine.length,
      required: grid.total_cells,      // סך הפוסטים שהקמפיין צריך על כל המדיות
      ready: grid.ready,
      missing_content: grid.missing,
      needs: grid.needs,
      scheduled,
      published,
      placed: scheduled + published,
      phase: phaseOf(c, today),
      status: statusOf({ c, today, grid, myChannels }),
      pace: paceOf(c, today, published, grid),
      content: shaped,
      grid: grid.angles,
      // קמפיין כללי: רשימת משבצות לכל מדיה (ריק בקמפיין לפי זוויות)
      slots: general ? grid.channels : [],
    };
  });
}

function phaseOf(c, today) {
  if (c.paused_at) return 'paused';
  if (!c.active) return 'inactive';
  if (c.starts_on && c.starts_on > today) return 'upcoming';
  if (c.ends_on && c.ends_on < today) return 'ended';
  return 'running';
}

function statusOf({ c, today, grid, myChannels }) {
  const phase = phaseOf(c, today);
  if (phase === 'paused') return { key: 'paused', label: 'מושהה', tone: 'warn' };
  if (phase === 'inactive') return { key: 'inactive', label: 'לא פעיל', tone: 'muted' };
  if (phase === 'ended') return { key: 'ended', label: 'הסתיים', tone: 'muted' };
  if (myChannels.length === 0) {
    return { key: 'no_channels', label: 'לא נבחרו מדיות', tone: 'bad' };
  }
  if (!c.starts_on || !c.ends_on) {
    return { key: 'open', label: 'ללא תאריכים', tone: 'muted' };
  }
  if (grid.missing > 0) {
    return {
      key: 'missing_content',
      label: `חסרים ${grid.missing} מתוך ${grid.total_cells}`,
      tone: 'bad',
    };
  }
  return { key: 'full', label: `מלא — ${grid.ready}/${grid.total_cells}`, tone: 'good' };
}

/** האם הקמפיין עומד בקצב, ביחס לזמן שכבר עבר ממנו */
function paceOf(c, today, published, grid) {
  if (!c.starts_on || !c.ends_on || c.starts_on > today || grid.total_cells === 0) return null;
  const end = c.ends_on < today ? c.ends_on : today;
  const elapsed = daysBetween(c.starts_on, end);
  const span = daysBetween(c.starts_on, c.ends_on);
  const expected = Math.floor(grid.total_cells * (elapsed / span));
  return {
    elapsed_days: elapsed,
    expected_by_now: expected,
    published,
    behind: Math.max(0, expected - published),
  };
}

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                   'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * חלוקת השטח בין נקודות הקצה, חודש אחר חודש.
 *
 * זו התמונה האסטרטגית: לא מה קורה בקמפיין מסוים, אלא כמה מקום כל נקודת קצה
 * מקבלת לאורך הזמן. הנתח של כל חודש מנורמל ל-100% מהקמפיינים שרצים בו.
 */
export async function shareTimeline(monthsBack = 1, monthsAhead = 10) {
  const [campaigns, endpoints] = await Promise.all([
    rows('select * from campaigns where active = true and paused_at is null'),
    rows('select id, name, importance from endpoints where active = true order by importance desc, id'),
  ]);

  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const monthCount = monthsBack + 1 + monthsAhead;

  const months = Array.from({ length: monthCount }, (_, i) => {
    const start = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const end = new Date(base.getFullYear(), base.getMonth() + i + 1, 0);
    const from = ymd(start);
    const to = ymd(end);

    // הקמפיינים שנוגעים בחודש הזה
    const live = campaigns.filter((c) =>
      (!c.starts_on || c.starts_on <= to) && (!c.ends_on || c.ends_on >= from));

    const weights = new Map();
    const drivers = new Map(); // אילו קמפיינים מזינים כל נקודה בחודש הזה
    for (const c of live) {
      const w = c.share_pct != null ? c.share_pct : (c.importance ?? 5) * 5;
      weights.set(c.endpoint_id, (weights.get(c.endpoint_id) ?? 0) + w);
      if (!drivers.has(c.endpoint_id)) drivers.set(c.endpoint_id, []);
      drivers.get(c.endpoint_id).push(c.name);
    }
    const total = [...weights.values()].reduce((s, v) => s + v, 0);

    return {
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: HE_MONTHS[start.getMonth()],
      year: start.getFullYear(),
      is_now: start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth(),
      segments: endpoints
        .map((e) => ({
          endpoint_id: e.id,
          name: e.name,
          pct: total ? Math.round(((weights.get(e.id) ?? 0) / total) * 100) : 0,
          campaigns: drivers.get(e.id) ?? [],
        }))
        .filter((s) => s.pct > 0),
      campaign_count: live.length,
    };
  });

  return { endpoints, months };
}

/**
 * חלוקת השטח בפועל מול הנתח שהוגדר, לקמפיינים שרצים עכשיו.
 */
export async function currentAllocation() {
  const today = ymd(new Date());
  const running = await rows(
    `select c.*, e.name as endpoint_name
       from campaigns c join endpoints e on e.id = c.endpoint_id
      where c.active = true and c.paused_at is null and c.share_pct is not null
        and (c.starts_on is null or c.starts_on <= $1)
        and (c.ends_on is null or c.ends_on >= $1)
      order by c.share_pct desc`,
    [today]
  );
  if (running.length === 0) return { window: null, rows: [] };

  const from = running.map((c) => c.starts_on).filter(Boolean).sort()[0] ?? today;

  const counts = await rows(
    `select endpoint_id, count(*)::int as n
       from posts
      where status = 'published' and endpoint_id is not null
        and published_at >= $1::date and published_at < ($2::date + 1)
      group by endpoint_id`,
    [from, today]
  );
  const total = counts.reduce((s, c) => s + c.n, 0);
  const countMap = new Map(counts.map((c) => [c.endpoint_id, c.n]));

  return {
    window: { from, to: today, total_published: total },
    rows: running.map((c) => {
      const n = countMap.get(c.endpoint_id) ?? 0;
      const actual = total > 0 ? Math.round((n / total) * 100) : 0;
      return {
        campaign_id: c.id,
        campaign_name: c.name,
        endpoint_id: c.endpoint_id,
        endpoint_name: c.endpoint_name,
        target_pct: c.share_pct,
        actual_pct: actual,
        published: n,
        lagging: c.share_pct - actual > 8,
      };
    }),
  };
}
