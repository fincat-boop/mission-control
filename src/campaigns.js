import { one, rows } from './db.js';
import { ymd } from './board.js';
import { assetView } from './media.js';
import { assetOwnerId } from './links.js';
import { contentBlocker } from './publish/readiness.js';
import { inferPeriod, parsePeriod, periodEnd, spreadDate } from '../public/js/core/period.js';
import {
  averageShares, channelCapacity, effectiveGap, endToFit, gapToFit, normalizeShares, shareOf,
  siblingsOf,
} from './capacity.js';
import { loadGapDays } from './gap.js';

// הטעינה של ברירת המחדל יושבת ב-gap.js (מקום אחד); כאן רק מייצאים הלאה
// לקוראים הקיימים (routes/content.js)
export { loadGapDays };

/**
 * קמפיין = זוויות × מדיות.
 *
 * כל זווית היא מסר אחד, וכל מדיה מקבלת ממנה גרסה בניסוח משלה.
 * הרשת הזו היא מה שמסך התוכן מצייר, ותא ריק בה הוא חוסר גלוי.
 *
 * כמה פוסטים מגיעים לקמפיין בכל מדיה = כמה שהמנוע באמת יכול לשבץ לו
 * (channelCapacity ב-capacity.js): הקצב של המדיה בלי השמורה לדחופים, אורך
 * הקמפיין, הנתח שלו, הימים החסומים והמרווח בין פוסטים — לא תדירות שמוגדרת
 * על הקמפיין.
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
 * הערוצים של כל קמפיין כעמודה בשורה — siblingsOf (capacity.js) סופר לפיה
 * קמפיינים של אותה נקודה שחולקים ערוץ.
 */
const CHANNEL_IDS_SQL = `(select coalesce(array_agg(cc.channel_id order by cc.channel_id), '{}')
     from campaign_channels cc where cc.campaign_id = c.id) as channel_ids`;

/**
 * הקמפיינים עם החשיבות של נקודת הקצה שלהם והערוצים שלהם — הרשימה ש-shareOf
 * מחלק ביניהם ו-siblingsOf סופר בה. כל מי שמחשב נתח או צורך
 * (channelNeeds) טוען דרכה.
 */
export const CAMPAIGNS_WEIGHTED_SQL = `select c.*, e.importance as endpoint_importance,
       ${CHANNEL_IDS_SQL}
  from campaigns c join endpoints e on e.id = c.endpoint_id`;

/**
 * המרווח בין פוסטים של הקמפיין: מספר שלם 1–30, או null/ריק = ברירת המחדל
 * הכללית. מנרמל את b.min_gap_days במקום (מחרוזת מהטופס → מספר, '' → null),
 * כדי שהשמירה, התצוגה המקדימה והעוזר יקבלו אותו ערך. אותו טווח כמו האילוץ במסד.
 * @returns {string|null} הודעת שגיאה, או null
 */
export function gapDaysError(b) {
  if (!('min_gap_days' in b) || b.min_gap_days === undefined) return null;
  const v = b.min_gap_days;
  if (v === null || v === '') { b.min_gap_days = null; return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    return 'המרווח בין פוסטים צריך להיות מספר שלם של ימים, בין 1 ל-30';
  }
  b.min_gap_days = n;
  return null;
}

/**
 * הקיבולת של הקמפיין בכל אחת מהמדיות שלו, עם הפירוט: כמה הקצב רוצה
 * (wanted), כמה נכנס (capacity), ומה מגביל (limitedBy). הנתח נמדד על חלון
 * הקמפיין מול הקמפיינים החופפים (shareOf).
 *
 * המרווח: של הקמפיין (min_gap_days), ובלעדיו הכללי — effectiveGap, אותו
 * מרווח שהמנוע אוכף על התוכן שלו. המרווח הוא לנקודה × ערוץ, ולכן קמפיינים
 * חופפים של אותה נקודה באותו ערוץ חולקים אותו (siblings — siblingsOf).
 * @param concurrent שורות מ-CAMPAIGNS_WEIGHTED_SQL (כולל channel_ids)
 * @param opts.gapDays ברירת המחדל הכללית — engine_settings.min_gap_days (loadGapDays)
 * @returns {Map<number, {wanted, capacity, rateCap, gapCap, siblings, availableDays,
 *                        limitedBy, share, gapDays}>}
 */
export function channelCapacities(campaign, channels, concurrent = [], { gapDays = 7 } = {}) {
  const out = new Map();
  if (!campaign.starts_on || !campaign.ends_on) return out;
  const share = shareOf(campaign, concurrent);
  const gap = effectiveGap(campaign, { min_gap_days: gapDays });
  for (const ch of channels) {
    const sib = siblingsOf(campaign, concurrent, ch.id);
    out.set(ch.id, {
      ...channelCapacity({ from: campaign.starts_on, to: campaign.ends_on, channel: ch,
                           share, gapDays: gap, siblings: sib.count, siblingRank: sib.rank }),
      share,
      gapDays: gap,
      siblingRank: sib.rank,
    });
  }
  return out;
}

