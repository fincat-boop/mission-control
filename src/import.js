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
 * עמודה ריקה למדיה מסוימת פירושה שאין לה גרסה — לא טיוטה ריקה.
 * כותרות העמודות מזוהות לפי שמות הערוצים במערכת, ולכן אין מה להגדיר.
 */

import { one, rows, tx } from './db.js';

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
export async function analyzeImport(campaignId, text) {
  const campaign = await one('select * from campaigns where id = $1', [campaignId]);
  if (!campaign) throw new Error('לא נמצא קמפיין כזה');

  const table = parseTable(text);
  if (table.length < 2) {
    throw new Error('הטבלה צריכה שורת כותרות ולפחות שורת תוכן אחת');
  }

  const [channels, myChannels, existing] = await Promise.all([
    rows('select id, name from channels order by sort_order, id'),
    rows(`select ch.id, ch.name from campaign_channels cc
            join channels ch on ch.id = cc.channel_id
           where cc.campaign_id = $1`, [campaignId]),
    rows('select title, sort_order from content_items where campaign_id = $1', [campaignId]),
  ]);

  const { cols, channelCols, unknown } = mapHeader(table[0], channels);
  if (cols.title === -1) {
    throw new Error(
      `לא נמצאה עמודת כותרת. השורה הראשונה חייבת לכלול עמודה בשם "כותרת". ` +
      `העמודות שנמצאו: ${table[0].map((h) => String(h).trim()).filter(Boolean).join(', ')}`);
  }

  const seen = new Set(existing.map((x) => norm(x.title)));
  const nextOrder = Math.max(0, ...existing.map((x) => x.sort_order)) + 1;

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

    const variants = channelCols
      .map(({ index, channel }) => ({ channel, body: String(raw[index] ?? '').trim() }))
      .filter((v) => v.body !== '');

    items.push({
      line,
      title,
      kind,
      body: cols.body === -1 ? '' : String(raw[cols.body] ?? '').trim(),
      evergreen: cols.evergreen !== -1 && TRUE_WORDS.has(norm(raw[cols.evergreen])),
      reuse_after_days: cols.reuse === -1 || !String(raw[cols.reuse] ?? '').trim()
        ? null : Number(raw[cols.reuse]) || null,
      sort_order: nextOrder + items.length,
      variants: variants.map((v) => ({ channel_id: v.channel.id, channel_name: v.channel.name,
                                        body: v.body })),
    });
  });

  const warnings = [];
  if (unknown.length) {
    warnings.push(`עמודות שלא זוהו ולא ייובאו: ${unknown.join(', ')}`);
  }
  if (notInCampaign.length) {
    warnings.push(`המדיות ${notInCampaign.join(', ')} לא משויכות לקמפיין — ` +
                  'הניסוחים ייכתבו, אבל המנוע לא ישבץ אליהן עד שיתווספו');
  }
  if (!channelCols.length) {
    warnings.push('אין עמודות מדיה — ייווצרו זוויות בלי ניסוחים, ותצטרך לכתוב אותם ידנית');
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
      skipped: skipped.length,
      errors: errors.length,
    },
  };
}

/** מבצע את הייבוא. מריץ ניתוח טרי כדי שלא ייכתב משהו על סמך תצוגה ישנה. */
export async function runImport(campaignId, text) {
  const plan = await analyzeImport(campaignId, text);
  if (plan.errors.length) {
    throw new Error(`יש שגיאות בטבלה: ${plan.errors.slice(0, 3).join(' · ')}`);
  }
  if (!plan.items.length) throw new Error('אין מה לייבא — כל השורות כבר קיימות או ריקות');

  const campaign = await one('select endpoint_id from campaigns where id = $1', [campaignId]);

  await tx(async (client) => {
    for (const item of plan.items) {
      const created = (await client.query(
        `insert into content_items (endpoint_id, campaign_id, kind, title, body,
                                    ready_channel_ids, sort_order, evergreen, reuse_after_days)
         values ($1,$2,$3,$4,$5,$6::int[],$7,$8,$9) returning id`,
        [campaign.endpoint_id, campaignId, item.kind, item.title, item.body,
         item.variants.map((v) => v.channel_id), item.sort_order,
         item.evergreen, item.reuse_after_days]
      )).rows[0];

      for (const v of item.variants) {
        await client.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,$3,'ready')
           on conflict (content_id, channel_id) do update set body = $3, status = 'ready'`,
          [created.id, v.channel_id, v.body]
        );
      }
    }
  });

  return { created: plan.items.length, variants: plan.totals.variants, skipped: plan.skipped };
}
