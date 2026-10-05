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
 */

import { randomUUID } from 'node:crypto';
import { one, rows, tx } from './db.js';
import { freeAngleSlots } from './campaigns.js';
import { contentBlocker } from './publish/readiness.js';

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
export async function analyzeImport(campaignId, text, { markReady = false } = {}) {
  const campaign = await one('select * from campaigns where id = $1', [campaignId]);
  if (!campaign) throw new Error('לא נמצא קמפיין כזה');

  const table = parseTable(text);
  if (table.length < 2) {
    throw new Error('הטבלה צריכה שורת כותרות ולפחות שורת תוכן אחת');
  }

  // בזו אחר זו — Promise.all על אותו client בתוך בקשה מזהיר ב-pg
  const channels = await rows('select id, name, platform from channels order by sort_order, id');
  const myChannels = await rows(
    `select ch.id, ch.name, ch.platform from campaign_channels cc
       join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`, [campaignId]);
  const existing = await rows('select title, sort_order from content_items where campaign_id = $1',
    [campaignId]);

  const { cols, channelCols, unknown } = mapHeader(table[0], channels);
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
    warnings.push(`המדיות ${notInCampaign.join(', ')} לא משויכות לקמפיין — ` +
                  'הניסוחים ייכתבו, אבל המנוע לא ישבץ אליהן עד שיתווספו');
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
export async function runImport(campaignId, text, { markReady = false } = {}) {
  const plan = await analyzeImport(campaignId, text, { markReady });
  if (plan.errors.length) {
    throw new Error(`יש שגיאות בטבלה: ${plan.errors.slice(0, 3).join(' · ')}`);
  }
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
  const items = await rows(
    `select ci.id,
            (ci.updated_at = ci.created_at
             and not exists (select 1 from content_variants v
                              where v.content_id = ci.id and v.updated_at > ci.created_at)
             and not exists (select 1 from content_assets a where a.content_id = ci.id)
             and not exists (select 1 from posts p
                              where p.content_id = ci.id
                                and (p.status in ('published','publishing','approved')
                                     or p.created_at < ci.created_at))) as untouched
       from content_items ci
      where ci.campaign_id = $1 and ci.import_batch = $2
      for update of ci`,
    [campaignId, batch]);
  const gone = items.filter((x) => x.untouched).map((x) => x.id);
  if (gone.length) {
    await rows('delete from posts where content_id = any($1::int[]) returning id', [gone]);
    await rows('delete from content_items where id = any($1::int[]) returning id', [gone]);
  }
  return { removed: gone.length, kept: items.length - gone.length };
}
