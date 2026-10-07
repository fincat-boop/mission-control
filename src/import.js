/**
 * ייבוא תוכן מטבלה — Excel, Google Sheets או CSV.
 *
 * המבנה שהמערכת מצפה לו הוא בדיוק המבנה של הנתונים: שורה לכל זווית,
 * עמודה לכל מדיה. התא הוא הניסוח של אותה זווית באותה מדיה — כי זה
 * מה שבאמת שונה בין פייסבוק לניוזלטר.
 *
 *   כותרת | סוג | פייסבוק | אינסטגרם | ניוזלטר
 *   ------+-----+---------+-----------+---------
 *   ...   | ערך | טקסט…   | טקסט…     |
 *
 * עמודה ריקה לערוץ מסוים פירושה שאין לו גרסה — לא טיוטה ריקה. עמודת טקסט
 * כללית ("טקסט" / "תוכן" / "ניסוח") נכנסת לכל ערוץ של הקמפיין שאין לו עמודה
 * משלו (או שהתא שלו ריק), והתצוגה המקדימה אומרת לאילו.
 * כותרות העמודות מזוהות לפי שמות הערוצים במערכת, ולכן אין מה להגדיר.
 *
 * מה שמיובא נכנס כטיוטה. "לסמן כמוכן" (markReady) מסמן רק ניסוח שעובר את
 * כללי התוכן של הפרסום (readiness.js) — אינסטגרם בלי מדיה נשאר טיוטה.
 * כל ייבוא מקבל מזהה מנה (import_batch), ו"בטל ייבוא" מוחק את מה שלא נגעו בו.
 *
 * קמפיין כללי (סעיף 19): אותה טבלה, אבל שורה N = פוסט N בכל עמודת ערוץ —
 * כל תא הוא פוסט נפרד במשבצת של הערוץ שלו (כמו "המר לכללי"). תא ריק = אין
 * פוסט. כותרת לא חובה: בלי כותרת היא נגזרת מהטקסט של התא (core/title.js).
 * משבצת שכבר יש בה פוסט לא נדרסת; פוסט מייבוא קודם שאיש לא נגע בו מאז
 * ועדיין טיוטה — אפשר לבחור לעדכן (existing: 'update').
 */

import { randomUUID } from 'node:crypto';
import { one, rows, tx } from './db.js';
import { freeAngleSlots } from './campaigns.js';
import { autoLinkNew, normalizeLinkRules } from './links.js';
import { contentBlocker } from './publish/readiness.js';
import { deriveTitle } from '../public/js/core/title.js';

/**
 * פריט ש"איש לא נגע בו" מאז רגע מסוים (since — ביטוי SQL על ci): הפריט
 * והגרסאות שלו לא השתנו מאז (טריגרי updated_at בסכימה), ולא נוספו לו
 * קבצים. משותף ל"בטל ייבוא" (מאז היצירה) ולעדכון בייבוא חוזר (מאז הייבוא
 * האחרון שכתב אותו — imported_at).
 */
const untouchedSince = (since) => `(ci.updated_at <= ${since}
  and not exists (select 1 from content_variants v
                   where v.content_id = ci.id and v.updated_at > ${since})
  and not exists (select 1 from content_assets a where a.content_id = ci.id))`;

/** שמות אפשריים לעמודות הקבועות */
const ALIASES = {
  title:  ['כותרת', 'שם', 'זווית', 'title', 'name'],
  kind:   ['סוג', 'kind', 'type'],
  body:   ['טקסט', 'ניסוח', 'תוכן', 'body', 'text'],
  evergreen: ['ירוק עד', 'שוטף', 'evergreen'],
  reuse:  ['חזרה אחרי', 'reuse_after_days'],
};

