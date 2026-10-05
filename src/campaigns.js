import { rows } from './db.js';
import { ymd } from './board.js';
import { assetView } from './media.js';
import { assetOwnerId } from './links.js';
import { contentBlocker } from './publish/readiness.js';
import { inferPeriod, parsePeriod, periodEnd, spreadDate } from '../public/js/core/period.js';

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
                        concurrent = []) {
  if (isCompleteMode(campaign, content)) {
    return completeAnglesGrid(campaign, content, campaignChannels, today);
  }
  const needs = channelNeeds(campaign, campaignChannels, concurrent);
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
 * (אותו חשבון קצב × שבועות × נתח כמו ברשת הזוויות), וכל משבצת ממולאת
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
                               concurrent = []) {
  if (isCompleteMode(campaign, content)) {
    return completeGeneralGrid(campaign, content, campaignChannels, today);
  }
  const needs = channelNeeds(campaign, campaignChannels, concurrent);
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
  const concurrent = await rows('select * from campaigns');
  const existing = await rows(
    'select sort_order from content_items where campaign_id = $1', [campaignId]);
  const need = campaign.content_complete_at
    ? null : angleCount(campaign, channelNeeds(campaign, channels, concurrent));
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
      const structure = b.structure ?? before?.structure ?? 'angles';
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
    return { error: 'אין בקמפיין פוסטים למדיות שלו — אין מה לפרוס' };
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

    // מה עוד חסר מהיום והלאה — רק בקמפיין שרץ או מתוכנן (מושהה/הסתיים: 0)
    const phase = phaseOf(c, today);
    const live = phase === 'running' || phase === 'upcoming';
    const rowsOf = general
      ? grid.channels.flatMap((ch) => ch.slots.filter((x) => !x.extra)
        .map((x) => ({ date: x.date, cells: [x] })))
      : grid.angles;
    const ahead = live ? missingAhead(rowsOf, today) : { missing: 0, total: 0 };
    const week = live ? missingAhead(rowsOf, today, 7) : { missing: 0, total: 0 };

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
      phase,
      status: statusOf({ c, today, grid, myChannels, ahead }),
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

export function statusOf({ c, today, grid, myChannels, ahead = null }) {
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
 * חלוקת השטח בפועל מול הנתח, לקמפיינים שרצים עכשיו — שורה לכל קמפיין.
 *
 * הנתח (target_pct): מה שנקבע ידנית בקמפיין, ובלעדיו החלק היחסי לפי חשיבות
 * מול הקמפיינים החופפים (effectiveShare — אותו חשבון כמו המנוע והטופס).
 * auto = הנתח נגזר, לא נקבע. בפועל (actual_pct): הפרסומים של התוכן של
 * הקמפיין מתוך הפרסומים של כל הקמפיינים בטבלה — אותו בסיס כמו הנתח, שמתחלק
 * בין קמפיינים (תוכן שוטף ופוסטים בלי תוכן לא נספרים בשום צד).
 */
export async function currentAllocation() {
  const today = ymd(new Date());
  const all = await rows('select * from campaigns');
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
      const target = Math.round(effectiveShare(c, all) * 100);
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
