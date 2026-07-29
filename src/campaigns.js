import { rows } from './db.js';
import { ymd } from './board.js';

/**
 * בריאות קמפיין.
 *
 * כמה פוסטים קמפיין צריך נגזר מאורך החיים שלו ומהתדירות הרצויה:
 *   נדרש = ceil(ימי הקמפיין / כל כמה ימים לפרסם)
 * אפשר לדרוס ידנית עם target_posts.
 *
 * "יש" נספר לפי התוכן שמשויך לקמפיין, ו"משובץ"/"פורסם" לפי הפוסטים
 * שנבנו מהתוכן הזה. ככה הספירה לא תלויה בניחושים לפי תאריכים.
 */

const DAY = 86400000;
const daysBetween = (a, b) =>
  Math.max(0, Math.round((new Date(b) - new Date(a)) / DAY)) + 1;

/**
 * המשבצות של קמפיין על ציר הזמן.
 *
 * אין טבלת משבצות — הן נגזרות: משבצת i יושבת ב-starts_on + i×cadence_days,
 * והתוכן שממלא אותה הוא זה ש-sort_order שלו הוא i+1. ככה סידור מחדש של
 * התוכן הוא בדיוק הזזה שלו על הציר.
 */
export function slotsFor(campaign, content, today = ymd(new Date())) {
  const required = requiredPosts(campaign);
  if (required === null || !campaign.starts_on) return [];

  const start = new Date(campaign.starts_on + 'T00:00:00');
  const byOrder = new Map(content.map((c) => [c.sort_order, c]));

  return Array.from({ length: required }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i * campaign.cadence_days);
    // המשבצת האחרונה לא חורגת מסוף הקמפיין
    const date = campaign.ends_on && ymd(d) > campaign.ends_on ? campaign.ends_on : ymd(d);

    const item = byOrder.get(i + 1) ?? null;
    const posts = item?.posts ?? [];
    return {
      index: i + 1,
      date,
      past: date < today,
      content: item,
      state: !item ? 'empty'
           : posts.some((p) => p.status === 'published') ? 'published'
           : posts.length ? 'scheduled'
           : 'ready',
    };
  });
}

export function requiredPosts(campaign) {
  if (campaign.target_posts != null) return campaign.target_posts;
  if (!campaign.starts_on || !campaign.ends_on) return null;
  const span = daysBetween(campaign.starts_on, campaign.ends_on);
  return Math.max(1, Math.ceil(span / Math.max(1, campaign.cadence_days)));
}

/** כל הקמפיינים עם מצב מלא. */
export async function campaignsWithHealth() {
  const [list, content, posts, assets] = await Promise.all([
    rows(`select c.*, e.name as endpoint_name, e.importance as endpoint_importance
            from campaigns c join endpoints e on e.id = c.endpoint_id
           order by c.active desc, c.starts_on nulls last, c.id`),
    rows('select * from content_items order by campaign_id, sort_order, id'),
    rows(`select p.id, p.content_id, p.status, p.scheduled_at, p.published_at,
                 p.channel_id, p.title, ch.name as channel_name
            from posts p left join channels ch on ch.id = p.channel_id
           where p.content_id is not null`),
    // בלי העמודה data — היא כבדה ולא נחוצה לתצוגה
    rows('select id, content_id, filename, mime, size_bytes from content_assets order by id'),
  ]);

  const today = ymd(new Date());

  return list.map((c) => {
    const mine = content.filter((x) => x.campaign_id === c.id);
    const ids = new Set(mine.map((x) => x.id));
    const myPosts = posts.filter((p) => ids.has(p.content_id));

    const shaped = mine.map((x) => ({
      id: x.id, title: x.title, kind: x.kind, sort_order: x.sort_order,
      body: x.body, ready_channel_ids: x.ready_channel_ids,
      evergreen: x.evergreen, reuse_after_days: x.reuse_after_days,
      endpoint_id: x.endpoint_id, campaign_id: x.campaign_id,
      assets: assets.filter((a) => a.content_id === x.id),
      posts: myPosts.filter((p) => p.content_id === x.id).map((p) => ({
        id: p.id, status: p.status, scheduled_at: p.scheduled_at,
        channel_name: p.channel_name,
      })),
    }));

    const required = requiredPosts(c);
    const have = mine.length;
    const scheduled = myPosts.filter((p) => p.status === 'scheduled' || p.status === 'pending_approval').length;
    const published = myPosts.filter((p) => p.status === 'published').length;
    const placed = scheduled + published;

    return {
      ...c,
      required,
      content_count: have,
      scheduled,
      published,
      placed,
      missing_content: required === null ? 0 : Math.max(0, required - have),
      unplaced: Math.max(0, have - placed),
      phase: phaseOf(c, today),
      status: statusOf({ c, today, required, have, placed }),
      pace: paceOf(c, today, published),
      content: shaped,
      slots: slotsFor(c, shaped),
    };
  });
}

/**
 * חלוקת השטח בפועל מול הנתח שהוגדר, לקמפיינים שרצים עכשיו.
 * החליף את strategyAllocation שעבדה על strategy_allocations.
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

  // חלון ההשוואה: מהמוקדם שבקמפיינים הרצים ועד היום
  const from = running
    .map((c) => c.starts_on)
    .filter(Boolean)
    .sort()[0] ?? today;

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
        // פער של יותר מ-8 נקודות אחוז נחשב פיגור שדורש תיקון
        lagging: c.share_pct - actual > 8,
      };
    }),
  };
}

function phaseOf(c, today) {
  if (!c.active) return 'inactive';
  if (c.starts_on && c.starts_on > today) return 'upcoming';
  if (c.ends_on && c.ends_on < today) return 'ended';
  return 'running';
}

function statusOf({ c, today, required, have, placed }) {
  const phase = phaseOf(c, today);
  if (phase === 'inactive') return { key: 'inactive', label: 'לא פעיל', tone: 'muted' };
  if (phase === 'ended') return { key: 'ended', label: 'הסתיים', tone: 'muted' };
  if (required === null) return { key: 'open', label: 'ללא תאריכים', tone: 'muted' };

  if (have < required) {
    return {
      key: 'missing_content',
      label: `חסר תוכן — ${required - have} מתוך ${required}`,
      tone: 'bad',
    };
  }
  if (placed < required) {
    return {
      key: 'needs_scheduling',
      label: `יש תוכן, חסר שיבוץ — ${placed}/${required}`,
      tone: 'warn',
    };
  }
  return { key: 'full', label: `מלא — ${placed}/${required}`, tone: 'good' };
}

/**
 * האם הקמפיין עומד בקצב שהוגדר לו, ביחס לזמן שכבר עבר ממנו.
 * קמפיין שרץ חצי מהזמן אמור להיות בערך בחצי מהפוסטים.
 */
function paceOf(c, today, published) {
  if (!c.starts_on || !c.ends_on || c.starts_on > today) return null;
  const end = c.ends_on < today ? c.ends_on : today;
  const elapsed = daysBetween(c.starts_on, end);
  const expected = Math.floor(elapsed / Math.max(1, c.cadence_days));
  return {
    elapsed_days: elapsed,
    expected_by_now: expected,
    published,
    behind: Math.max(0, expected - published),
  };
}