const KIND_ALIASES = {
  promo: ['promo', 'מכירתי', 'מכירה', 'שיווקי'],
  value: ['value', 'ערך', 'תוכן ערך'],
  hybrid: ['hybrid', 'משולב', 'היברידי'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');

const TRUE_WORDS = new Set(['כן', 'true', '1', 'v', 'x', 'yes', 'y']);

/**
 * מפרק CSV או TSV, כולל תאים מצוטטים שמכילים פסיקים ושורות חדשות.
 * הדבקה ישירה מ-Excel מגיעה כ-TSV, ולכן המפריד מזוהה ולא נשאל.
 */
export function parseTable(text) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];

  // המפריד נקבע לפי השורה הראשונה מחוץ למרכאות
  let firstLineEnd = 0;
  let inQ = false;
  for (; firstLineEnd < src.length; firstLineEnd += 1) {
    const ch = src[firstLineEnd];
    if (ch === '"') inQ = !inQ;
    else if (ch === '\n' && !inQ) break;
  }
  const head = src.slice(0, firstLineEnd);
  const delim = (head.match(/\t/g)?.length ?? 0) >= (head.match(/,/g)?.length ?? 0) ? '\t' : ',';

  const table = [];
  let row = [];
  let cell = '';
  inQ = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }
        else inQ = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); table.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  table.push(row);

  // שורות ריקות לגמרי — רעש מהעתקה, לא נתונים
  return table.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** ממפה את שורת הכותרות לעמודות שהמערכת מבינה */
function mapHeader(header, channels) {
  const cols = { title: -1, kind: -1, body: -1, evergreen: -1, reuse: -1 };
  const channelCols = [];
  const unknown = [];

  header.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;

    const fixed = Object.entries(ALIASES)
      .find(([, names]) => names.some((n) => norm(n) === h));
    if (fixed) { cols[fixed[0]] = i; return; }

    const ch = channels.find((c) => norm(c.name) === h);
    if (ch) { channelCols.push({ index: i, channel: ch }); return; }

    unknown.push(String(raw).trim());
  });

  return { cols, channelCols, unknown };
}

function parseKind(raw, fallback = 'value') {
  const v = norm(raw);
  if (!v) return fallback;
  const hit = Object.entries(KIND_ALIASES).find(([, names]) => names.some((n) => norm(n) === v));
  return hit ? hit[0] : null;
}

/**
 * מנתח את הטבלה מול קמפיין מסוים ומחזיר בדיוק מה ייווצר.
 * לא כותב כלום — זה מה שמאפשר להראות תצוגה מקדימה לפני האישור.
 */
