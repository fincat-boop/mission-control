import { rows } from './db.js';
import { ymd } from './board.js';

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
const daysBetween = (a, b) =>
  Math.max(0, Math.round((new Date(b) - new Date(a)) / DAY)) + 1;

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
  if (!angles) return { angles: [], needs, total_cells: 0, missing: 0, ready: 0 };

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
    rows('select id, content_id, filename, mime, size_bytes from content_assets order by id'),
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
      evergreen: x.evergreen, reuse_after_days: x.reuse_after_days,
      endpoint_id: x.endpoint_id, campaign_id: x.campaign_id,
      assets: assets.filter((a) => a.content_id === x.id),
      variants: variants.filter((v) => v.content_id === x.id),
      posts: myPosts.filter((p) => p.content_id === x.id).map((p) => ({
        id: p.id, status: p.status, scheduled_at: p.scheduled_at,
        channel_name: p.channel_name,
      })),
    }));

    // הקמפיינים האחרים נדרשים כדי לגזור נתח לקמפיין שלא הוגדר לו אחד
    const grid = gridFor(c, shaped, myChannels, today, list);

    const scheduled = myPosts.filter(
      (p) => p.status === 'scheduled' || p.status === 'pending_approval').length;
    const published = myPosts.filter((p) => p.status === 'published').length;

    return {
      ...c,
      channels: myChannels,
      angles_required: grid.angles.length,
      angles_written: mine.length,
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
    };
  });
}

function phaseOf(c, today) {
  if (!c.active) return 'inactive';
  if (c.starts_on && c.starts_on > today) return 'upcoming';
  if (c.ends_on && c.ends_on < today) return 'ended';
  return 'running';
}

function statusOf({ c, today, grid, myChannels }) {
  const phase = phaseOf(c, today);
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
    rows('select * from campaigns where active = true'),
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
    for (const c of live) {
      const w = c.share_pct != null ? c.share_pct : (c.importance ?? 5) * 5;
      weights.set(c.endpoint_id, (weights.get(c.endpoint_id) ?? 0) + w);
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
      where c.active = true and c.share_pct is not null
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