/**
 * תצוגה מקדימה של הקיבולת לקמפיין שבטופס — לחלון ההתאמה (לדחוס / להאריך /
 * להסתפק). אותו חשבון בדיוק כמו הרשת (channelCapacities), בלי לשמור כלום.
 *
 * לכל ערוץ: כמה הקצב רוצה (wanted), התקרה של הקצב (rate_cap), כמה נכנס
 * (capacity), כמה המרווח מאפשר (gap_cap, אחרי חלוקה בין אחים — siblings),
 * מה מגביל (limited_by), ו-gap_to_fit — המרווח הגדול ביותר שבו נכנס כל
 * הקצב (null כשהמרווח הוא לא המגביל). short = יש ערוץ שהמרווח מקצץ בו —
 * רק בהקצאה לפי קצב; בקמפיין מוכן (fixed) הקצב לא קובע כמה פוסטים יש,
 * ולכן short תמיד false והשאלה היא fixed.
 *
 * fixed — רק לקמפיין מוכן (written נשלח): התוכן קבוע, ולכן השאלה הפוכה —
 * לכל ערוץ כמה נכתב (written), התקרה של הקצב (rate_cap) והאם הקצב לבדו לא
 * מספיק (rate_short = written > rate_cap — אז דחיסה לא תעזור, רק הארכה),
 * באיזה מרווח התוכן נכנס בימים (gap_to_fit — הגדול ביותר שבו המרווח לבדו
 * מכיל את written, בלי קשר לקצב; null אם אין), ומה תאריך הסיום המוקדם
 * ביותר שבו הכול נכנס במרווח הנוכחי (end_to_fit, עד שנה מההתחלה; null אם
 * אין). מחושבים גם כשכבר נכנס — כדי שהחלון יוכל להראות כמה מקום נשאר.
 *
 * @param draft הקמפיין מהטופס (בעריכה — ממוזג על השורה השמורה), עם endpoint_importance
 * @param channels שורות channels של הערוצים שנבחרו
 * @param concurrent CAMPAIGNS_WEIGHTED_SQL — בלי השורה השמורה של draft
 * @param opts.gapDays ברירת המחדל הכללית (loadGapDays)
 * @param opts.written null, או {channel_id: כמה נכתב} בקמפיין מוכן
 */
export function capacityPreview(draft, channels, concurrent = [],
                                { gapDays = 7, written = null } = {}) {
  const gap = effectiveGap(draft, { min_gap_days: gapDays });
  const caps = channelCapacities(draft, channels, concurrent, { gapDays });
  const params = (ch, c) => ({ from: draft.starts_on, to: draft.ends_on, channel: ch,
                               share: c.share, siblings: c.siblings,
                               siblingRank: c.siblingRank });

  const list = [];
  for (const ch of channels) {
    const c = caps.get(ch.id);
    if (!c) continue;   // בלי תאריכים אין קיבולת
    list.push({
      channel_id: ch.id, name: ch.name, wanted: c.wanted, rate_cap: c.rateCap,
      capacity: c.capacity, gap_cap: c.gapCap, siblings: c.siblings, limited_by: c.limitedBy,
      gap_to_fit: c.limitedBy === 'gap' ? gapToFit(params(ch, c), c.rateCap) : null,
    });
  }

  let fixed = null;
  if (written) {
    fixed = {
      channels: channels.map((ch) => {
        const w = Number(written[ch.id] ?? 0);
        const c = caps.get(ch.id);
        // הנתח והאחים תלויים בחלון — מחושבים מחדש לכל תאריך סיום
        const capacityAt = (to) => {
          const d = { ...draft, ends_on: to };
          const sib = siblingsOf(d, concurrent, ch.id);
          return channelCapacity({ from: draft.starts_on, to, channel: ch,
                                   share: shareOf(d, concurrent), gapDays: gap,
                                   siblings: sib.count, siblingRank: sib.rank }).capacity;
        };
        return {
          channel_id: ch.id, written: w, capacity: c?.capacity ?? 0,
          rate_cap: c?.rateCap ?? 0, rate_short: !!c && w > c.rateCap,
          gap_to_fit: w > 0 && c ? gapToFit(params(ch, c), w, { gapOnly: true }) : null,
          end_to_fit: w > 0 && draft.starts_on ? endToFit(draft.starts_on, capacityAt, w) : null,
        };
      }),
    };
  }

  return {
    from: draft.starts_on ?? null, to: draft.ends_on ?? null, gap_days: gap, channels: list,
    short: !fixed && list.some((x) => x.limited_by === 'gap' && x.capacity < x.rate_cap),
    fixed,
  };
}

/**
 * capacityPreview מול המסד: הערוצים, הקמפיינים החופפים (בלי השורה השמורה
 * של הקמפיין — הטיוטה מחליפה אותה), ברירת המחדל של המרווח, וכשהקמפיין
 * מוכן — כמה נכתב לכל ערוץ, מאותה רשת שהמסך מציג (grid.needs).
 */
export async function loadCapacityPreview(draft, channelIds) {
  const ids = [...new Set((channelIds ?? []).map(Number))].filter(Number.isInteger);
  const channels = ids.length
    ? await rows('select * from channels where id = any($1::int[]) order by sort_order, id', [ids])
    : [];
  const ep = await one('select importance from endpoints where id = $1', [draft.endpoint_id]);
  const self = draft.id != null ? Number(draft.id) : null;
  const concurrent = (await rows(CAMPAIGNS_WEIGHTED_SQL)).filter((x) => x.id !== self);
  const gapDays = await loadGapDays();

  let written = null;
  if (self != null && draft.content_complete_at) {
    const items = await rows(
      'select id, sort_order, slot_channel_id from content_items where campaign_id = $1', [self]);
    const variants = await rows(
      `select v.content_id, v.channel_id, v.status from content_variants v
         join content_items ci on ci.id = v.content_id where ci.campaign_id = $1`, [self]);
    const content = items.map((it) => ({
      ...it, variants: variants.filter((v) => v.content_id === it.id) }));
    if (isCompleteMode(draft, content)) {
      const grid = draft.structure === 'general'
        ? completeGeneralGrid(draft, content, channels, ymd(new Date()))
        : completeAnglesGrid(draft, content, channels, ymd(new Date()));
      written = grid.needs;
    }
  }
  return capacityPreview({ ...draft, endpoint_importance: ep?.importance ?? 5 },
    channels, concurrent, { gapDays, written });
}

/**
 * למה לקמפיין אין אף פוסט באף ערוץ, כשזה המצב — אחרת null. בלי זה רשת
 * בגודל 0 נראית "מלא — 0/0" והמסך מסביר "אין תאריכים", כשהסיבה אחרת לגמרי.
 * @param capacities channelCapacities(...) של הקמפיין
 */