export async function analyzeImport(campaignId, text, { markReady = false, existing: mode = 'skip' } = {}) {
  const campaign = await one('select * from campaigns where id = $1', [campaignId]);
  if (!campaign) throw new Error('לא נמצא קמפיין כזה');

  const table = parseTable(text);
  if (table.length < 2) {
    throw new Error('הטבלה צריכה שורת כותרות ולפחות שורת תוכן אחת');
  }

  const channels = await rows('select id, name, platform from channels order by sort_order, id');
  const myChannels = await rows(
    `select ch.id, ch.name, ch.platform from campaign_channels cc
       join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`, [campaignId]);

  const { cols, channelCols, unknown } = mapHeader(table[0], channels);
  if (campaign.structure === 'general') {
    return analyzeGeneral(campaign, table, { cols, channelCols, unknown, myChannels },
      { markReady, update: mode === 'update' });
  }
  const existing = await rows('select title, sort_order from content_items where campaign_id = $1',
    [campaignId]);
  if (cols.title === -1) {
    throw new Error(
      `לא נמצאה עמודת כותרת. השורה הראשונה חייבת לכלול עמודה בשם "כותרת". ` +
      `העמודות שנמצאו: ${table[0].map((h) => String(h).trim()).filter(Boolean).join(', ')}`);
  }

  const seen = new Set(existing.map((x) => norm(x.title)));

  const notInCampaign = channelCols
    .filter((c) => !myChannels.some((m) => m.id === c.channel.id))
    .map((c) => c.channel.name);

  const items = [];
  const errors = [];
  const skipped = [];

  table.slice(1).forEach((raw, i) => {
    const line = i + 2;                 // שורה 1 היא הכותרות
    const title = String(raw[cols.title] ?? '').trim();
    if (!title) { errors.push(`שורה ${line}: אין כותרת`); return; }

    if (seen.has(norm(title))) { skipped.push(`שורה ${line}: "${title}" כבר קיים בקמפיין`); return; }
    seen.add(norm(title));

    const kind = parseKind(cols.kind === -1 ? '' : raw[cols.kind]);
    if (kind === null) {
      errors.push(`שורה ${line}: סוג לא מוכר "${String(raw[cols.kind]).trim()}" — מכירתי / ערך / משולב`);
      return;
    }

    const body = cols.body === -1 ? '' : String(raw[cols.body] ?? '').trim();
    const own = channelCols
      .map(({ index, channel }) => ({ channel, body: String(raw[index] ?? '').trim() }))
      .filter((v) => v.body !== '');
    // הטקסט הכללי — לכל ערוץ של הקמפיין שאין לו תא משלו בשורה הזו
    const general = body
      ? myChannels.filter((ch) => !own.some((v) => v.channel.id === ch.id))
        .map((channel) => ({ channel, body, general: true }))
      : [];

    items.push({
      line,
      title,
      kind,
      body,
      evergreen: cols.evergreen !== -1 && TRUE_WORDS.has(norm(raw[cols.evergreen])),
      reuse_after_days: cols.reuse === -1 || !String(raw[cols.reuse] ?? '').trim()
        ? null : Number(raw[cols.reuse]) || null,
      variants: [...own, ...general].map((v) => {
        // "מוכן" רק למה שעובר את כללי התוכן — בייבוא אין קבצים
        const block = contentBlocker({ platform: v.channel.platform, variant: { body: v.body } });
        return { channel_id: v.channel.id, channel_name: v.channel.name, body: v.body,
                 from_general: !!v.general,
                 status: markReady && !block ? 'ready' : 'draft',
                 ready_block: block };
      }),
    });
  });

  // המקומות הפנויים ברשת — קודם השורות הריקות, ואז אחרי האחרונה
  const { slots } = await freeAngleSlots(campaignId, items.length);
  items.forEach((item, i) => { item.sort_order = slots[i]; });

  const warnings = [];
  if (unknown.length) {
    warnings.push(`עמודות שלא זוהו ולא ייובאו: ${unknown.join(', ')}`);
  }
  if (notInCampaign.length) {
    warnings.push(`הערוצים ${notInCampaign.join(', ')} לא משויכים לקמפיין — ` +
                  'הניסוחים ייכתבו, אבל המנוע לא ישבץ אליהם עד שיתווספו');
  }
  if (!channelCols.length && cols.body === -1) {
    warnings.push('אין עמודות ערוץ ואין עמודת טקסט — ייווצרו זוויות בלי ניסוחים, ותצטרך לכתוב אותם ידנית');
  }
  const generalTo = myChannels.filter((ch) =>
    items.some((it) => it.variants.some((v) => v.from_general && v.channel_id === ch.id)));
  if (generalTo.length) {
    warnings.push(`עמודת "${String(table[0][cols.body]).trim()}" נכנסת כניסוח לכל ערוץ של הקמפיין ` +
      `שאין לו עמודה משלו: ${generalTo.map((ch) => ch.name).join(', ')}`);
  }
  // "לסמן כמוכן": מה שלא יעבור את כללי הפרסום נשאר טיוטה — אומרים כמה ולמה
  if (markReady) {
    const blocked = new Map();
    for (const v of items.flatMap((it) => it.variants)) {
      if (v.ready_block) blocked.set(v.ready_block, (blocked.get(v.ready_block) ?? 0) + 1);
    }
    for (const [reason, n] of blocked) {
      warnings.push(`${n === 1 ? 'ניסוח אחד יישאר' : `${n} ניסוחים יישארו`} טיוטה: ${reason}`);
    }
  }

  return {
    structure: 'angles',
    campaign: { id: campaign.id, name: campaign.name },
    columns: {
      title: table[0][cols.title],
      channels: channelCols.map((c) => c.channel.name),
      unknown,
    },
    items,
    errors,
    skipped,
    warnings,
    totals: {
      rows: table.length - 1,
      to_create: items.length,
      variants: items.reduce((s, x) => s + x.variants.length, 0),
      ready: items.reduce((s, x) => s + x.variants.filter((v) => v.status === 'ready').length, 0),
      skipped: skipped.length,
      errors: errors.length,
    },
  };
}

/**
 * מבצע את הייבוא. מריץ ניתוח טרי כדי שלא ייכתב משהו על סמך תצוגה ישנה.
 * כל הפריטים מקבלים מזהה מנה אחד (import_batch) — בשביל "בטל ייבוא".
 */
export async function runImport(campaignId, text, { markReady = false, existing = 'skip' } = {}) {
  const plan = await analyzeImport(campaignId, text, { markReady, existing });
  if (plan.errors.length) {
    throw new Error(`יש שגיאות בטבלה: ${plan.errors.slice(0, 3).join(' · ')}`);
  }
  if (plan.structure === 'general') return runGeneral(campaignId, plan);
  if (!plan.items.length) throw new Error('אין מה לייבא — כל השורות כבר קיימות או ריקות');

  const campaign = await one('select endpoint_id from campaigns where id = $1', [campaignId]);
  const batch = randomUUID();

  await tx(async (client) => {
    for (const item of plan.items) {
      const created = (await client.query(
        `insert into content_items (endpoint_id, campaign_id, kind, title, body,
                                    ready_channel_ids, sort_order, evergreen, reuse_after_days,
                                    import_batch)
         values ($1,$2,$3,$4,$5,$6::int[],$7,$8,$9,$10) returning id`,
        [campaign.endpoint_id, campaignId, item.kind, item.title, item.body,
         item.variants.map((v) => v.channel_id), item.sort_order,
         item.evergreen, item.reuse_after_days, batch]
      )).rows[0];

      for (const v of item.variants) {
        await client.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,$3,$4)
           on conflict (content_id, channel_id) do update set body = $3, status = $4`,
          [created.id, v.channel_id, v.body, v.status]
        );
      }
    }
  });

  return { created: plan.items.length, variants: plan.totals.variants, ready: plan.totals.ready,
           skipped: plan.skipped, batch };
}

/**
 * "בטל ייבוא": מוחק את הפריטים של המנה שאף אחד לא נגע בהם מאז — לא נערכו
 * (updated_at של הפריט והגרסאות שלו = רגע היצירה), לא נוספו להם קבצים, ואין
 * להם פוסט שפורסם, שאושר או שהיה קיים לפני הייבוא (שיבוץ ידני לפוסט חסר
 * תוכן). פוסטים שהמנוע יצר להם אחרי הייבוא ועוד לא אושרו — נמחקים איתם.
 * @returns {Promise<{removed:number, kept:number}>}
 */
export async function undoImport(campaignId, batch) {
  // קמפיין כללי: גם העוקבות שקישור העמודות יצר לפריטי המנה (autoLinkNew) —
  // הן נמחקות רק עם המקור שלהן, ורק כשגם בהן לא נגעו
  const items = await rows(
    `select ci.id, ci.linked_to_id, ci.import_batch = $2 as own,
            (${untouchedSince('ci.created_at')}
             and not exists (select 1 from posts p
                              where p.content_id = ci.id
                                and (p.status in ('published','publishing','approved')
                                     or p.created_at < ci.created_at))) as untouched
       from content_items ci
      where ci.campaign_id = $1
        and (ci.import_batch = $2
             or ci.linked_to_id in (select id from content_items
                                     where campaign_id = $1 and import_batch = $2))
      for update of ci`,
    [campaignId, batch]);
  const own = items.filter((x) => x.own);
  const gone = own.filter((x) => x.untouched).map((x) => x.id);
  const copies = items.filter((x) => !x.own && x.untouched && gone.includes(x.linked_to_id))
    .map((x) => x.id);
  const all = [...copies, ...gone];
  if (all.length) {
    await rows('delete from posts where content_id = any($1::int[]) returning id', [all]);
    await rows('delete from content_items where id = any($1::int[]) returning id', [all]);
  }
  return { removed: all.length, kept: own.length - gone.length };
}

/* ========================= קמפיין כללי (סעיף 19) ========================= */

/**
 * הפוסטים שכבר יושבים במשבצות של הקמפיין, עם האם ייבוא חוזר רשאי לעדכן
 * אותם: הגיעו מייבוא (import_batch), איש לא נגע בהם מאז הייבוא האחרון
 * שכתב אותם, הם עדיין טיוטה, לא מקושרים (קישור משבצות מסנכרן תוכן — עדכון
 * היה עוקף אותו), ואין להם פוסט שפורסם, באמצע פרסום או מאושר.
 * @returns {Promise<Map<string, {id:number, updatable:boolean}>>} מפתח "ערוץ:מספר"
 */
async function generalSlots(campaignId) {
  const list = await rows(
    `select ci.id, ci.slot_channel_id, ci.sort_order,
            (ci.import_batch is not null and ci.linked_to_id is null
             and not exists (select 1 from content_items f where f.linked_to_id = ci.id)
             and coalesce((select v.status from content_variants v
                            where v.content_id = ci.id and v.channel_id = ci.slot_channel_id),
                          'draft') = 'draft'
             and ${untouchedSince('coalesce(ci.imported_at, ci.created_at)')}
             and not exists (select 1 from posts p where p.content_id = ci.id
                               and p.status in ('published','publishing','approved'))) as updatable
       from content_items ci
      where ci.campaign_id = $1 and ci.slot_channel_id is not null`, [campaignId]);
  return new Map(list.map((x) => [`${x.slot_channel_id}:${x.sort_order}`, x]));
}

/**
 * ניתוח טבלה לקמפיין כללי: שורה N (אחרי הכותרות) ← פוסט N בכל עמודת ערוץ.
 * לכל תא: create (משבצת ריקה), update (פוסט מייבוא קודם שלא נגעו בו, כשבחרו
 * לעדכן), או skip. לא כותב כלום.
 */
async function analyzeGeneral(campaign, table, { cols, channelCols, unknown, myChannels },
  { markReady, update }) {
  const mine = new Set(myChannels.map((ch) => ch.id));
  const notInCampaign = channelCols.filter((c) => !mine.has(c.channel.id)).map((c) => c.channel.name);
  const ownCols = channelCols.filter((c) => mine.has(c.channel.id));
  const slots = await generalSlots(campaign.id);

  const items = [];
  const errors = [];
  const skipped = [];
  let updatable = 0;

  table.slice(1).forEach((raw, i) => {
    const line = i + 2;                 // שורה 1 היא הכותרות
    const index = i + 1;                // שורה N בטבלה = פוסט N
    const rowTitle = cols.title === -1 ? '' : String(raw[cols.title] ?? '').trim();
    const kind = parseKind(cols.kind === -1 ? '' : raw[cols.kind]);
    if (kind === null) {
      errors.push(`שורה ${line}: סוג לא מוכר "${String(raw[cols.kind]).trim()}" — מכירתי / ערך / משולב`);
      return;
    }
    const body = cols.body === -1 ? '' : String(raw[cols.body] ?? '').trim();
    const own = ownCols
      .map(({ index: col, channel }) => ({ channel, body: String(raw[col] ?? '').trim() }))
      .filter((v) => v.body !== '');
    // עמודת הטקסט הכללית — לכל ערוץ של הקמפיין שאין לו תא משלו בשורה הזו
    const general = body
      ? myChannels.filter((ch) => !own.some((v) => v.channel.id === ch.id))
        .map((channel) => ({ channel, body, general: true }))
      : [];
    const cells = [...own, ...general];
    if (!cells.length) {
      skipped.push(`שורה ${line}: אין טקסט לאף ערוץ — לא נוצר פוסט ${index}`);
      return;
    }

    const variants = cells.map((v) => {
      const at = slots.get(`${v.channel.id}:${index}`);
      let action = 'create';
      if (at) {
        if (at.updatable) updatable += 1;
        action = at.updatable && update ? 'update' : 'skip';
        if (action === 'skip') {
          skipped.push(`${v.channel.name} · פוסט ${index}: ${at.updatable
            ? 'יש בו טיוטה מייבוא קודם (לא מעדכנים)' : 'כבר יש בו פוסט'}`);
        }
      }
      // "מוכן" רק למה שעובר את כללי התוכן — בייבוא אין קבצים
      const block = contentBlocker({ platform: v.channel.platform, variant: { body: v.body } });
      return {
        channel_id: v.channel.id, channel_name: v.channel.name, body: v.body,
        from_general: !!v.general, action, content_id: at?.id ?? null,
        title: rowTitle || deriveTitle({ body: v.body, channelName: v.channel.name, index }),
        status: markReady && !block ? 'ready' : 'draft', ready_block: block,
      };
    });

    items.push({
      line, index, title: rowTitle, kind, body,
      evergreen: cols.evergreen !== -1 && TRUE_WORDS.has(norm(raw[cols.evergreen])),
      reuse_after_days: cols.reuse === -1 || !String(raw[cols.reuse] ?? '').trim()
        ? null : Number(raw[cols.reuse]) || null,
      variants,
    });
  });

  const write = items.flatMap((it) => it.variants).filter((v) => v.action !== 'skip');
  const writtenChannels = new Set(write.map((v) => v.channel_id));
  const name = (id) => myChannels.find((ch) => ch.id === id)?.name ?? '';

  // קישור עמודות: פוסט חדש בעמודת מקור מועתק לעמודות היעד שלה (autoLinkNew) —
  // אלא אם הטבלה ממלאת בעצמה את עמודת היעד, ואז העתקה הייתה מכפילה אותה
  const rules = normalizeLinkRules(campaign.link_rules ?? [])
    .filter((r) => mine.has(r.from) && mine.has(r.to));
  const linkFrom = [];
  const warnings = [];
  for (const from of new Set(rules.map((r) => r.from))) {
    if (!writtenChannels.has(from)) continue;
    const targets = rules.filter((r) => r.from === from).map((r) => r.to);
    const filled = targets.filter((to) => writtenChannels.has(to));
    if (filled.length) {
      warnings.push(`קישור העמודות של ${name(from)} לא חל על הייבוא — הטבלה ממלאת גם את ` +
        `${filled.map(name).join(', ')}`);
    } else {
      linkFrom.push(from);
      warnings.push(`פוסטים חדשים ב${name(from)} יועתקו גם ל${targets.map(name).join(', ')} ` +
        '(קישור העמודות של הקמפיין)');
    }
  }

  if (unknown.length) warnings.unshift(`עמודות שלא זוהו ולא ייובאו: ${unknown.join(', ')}`);
  if (notInCampaign.length) {
    warnings.unshift(`הערוצים ${notInCampaign.join(', ')} לא משויכים לקמפיין — העמודות שלהם לא ` +
      'ייובאו (מוסיפים את הערוץ לקמפיין ומייבאים שוב)');
  }
  if (!ownCols.length && cols.body === -1) {
    warnings.unshift('אין עמודות של ערוצי הקמפיין ואין עמודת טקסט — אין מה לייבא');
  }
  const generalTo = myChannels.filter((ch) =>
    write.some((v) => v.from_general && v.channel_id === ch.id));
  if (generalTo.length) {
    warnings.push(`עמודת "${String(table[0][cols.body]).trim()}" נכנסת כפוסט לכל ערוץ של הקמפיין ` +
      `שאין לו עמודה משלו: ${generalTo.map((ch) => ch.name).join(', ')}`);
  }
  if (markReady) {
    const blocked = new Map();
    for (const v of write) {
      if (v.ready_block) blocked.set(v.ready_block, (blocked.get(v.ready_block) ?? 0) + 1);
    }
    for (const [reason, n] of blocked) {
      warnings.push(`${n === 1 ? 'פוסט אחד יישאר' : `${n} פוסטים יישארו`} טיוטה: ${reason}`);
    }
  }

  return {
    structure: 'general',
    campaign: { id: campaign.id, name: campaign.name },
    columns: {
      title: cols.title === -1 ? null : table[0][cols.title],
      channels: ownCols.map((c) => c.channel.name),
      unknown,
    },
    items,
    errors,
    skipped,
    warnings,
    link_from: linkFrom,
    totals: {
      rows: table.length - 1,
      to_create: write.filter((v) => v.action === 'create').length,
      to_update: write.filter((v) => v.action === 'update').length,
      // כמה משבצות תפוסות אפשר לעדכן (טיוטות מייבוא קודם שלא נגעו בהן) —
      // לתיבת "עדכן טיוטות" בתצוגה המקדימה, גם כשלא בחרו בה
      updatable,
      variants: write.length,
      ready: write.filter((v) => v.status === 'ready').length,
      skipped: skipped.length,
      errors: errors.length,
    },
  };
}

/**
 * כתיבת ייבוא לקמפיין כללי: פוסט חדש לכל תא create, עדכון במקום לכל update
 * (הטקסט, הכותרת, הסוג והמצב — imported_at מתקדם, כך שייבוא נוסף עדיין יראה
 * אותו "לא נגעו בו"). פוסט שעודכן שומר על מזהה המנה שלו: "בטל ייבוא" של
 * המנה הזו מוחק רק את מה שהיא יצרה. מילוי אחד לקמפיין — בנתיב, אחרי זה.
 */
async function runGeneral(campaignId, plan) {
  if (!plan.totals.variants) {
    throw new Error('אין מה לייבא — כל התאים ריקים או שהמשבצות כבר תפוסות');
  }
  const campaign = await one('select endpoint_id from campaigns where id = $1', [campaignId]);
  const batch = randomUUID();
  const created = [];
  let updated = 0;

  await tx(async (client) => {
    for (const item of plan.items) {
      for (const v of item.variants) {
        if (v.action === 'create') {
          const row = (await client.query(
            `insert into content_items (endpoint_id, campaign_id, kind, title, body,
                                        ready_channel_ids, sort_order, evergreen, reuse_after_days,
                                        slot_channel_id, import_batch, imported_at)
             values ($1,$2,$3,$4,$5,$6::int[],$7,$8,$9,$10,$11, now()) returning id`,
            [campaign.endpoint_id, campaignId, item.kind, v.title, v.body, [v.channel_id],
             item.index, item.evergreen, item.reuse_after_days, v.channel_id, batch]
          )).rows[0];
          await client.query(
            `insert into content_variants (content_id, channel_id, body, status)
             values ($1,$2,$3,$4)`, [row.id, v.channel_id, v.body, v.status]);
          created.push({ id: row.id, channel_id: v.channel_id });
        } else if (v.action === 'update') {
          await client.query(
            `update content_items set title = $2, kind = $3, body = $4, evergreen = $5,
                    reuse_after_days = $6, imported_at = now()
              where id = $1`,
            [v.content_id, v.title, item.kind, v.body, item.evergreen, item.reuse_after_days]);
          await client.query(
            `insert into content_variants (content_id, channel_id, body, status)
             values ($1,$2,$3,$4)
             on conflict (content_id, channel_id) do update set body = $3, status = $4`,
            [v.content_id, v.channel_id, v.body, v.status]);
          updated += 1;
        }
      }
    }
  });

  // קישור עמודות — רק בעמודות שהטבלה לא ממלאת את היעד שלהן (analyzeGeneral)
  let copied = 0;
  const linkFrom = new Set(plan.link_from);
  for (const c of created) {
    if (linkFrom.has(c.channel_id)) copied += (await autoLinkNew(c.id)).linked;
  }

  return { structure: 'general', created: created.length, updated, copied,
           variants: plan.totals.variants, ready: plan.totals.ready,
           skipped: plan.skipped, batch };
}