export function noRoomReason(campaign, capacities) {
  const list = [...capacities.values()];
  if (!list.length || list.some((c) => c.capacity > 0)) return null;
  if (campaign.share_pct != null && Number(campaign.share_pct) <= 0) {
    return 'לקמפיין נקבע נתח 0% מהערוצים';
  }
  if (list.every((c) => !(c.share > 0))) {
    return 'קמפיינים עם נתח קבוע תופסים את כל הערוצים בתקופה הזו';
  }
  if (list.every((c) => c.limitedBy === 'blocked')) {
    return 'כל הימים בתקופה חסומים בערוצים של הקמפיין';
  }
  if (list.every((c) => c.limitedBy === 'gap')) {
    return 'קמפיינים אחרים של אותה נקודת קצה תופסים את כל הימים שהמרווח מאפשר בערוצים של הקמפיין';
  }
  return 'בערוצים של הקמפיין אין פוסטים בשבוע שמותר לשבץ (תקרה 0, או שכולה שמורה לדחופים)';
}

/** כמה פוסטים הקמפיין צריך בכל אחת מהמדיות שלו = כמה שבאמת נכנס */
export function channelNeeds(campaign, channels, concurrent = [], opts = {}) {
  const needs = new Map();
  for (const [id, c] of channelCapacities(campaign, channels, concurrent, opts)) {
    needs.set(id, c.capacity);
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
  return spreadDate(campaign.starts_on, campaign.ends_on, i, total);
}

/**
 * "קמפיין מוכן" חל בפועל: סומן, יש תאריכים לפרוס עליהם, ויש תוכן. בלי
 * תוכן (נמחק אחרי הסימון) חוזרים להקצאה הרגילה — קמפיין בגודל אפס לא
 * אומר כלום. אותו תנאי במנוע (outsideCampaignWindow).
 */
export function isCompleteMode(campaign, content) {
  return !!(campaign.content_complete_at && campaign.starts_on && campaign.ends_on &&
            content.length);
}

/**
 * תא "מוכן" שהתוכן שלו לא יעבור את בדיקת הפרסום (אותם כללים — readiness.js),
 * למשל גרסה שסומנה לפני שהבדיקה נוספה, או שהקובץ שלה נמחק אחר כך. מחזיר את
 * הסיבה, אחרת null. הקבצים: המשותפים + של הגרסה; במשבצת (גרסה אחת) ובמשבצת
 * מקושרת (הקבצים של המקור) — כולם.
 */
export function readyWarn(item, v, ch) {
  if (!item || v?.status !== 'ready') return null;
  const all = item.variant_assets ?? [];
  const own = item.linked_to_id || item.slot_channel_id
    ? all : all.filter((a) => a.variant_id === v.id);
  return contentBlocker({ platform: ch.platform, variant: v,
                          assets: [...(item.assets ?? []), ...own] });
}

/** לפי sort_order ואז id — הסדר שבו הפריטים נפרסים על התקופה */
const byOrder = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);

/**
 * הרשת המלאה של קמפיין: שורה לכל זווית, עמודה לכל מדיה.
 * מצב התא: ready / draft / not_relevant / empty
 */
export function gridFor(campaign, content, campaignChannels, today = ymd(new Date()),
                        concurrent = [], opts = {}) {
  if (isCompleteMode(campaign, content)) {
    return completeAnglesGrid(campaign, content, campaignChannels, today);
  }
  const needs = channelNeeds(campaign, campaignChannels, concurrent, opts);
  const angles = angleCount(campaign, needs);
  // Object ולא Map — כמו במסלול היציאה השני, אחרת הצרכן מקבל טיפוס אחר
  // תלוי אם יצא תוכן או לא
  if (!angles) {
    return { angles: [], needs: Object.fromEntries(needs), total_cells: 0, missing: 0, ready: 0,
             drafts: 0, extra: extraAngles(content, new Set(), campaignChannels) };
  }

  // כל מקום ברשת מקבל זווית אחת — הראשונה לפי הסדר. זווית מעבר למספר
  // שתוכנן, או שנייה באותו מקום, לא נעלמת: היא חוזרת ב-extra.
  const atOrder = new Map();
  for (const c of [...content].sort(byOrder)) {
    if (c.sort_order >= 1 && c.sort_order <= angles && !atOrder.has(c.sort_order)) {
      atOrder.set(c.sort_order, c);
    }
  }
  let missing = 0;
  let ready = 0;
  let drafts = 0;
  let total = 0;

  const list = Array.from({ length: angles }, (_, i) => {
    const item = atOrder.get(i + 1) ?? null;
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
        if (state === 'draft') drafts += 1;
      }
      return {
        channel_id: ch.id,
        channel_name: ch.name,
        variant_id: v?.id ?? null,
        state,
        has_text: !!v?.body,
        warn: readyWarn(item, v, ch),
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

  return { angles: list, needs: Object.fromEntries(needs), total_cells: total, missing, ready,
           drafts, extra: extraAngles(content, new Set(atOrder.values()), campaignChannels) };
}

/**
 * הזוויות שאין להן מקום ברשת: מעבר למספר הזוויות שתוכנן, או כפולות במקום
 * תפוס. מוצגות בקבוצה "מעבר לתכנון" מתחת לרשת ולא נספרות בנדרש — כמו
 * משבצת מעבר לצורך בקמפיין כללי. תא בלי גרסה = not_needed.
 */
function extraAngles(content, placed, campaignChannels) {
  return [...content].sort(byOrder).filter((c) => !placed.has(c)).map((item) => ({
    index: item.sort_order,
    date: null,
    past: false,
    extra: true,
    content: item,
    cells: campaignChannels.map((ch) => {
      const v = item.variants?.find((x) => x.channel_id === ch.id) ?? null;
      return { channel_id: ch.id, channel_name: ch.name, variant_id: v?.id ?? null,
               state: v ? v.status : 'not_needed', has_text: !!v?.body,
               warn: readyWarn(item, v, ch) };
    }),
  }));
}

/**
 * רשת של קמפיין לפי זוויות שסומן "מוכן": שורה לכל זווית שנכתבה (בלי שורות
 * ריקות), פרוסות על אותה תקופה לפי הסדר. מדיה שאין לה גרסה לזווית (או
 * "לא רלוונטי") פשוט לא מקבלת אותה — התא לא נדרש. הצורך של כל מדיה = כמה
 * זוויות יש לה גרסה. טיוטה עדיין לא מוכנה, כמו תמיד.
 */
function completeAnglesGrid(campaign, content, campaignChannels, today) {
  const written = [...content].sort(byOrder);
  const needs = {};
  let missing = 0;
  let ready = 0;
  let drafts = 0;
  let total = 0;

  const list = written.map((item, i) => {
    const date = angleDate(campaign, i, written.length);
    const cells = campaignChannels.map((ch) => {
      const v = item.variants?.find((x) => x.channel_id === ch.id) ?? null;
      const state = v ? v.status : 'not_needed';
      if (state !== 'not_relevant' && state !== 'not_needed') {
        needs[ch.id] = (needs[ch.id] ?? 0) + 1;
        total += 1;
        if (state === 'ready') ready += 1;
        else missing += 1;
        if (state === 'draft') drafts += 1;
      }
      return {
        channel_id: ch.id,
        channel_name: ch.name,
        variant_id: v?.id ?? null,
        state,
        has_text: !!v?.body,
        warn: readyWarn(item, v, ch),
      };
    });
    // index = sort_order של הזווית: הלחיצה בממשק מוצאת לפיו את הפריט
    return { index: item.sort_order, date, past: date < today, content: item, cells };
  });

  for (const ch of campaignChannels) needs[ch.id] ??= 0;
  return { angles: list, needs, total_cells: total, missing, ready, drafts, complete: true,
           extra: [] };
}

/**
 * קמפיין "כללי": בלי זוויות. לכל מדיה רשימת משבצות משלה, באורך הצורך שלה
 * (אותו חשבון קיבולת כמו ברשת הזוויות — channelNeeds), וכל משבצת ממולאת
 * בפריט תוכן של אותה מדיה בלבד (slot_channel_id + sort_order).
 *
 * אותן הגדרות כמו ברשת הזוויות: נדרש = סכום הצרכים פחות משבצות שסומנו
 * "לא רלוונטי", מוכן = גרסה "מוכן", חסר = נדרש − מוכן (טיוטה עדיין חסרה),
 * וטיוטות נספרות בנפרד לתצוגה. פריט שמעבר לצורך (העלאה מרוכזת שגלשה) מוצג
 * כמשבצת נוספת ולא נספר.
 *
 * מצב משבצת: ready / draft / not_relevant / empty
 */
export function generalGridFor(campaign, content, campaignChannels, today = ymd(new Date()),
                               concurrent = [], opts = {}) {
  if (isCompleteMode(campaign, content)) {
    return completeGeneralGrid(campaign, content, campaignChannels, today);
  }
  const needs = channelNeeds(campaign, campaignChannels, concurrent, opts);
  let missing = 0;
  let ready = 0;
  let drafts = 0;
  let total = 0;
  if (needs.size === 0) {
    return { channels: [], needs: {}, total_cells: 0, missing: 0, ready: 0, drafts: 0 };
  }

  const channels = campaignChannels.map((ch) => {
    let colRequired = 0;
    let colReady = 0;
    const need = needs.get(ch.id) ?? 0;
    const mine = content.filter((x) => x.slot_channel_id === ch.id);
    const atOrder = new Map(mine.map((x) => [x.sort_order, x]));
    const count = Math.max(need, ...mine.map((x) => x.sort_order));

    const slots = Array.from({ length: count }, (_, i) => {
      const item = atOrder.get(i + 1) ?? null;
      const v = item?.variants?.find((x) => x.channel_id === ch.id) ?? null;
      const state = item ? (v?.status ?? 'draft') : 'empty';
      const extra = i + 1 > need;
      if (!extra && state !== 'not_relevant') {
        total += 1;
        colRequired += 1;
        if (state === 'ready') { ready += 1; colReady += 1; } else missing += 1;
        if (state === 'draft') drafts += 1;
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
        warn: readyWarn(item, v, ch),
      };
    });

    return { channel_id: ch.id, channel_name: ch.name, need, required: colRequired,
             ready: colReady, slots };
  });

  return { channels, needs: Object.fromEntries(needs), total_cells: total, missing, ready, drafts };
}

/**
 * קמפיין כללי שסומן "מוכן": בכל מדיה רק המשבצות שמולאו (כולל טיוטות),
 * פרוסות על אותה תקופה לפי הסדר. הצורך של המדיה = מה שמולא (בלי "לא
 * רלוונטי"); חסר = נדרש − מוכן, כלומר הטיוטות.
 */
function completeGeneralGrid(campaign, content, campaignChannels, today) {
  const needs = {};
  let missing = 0;
  let ready = 0;
  let drafts = 0;
  let total = 0;

  const channels = campaignChannels.map((ch) => {
    const mine = content.filter((x) => x.slot_channel_id === ch.id).sort(byOrder);
    let colRequired = 0;
    let colReady = 0;

    const slots = mine.map((item, i) => {
      const v = item.variants?.find((x) => x.channel_id === ch.id) ?? null;
      const state = v?.status ?? 'draft';
      if (state !== 'not_relevant') {
        total += 1;
        colRequired += 1;
        if (state === 'ready') { ready += 1; colReady += 1; } else missing += 1;
        if (state === 'draft') drafts += 1;
      }
      const date = angleDate(campaign, i, mine.length);
      // index = sort_order: הלחיצה בממשק מוצאת לפיו את הפריט
      return { index: item.sort_order, date, past: date < today, extra: false, state,
               content: item, variant_id: v?.id ?? null, has_text: !!v?.body,
               warn: readyWarn(item, v, ch) };
    });

    needs[ch.id] = colRequired;
    return { channel_id: ch.id, channel_name: ch.name, need: colRequired, required: colRequired,
             ready: colReady, slots };
  });

  return { channels, needs, total_cells: total, missing, ready, drafts, complete: true };
}

/**
 * לאילו משבצות נכנסים count קבצים חדשים: קודם המשבצות הפנויות עד הצורך,
 * לפי הסדר, ואחר כך אחרי המשבצת הגבוהה ביותר (תפוסה או נדרשת).
 * need = null (אין תאריכים) → הכול בסוף התור.
 */
export function nextSlots(need, takenOrders, count) {
  const taken = new Set(takenOrders);
  const free = [];
  for (let i = 1; need != null && i <= need; i += 1) if (!taken.has(i)) free.push(i);
  let overflowFrom = Math.max(0, ...takenOrders, need ?? 0);
  return Array.from({ length: count }, () => free.shift() ?? (overflowFrom += 1));
}

/**
 * המקומות הפנויים הבאים בקמפיין לפי זוויות — לזווית שעוברת אליו, ליצירה
 * בלי מקום מפורש, לייבוא ולהעלאה מרוכזת. אותו חשבון בדיוק כמו המסך
 * (campaignsWithHealth: כולל הנתח שנגזר מהקמפיינים החופפים), כך שהתוכן
 * ממלא את השורות הריקות שהמשתמש רואה. קמפיין מוכן — בסוף התור.
 * @returns {Promise<{slots:number[], need:number|null}>} count מקומות לפי הסדר,
 *          ומספר הזוויות שתוכנן (null — קמפיין מוכן / בלי תאריכים)
 */
export async function freeAngleSlots(campaignId, count) {
  const campaign = (await rows('select * from campaigns where id = $1', [campaignId]))[0];
  if (!campaign) return { slots: [], need: null };
  const channels = await rows(
    `select ch.* from campaign_channels cc join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`, [campaignId]);
  const concurrent = await rows(CAMPAIGNS_WEIGHTED_SQL);
  const gapDays = await loadGapDays();
  const existing = await rows(
    'select sort_order from content_items where campaign_id = $1', [campaignId]);
  const need = campaign.content_complete_at
    ? null : angleCount(campaign, channelNeeds(campaign, channels, concurrent, { gapDays }));
  return { slots: nextSlots(need, existing.map((x) => x.sort_order), count), need };
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
    if (p.unit === 'open') {
      // רק לקמפיין ישן לפי זוויות: בכללי המשבצות נפרסות על החלון ודורשות סוף
      const structure = b.structure ?? before?.structure ?? 'general';
      if (structure === 'general') return { error: 'קמפיין כללי צריך תאריך סיום' };
      return { period: 'open', ends_on: null };
    }
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

/**
 * מה יקרה בלחיצה על "קמפיין מוכן", מתוך הקמפיין כפי שהוא עכשיו (שורה של
 * campaignsWithHealth). removed_empty = המשבצות/התאים שלא נכתבו ויורדים;
 * kept_by_channel = כמה פוסטים נשארים לכל מדיה; posts/drafts = סה"כ ומתוכם
 * טיוטות. error = למה אי אפשר (בלי תאריכים / בלי תוכן).
 */
export function completionSummary(c, today = ymd(new Date())) {
  if (!c.starts_on || !c.ends_on) {
    return { error: 'לקמפיין אין תאריכים, ולכן אין על מה לפרוס את הפוסטים' };
  }
  if (!c.content?.length) return { error: 'אין בקמפיין תוכן — אין מה להשאיר' };

  const after = { ...c, content_complete_at: c.content_complete_at ?? new Date().toISOString() };
  const grid = c.structure === 'general'
    ? generalGridFor(after, c.content, c.channels, today)
    : gridFor(after, c.content, c.channels, today);
  if (!grid.total_cells) {
    return { error: 'אין בקמפיין פוסטים לערוצים שלו — אין מה לפרוס' };
  }
  return {
    removed_empty: c.complete ? 0 : Math.max(0, c.missing_content - (c.drafts ?? 0)),
    kept_by_channel: grid.needs,
    posts: grid.total_cells,
    ready: grid.ready,
    drafts: grid.drafts,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
  };
}

/** YYYY-MM-DD + n ימים, בלי להיתקל במעבר שעון */
function addDaysYmd(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}

/**
 * כמה חסר מהיום והלאה (ובתוך days ימים, אם נשלח) — מה שעוד אפשר להשלים.
 * שורה שהתאריך שלה עבר, או משבצת מעבר לצורך (בלי תאריך), לא נספרות: קודם
 * "חסרים N" כלל גם שורות שעברו, ולא היה ממה לפעול עליו.
 * @param rows [{date, cells:[{state}]}] — שורות הזוויות, או משבצת לכל שורה בכללי
 * @returns {{missing:number, total:number}} total = תאים נדרשים בטווח
 */
export function missingAhead(rows, today, days = null) {
  const end = days ? addDaysYmd(today, days) : null;
  let missing = 0;
  let total = 0;
  for (const r of rows) {
    if (!r.date || r.date < today || (end && r.date >= end)) continue;
    for (const cell of r.cells) {
      if (cell.state === 'not_relevant' || cell.state === 'not_needed') continue;
      total += 1;
      if (cell.state !== 'ready') missing += 1;
    }
  }
  return { missing, total };
}

/** פוסט שתופס את התוכן שלו בערוץ — המנוע לא ישבץ אותו שוב (contentHistory) */
const HAS_POST = ['scheduled', 'approved', 'publishing', 'published', 'pending_approval', 'failed'];
/** פוסט שעוד יוצא, או יצא — תופס מקום בקיבולת של החלון שבו הוא יושב */
const TAKES_ROOM = ['scheduled', 'approved', 'publishing', 'published', 'pending_approval'];

/** הגרסה של פריט לערוץ, כשהיא מועמדת לשיבוץ (מוכן או טיוטה — המנוע משבץ גם טיוטה) */
const variantFor = (it, ch, statuses) => {
  if (it.slot_channel_id && it.slot_channel_id !== ch.id) return null;   // fitsSlotChannel
  const v = it.variants?.find((x) => x.channel_id === ch.id);
  return v && statuses.includes(v.status) ? v : null;
};

/**
 * התוכן של קמפיין שעוד אין לו פוסט, מול המקום שנשאר לו עד הסוף.
 *
 * לכל ערוץ של הקמפיין: כמה גרסאות (מוכן או טיוטה) של התוכן שלו אין להן
 * פוסט בערוץ (without), וכמה מקום נשאר מ-max(היום, תחילת הקמפיין) עד הסוף —
 * channelCapacity על החלון שנשאר, עם הנתח, המרווח והאחים של אותו חלון,
 * פחות מה שכבר על הלוח בחלון הזה (free). מה שנכנס במקום שנשאר — waiting
 * (יחכה לשיבוץ); השאר — unplaced: לא ייכנס עד הסוף, ובלי התראה היה נעלם
 * בשקט (המנוע לא משבץ תוכן של קמפיין אחרי ends_on).
 *
 * פוסט שנכשל נספר כ"יש פוסט": המנוע לא ישבץ את התוכן שוב, ויש לו התראה משלו.
 * בלי תאריכים, או אחרי הסוף — אין חלון, הכול 0.
 * @param items הזוויות/המשבצות של הקמפיין, כל אחת עם variants
 * @param myPosts הפוסטים של התוכן של הקמפיין (content_id, channel_id, status, scheduled_at)
 * @param concurrent CAMPAIGNS_WEIGHTED_SQL — לנתח ולאחים בחלון שנשאר
 * @returns {{unplaced:number, waiting:number, by_channel:Object<number,
 *            {without:number, free:number, unplaced:number}>}}
 */
export function unplacedOf(c, items, myChannels, myPosts, concurrent = [],
                           { gapDays = 7, today = ymd(new Date()) } = {}) {
  const out = { unplaced: 0, waiting: 0, by_channel: {} };
  if (!c.starts_on || !c.ends_on) return out;
  const from = c.starts_on > today ? c.starts_on : today;
  if (from > c.ends_on) return out;

  const posted = new Set(myPosts.filter((p) => HAS_POST.includes(p.status))
    .map((p) => `${p.content_id}:${p.channel_id}`));
  // החלון שנשאר: הנתח והאחים נמדדים עליו, לא על כל הקמפיין
  const caps = channelCapacities({ ...c, starts_on: from }, myChannels, concurrent, { gapDays });

  for (const ch of myChannels) {
    const without = items.filter((it) => variantFor(it, ch, ['ready', 'draft']) &&
      !posted.has(`${it.id}:${ch.id}`)).length;
    const taken = myPosts.filter((p) => p.channel_id === ch.id && TAKES_ROOM.includes(p.status) &&
      ymd(new Date(p.scheduled_at)) >= from).length;
    const free = Math.max(0, (caps.get(ch.id)?.capacity ?? 0) - taken);
    const fits = Math.min(without, free);
    out.by_channel[ch.id] = { without, free, unplaced: without - fits };
    out.waiting += fits;
    out.unplaced += without - fits;
  }
  return out;
}

/**
 * קמפיין שהסתיים: כמה גרסאות מוכנות של התוכן שלו לא פורסמו ואין להן פוסט
 * שעוד יוצא — מה שנשאר על המדף כשהקמפיין נגמר. טיוטות לא נספרות (לא היו
 * מוכנות לצאת), וגם לא גרסה לערוץ שכבר לא בקמפיין.
 */
export function unpublishedReady(items, myChannels, myPosts, now = new Date()) {
  const out = new Set(myPosts.filter((p) => p.status === 'published' ||
      (TAKES_ROOM.includes(p.status) && new Date(p.scheduled_at) > now))
    .map((p) => `${p.content_id}:${p.channel_id}`));
  let n = 0;
  for (const ch of myChannels) {
    n += items.filter((it) => variantFor(it, ch, ['ready']) && !out.has(`${it.id}:${ch.id}`)).length;
  }
  return n;
}

/** כל הקמפיינים עם מצב מלא */
export async function campaignsWithHealth() {
  const list = await rows(`select c.*, e.name as endpoint_name, e.importance as endpoint_importance,
               ${CHANNEL_IDS_SQL}
          from campaigns c join endpoints e on e.id = c.endpoint_id
         order by c.active desc, c.starts_on nulls last, c.id`);
  const content = await rows('select * from content_items order by campaign_id, sort_order, id');
  const posts = await rows(`select p.id, p.content_id, p.status, p.scheduled_at, p.published_at,
               p.channel_id, p.title, ch.name as channel_name
          from posts p left join channels ch on ch.id = p.channel_id
         where p.content_id is not null`);
  const assets = await rows(`select id, content_id, variant_id, filename, mime, size_bytes, storage_key
          from content_assets order by id`);
  const variants = await rows('select * from content_variants order by content_id, channel_id');
  const channels = await rows('select * from channels order by sort_order, id');
  const links = await rows('select * from campaign_channels');
  const gapDays = await loadGapDays();

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
      // משבצת מקושרת (ראו src/links.js): העוקבת מצביעה על המקור
      linked_to_id: x.linked_to_id ?? null,
      evergreen: x.evergreen, reuse_after_days: x.reuse_after_days,
      endpoint_id: x.endpoint_id, campaign_id: x.campaign_id,
      // קבצים משותפים לזווית מול קבצים של גרסה מסוימת. משבצת מקושרת מציגה
      // את הקבצים של המקור — הם יושבים רק שם.
      assets: assets.filter((a) => a.content_id === assetOwnerId(x) && !a.variant_id).map(assetView),
      variant_assets: assets.filter((a) => a.content_id === assetOwnerId(x) && a.variant_id)
        .map(assetView),
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
      ? { ...generalGridFor(c, shaped, myChannels, today, list, { gapDays }), angles: [] }
      : gridFor(c, shaped, myChannels, today, list, { gapDays });

    const scheduled = myPosts.filter(
      (p) => ['scheduled', 'approved', 'publishing', 'failed', 'pending_approval'].includes(p.status)).length;
    const published = myPosts.filter((p) => p.status === 'published').length;

    // מה שהמערכת גוזרת בעצמה. נשלח תמיד — גם כשיש ערך ידני — כדי
    // שהממשק יוכל להראות "אוטומטי = כך וכך" ולא לבקש מספר בלי הקשר.
    const autoShare = Math.round(shareOf({ ...c, share_pct: null }, list) * 100);
    // קמפיין שאין לו מקום באף ערוץ — מצב משלו, לא "מלא — 0/0"
    const noRoom = grid.complete
      ? null : noRoomReason(c, channelCapacities(c, myChannels, list, { gapDays }));
    const autoAngles = angleCount({ ...c, target_posts: null },
      channelNeeds(c, myChannels, list, { gapDays }));

    // מה עוד חסר מהיום והלאה — רק בקמפיין שרץ או מתוכנן (מושהה/הסתיים: 0)
    const phase = phaseOf(c, today);
    const live = phase === 'running' || phase === 'upcoming';
    const rowsOf = general
      ? grid.channels.flatMap((ch) => ch.slots.filter((x) => !x.extra)
        .map((x) => ({ date: x.date, cells: [x] })))
      : grid.angles;
    const ahead = live ? missingAhead(rowsOf, today) : { missing: 0, total: 0 };
    const week = live ? missingAhead(rowsOf, today, 7) : { missing: 0, total: 0 };
    // תוכן בלי פוסט מול המקום שנשאר עד הסוף (רץ / מתוכנן), ובקמפיין שהסתיים —
    // מה שמוכן ולא יצא
    const room = live
      ? unplacedOf(c, shaped, myChannels, myPosts, list, { gapDays, today })
      : { unplaced: 0, waiting: 0, by_channel: {} };
    const leftover = phase === 'ended' ? unpublishedReady(shaped, myChannels, myPosts) : 0;

    return {
      ...c,
      channels: myChannels,
      share_auto: autoShare,
      angles_auto: autoAngles,
      angles_required: grid.angles.length,
      angles_written: general ? 0 : mine.length,
      required: grid.total_cells,      // סך הפוסטים שהקמפיין צריך על כל המדיות
      ready: grid.ready,
      // טיוטות הן חלק מהחסר (לא מוכנות) — נשלחות בנפרד רק לתצוגה
      drafts: grid.drafts,
      missing_content: grid.missing,
      needs: grid.needs,
      scheduled,
      published,
      placed: scheduled + published,
      // "קמפיין מוכן" חל בפועל (סומן, יש תאריכים ותוכן) — הרשת בגודל התוכן
      complete: grid.complete === true,
      // החסר מהיום והלאה, ובשבעת הימים הקרובים — מה שעוד אפשר להשלים
      missing_ahead: ahead.missing,
      total_ahead: ahead.total,
      missing_week: week.missing,
      // תוכן שלא ייכנס עד סוף הקמפיין / שעוד יחכה לשיבוץ (unplacedOf)
      unplaced: room.unplaced,
      waiting: room.waiting,
      unplaced_by_channel: room.by_channel,
      // קמפיין שהסתיים: גרסאות מוכנות שלא פורסמו (unpublishedReady)
      unpublished_ready: leftover,
      phase,
      status: statusOf({ c, today, grid, myChannels, ahead, noRoom, unplaced: room.unplaced }),
      // למה אין לקמפיין משבצות (null = יש) — המסך מסביר את זה במקום "אין תאריכים"
      no_room_reason: noRoom,
      pace: paceOf(c, today, published, grid),
      content: shaped,
      grid: grid.angles,
      // זוויות שאין להן מקום ברשת (מעבר לתכנון / כפולות) — מוצגות מתחת לה
      grid_extra: grid.extra ?? [],
      // קמפיין כללי: רשימת משבצות לכל מדיה (ריק בקמפיין לפי זוויות)
      slots: general ? grid.channels : [],
      // פוסטים במשבצות של מדיות שהוסרו מהקמפיין — נשמרים ולא משובצים
      orphaned: general
        ? mine.filter((x) => x.slot_channel_id &&
            !myChannels.some((ch) => ch.id === x.slot_channel_id)).length
        : 0,
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

/**
 * מצב הקמפיין לתג ברשימה. unplaced > 0 (unplacedOf) לא מקבל מצב משלו — הוא
 * נוסף כסיבה (reason, ה-tooltip של התג) לכל מצב של קמפיין שרץ או מתוכנן,
 * כי הוא יכול לבוא יחד עם "חסרים" או "מלא".
 */
export function statusOf({ c, today, grid, myChannels, ahead = null, noRoom = null,
                           unplaced = 0 }) {
  const st = baseStatus({ c, today, grid, myChannels, ahead, noRoom });
  if (!(unplaced > 0) || ['paused', 'inactive', 'ended'].includes(st.key)) return st;
  const note = unplaced === 1
    ? 'פוסט אחד לא ייכנס עד סוף הקמפיין'
    : `${unplaced} פוסטים לא ייכנסו עד סוף הקמפיין`;
  return { ...st, reason: st.reason ? `${st.reason} · ${note}` : note, unplaced };
}

function baseStatus({ c, today, grid, myChannels, ahead, noRoom }) {
  const phase = phaseOf(c, today);
  if (phase === 'paused') return { key: 'paused', label: 'מושהה', tone: 'warn' };
  if (phase === 'inactive') return { key: 'inactive', label: 'לא פעיל', tone: 'muted' };
  if (phase === 'ended') return { key: 'ended', label: 'הסתיים', tone: 'muted' };
  if (myChannels.length === 0) {
    return { key: 'no_channels', label: 'לא נבחרו ערוצים', tone: 'bad' };
  }
  if (!c.starts_on || !c.ends_on) {
    return { key: 'open', label: 'ללא תאריכים', tone: 'muted' };
  }
  if (grid.complete) {
    // לא "חסר": הקמפיין בגודל מה שנכתב. מה שנשאר הוא לסיים טיוטות.
    if (grid.missing > 0) {
      return {
        key: 'complete_drafts',
        label: `מוכן · ${grid.missing === 1 ? 'טיוטה אחת' : `${grid.missing} טיוטות`} לסיום`,
        tone: 'warn',
      };
    }
    return { key: 'complete', label: `מוכן — ${grid.ready}/${grid.total_cells}`, tone: 'good' };
  }
  // אין לקמפיין מקום באף ערוץ (noRoomReason) — לא "מלא", גם אם 0 מתוך 0
  if (noRoom) {
    return { key: 'no_room', label: 'אין מקום בערוצים', tone: 'warn', reason: noRoom };
  }
  // החסר נספר מהיום והלאה — שורה שעברה כבר לא תושלם (ahead חסר: הכול, כמו קודם)
  const missing = ahead ? ahead.missing : grid.missing;
  const total = ahead ? ahead.total : grid.total_cells;
  if (missing > 0) {
    return { key: 'missing_content', label: `חסרים ${missing} מתוך ${total}`, tone: 'bad' };
  }
  if (grid.missing > 0) {
    return { key: 'full_ahead', label: 'מלא מהיום והלאה', tone: 'good' };
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
 * מקבלת לאורך הזמן. הנתח של נקודה בחודש = סכום הנתחים של הקמפיינים שלה,
 * כל אחד ממוצע הנתח היומי שלו בחודש (averageShares — אותו חשבון כמו הרשת
 * והמנוע). קמפיין שרץ חצי חודש נספר בחצי. הסכום לא עובר 100%; כשכל הקמפיינים קבועים ומתחת ל-100%, היתרה
 * היא של התוכן השוטף ולא מוצגת כאן.
 */
export async function shareTimeline(monthsBack = 1, monthsAhead = 10) {
  const campaigns = await rows(
    `${CAMPAIGNS_WEIGHTED_SQL} where c.active = true and c.paused_at is null`);
  const endpoints = await rows('select id, name, importance from endpoints where active = true order by importance desc, id');

  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  const monthCount = monthsBack + 1 + monthsAhead;

  const months = Array.from({ length: monthCount }, (_, i) => {
    const start = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const end = new Date(base.getFullYear(), base.getMonth() + i + 1, 0);
    const from = ymd(start);
    const to = ymd(end);

    // הקמפיינים שנוגעים בחודש הזה, והנתח הממוצע של כל אחד מהם בחודש
    const shares = averageShares(campaigns, { from, to });
    const live = campaigns.filter((c) => shares.has(c.id));

    const weights = new Map();
    const drivers = new Map(); // אילו קמפיינים מזינים כל נקודה בחודש הזה
    for (const c of live) {
      weights.set(c.endpoint_id, (weights.get(c.endpoint_id) ?? 0) + shares.get(c.id));
      if (!drivers.has(c.endpoint_id)) drivers.set(c.endpoint_id, []);
      drivers.get(c.endpoint_id).push(c.name);
    }

    return {
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      label: HE_MONTHS[start.getMonth()],
      year: start.getFullYear(),
      is_now: start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth(),
      segments: endpoints
        .map((e) => ({
          endpoint_id: e.id,
          name: e.name,
          pct: Math.round((weights.get(e.id) ?? 0) * 100),
          campaigns: drivers.get(e.id) ?? [],
        }))
        .filter((s) => s.pct > 0),
      campaign_count: live.length,
    };
  });

  return { endpoints, months };
}

/**
 * חלוקת השטח בפועל מול הנתח, לקמפיינים שרצים עכשיו — שורה לכל קמפיין.
 *
 * הנתח (target_pct): הנתח המנורמל של הקמפיין היום (normalizeShares — אותו
 * חשבון כמו הרשת והמנוע): share_pct שנקבע ידנית (מוקטן אם הסכום עובר 100%),
 * ובלעדיו חלק מהיתרה לפי חשיבות נקודת הקצה. נמדד על היום ולא על החלון של
 * כל קמפיין, כדי שהשורות יהיו מאותו בסיס והסכום שלהן לא יעבור 100%.
 * auto = הנתח נגזר, לא נקבע. בפועל (actual_pct): הפרסומים של התוכן של
 * הקמפיין מתוך הפרסומים של כל הקמפיינים בטבלה — אותו בסיס כמו הנתח, שמתחלק
 * בין קמפיינים (תוכן שוטף ופוסטים בלי תוכן לא נספרים בשום צד).
 */
export async function currentAllocation() {
  const today = ymd(new Date());
  const shares = normalizeShares(await rows(CAMPAIGNS_WEIGHTED_SQL), { from: today, to: today });
  const running = await rows(
    `select c.*, e.name as endpoint_name
       from campaigns c join endpoints e on e.id = c.endpoint_id
      where c.active = true and c.paused_at is null
        and (c.starts_on is null or c.starts_on <= $1)
        and (c.ends_on is null or c.ends_on >= $1)
      order by c.id`,
    [today]
  );
  if (running.length === 0) return { window: null, rows: [] };

  const from = running.map((c) => c.starts_on).filter(Boolean).sort()[0] ?? today;

  const counts = await rows(
    `select ci.campaign_id, count(*)::int as n
       from posts p join content_items ci on ci.id = p.content_id
      where p.status = 'published' and ci.campaign_id = any($3::int[])
        and p.published_at >= $1::date and p.published_at < ($2::date + 1)
      group by ci.campaign_id`,
    [from, today, running.map((c) => c.id)]
  );
  const total = counts.reduce((s, c) => s + c.n, 0);
  const countMap = new Map(counts.map((c) => [c.campaign_id, c.n]));

  return {
    window: { from, to: today, total_published: total },
    rows: running.map((c) => {
      const n = countMap.get(c.id) ?? 0;
      const actual = total > 0 ? Math.round((n / total) * 100) : 0;
      const target = Math.round((shares.get(c.id) ?? 0) * 100);
      return {
        campaign_id: c.id,
        campaign_name: c.name,
        endpoint_id: c.endpoint_id,
        endpoint_name: c.endpoint_name,
        target_pct: target,
        auto: c.share_pct == null,
        actual_pct: actual,
        published: n,
        lagging: target - actual > 8,
      };
    }).sort((a, b) => b.target_pct - a.target_pct),
  };
}
