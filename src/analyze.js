/**
 * ניתוח מסמך חופשי לטבלת תוכן.
 *
 * ההנחה שמסמך יגיע בפורמט שהמערכת מבקשת היא לא ריאלית: תוכנית תוכן
 * לשנה נכתבת באקסל של מישהו אחר, עם עמודות בשמות אחרים, כמה גיליונות,
 * שורות כותרת באמצע, ולפעמים בכלל בוורד.
 *
 * לכן המודל עושה כאן דבר אחד בלבד — ממיר את מה שיש לטבלה המבנית.
 * הוא לא כותב למסד, לא בוחר תאריכים ולא משבץ. התוצאה נכנסת לאותו
 * מסלול ייבוא רגיל: תצוגה מקדימה, אימות, ורק אז כתיבה. כך שגיאת
 * פרשנות של המודל נתפסת באותו מקום שבו נתפסת שגיאת הקלדה של אדם.
 */

import Anthropic from '@anthropic-ai/sdk';
import { one, rows } from './db.js';
import { friendlyAiError } from './ai-errors.js';

const MODEL = 'claude-opus-5';
const MAX_CHARS = 200_000;      // מסמך ארוך מזה נחתך, עם הודעה למשתמש

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('הניתוח לא זמין — חסר ANTHROPIC_API_KEY בהגדרות השרת');
  }
  client ??= new Anthropic();
  return client;
}

const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      description: 'שורה לכל זווית תוכן שזוהתה במסמך',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'כותרת קצרה שמזהה את הזווית' },
          kind: { type: 'string', enum: ['promo', 'value', 'hybrid'] },
          variants: {
            type: 'array',
            description: 'הניסוח לכל מדיה. רק מדיות שיש להן טקסט במסמך.',
            items: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'שם המדיה בדיוק כפי שהוא במערכת' },
                body: { type: 'string' },
              },
              required: ['channel', 'body'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'kind', 'variants'],
        additionalProperties: false,
      },
    },
    notes: {
      type: 'array',
      description: 'מה שכדאי שהמשתמש ידע: מה לא זוהה, מה נוחש, מה הושמט',
      items: { type: 'string' },
    },
    layout: {
      type: 'string',
      description: 'משפט אחד שמסביר איך המסמך היה בנוי ואיך פורש',
    },
  },
  required: ['rows', 'notes', 'layout'],
  additionalProperties: false,
};

function prompt(campaign, channels) {
  return `אתה ממיר מסמך תוכן פרסומי לטבלה מבנית עבור "מרכז בקרה פרסומי" של חתול פיננסי.

## מה אתה מפיק
שורה לכל **זווית** — מסר או רעיון אחד. לכל זווית ניסוח נפרד לכל מדיה
שיש לה טקסט במסמך. אותה זווית נאמרת אחרת בפייסבוק ובניוזלטר, וזה בדיוק
מה שהעמודות מייצגות.

## הקמפיין שאליו זה נכנס
שם: ${campaign.name}
מטרה: ${campaign.goal ?? 'לא הוגדרה'}
תאריכים: ${campaign.starts_on ?? '?'} עד ${campaign.ends_on ?? '?'}

## המדיות שקיימות במערכת
${channels.map((c) => `- ${c.name}${c.inCampaign ? ' (משויכת לקמפיין)' : ''}`).join('\n')}

**חובה:** בשדה channel כתוב את שם המדיה **בדיוק** כפי שהוא מופיע ברשימה
למעלה. אם במסמך כתוב "פייסבוק" והמדיה במערכת נקראת "קבוצת פייסבוק ראשית" —
כתוב את השם מהמערכת. אם עמודה במסמך לא מתאימה לאף מדיה, אל תמציא לה שם:
דלג עליה וכתוב על כך ב-notes.

## סוג התוכן
- promo — מכירתי, קורא לפעולה, מוכר מוצר
- value — תוכן ערך, מלמד או עוזר בלי למכור
- hybrid — משולב

אם המסמך לא אומר, הכרע לפי הניסוח עצמו.

## מה אתה לא עושה
- לא ממציא תוכן. אם אין ניסוח למדיה מסוימת — לא כותב לה variant.
- לא מתרגם ולא משכתב את הניסוחים. מעביר אותם כפי שהם.
  היוצא מן הכלל היחיד: ניקוי סימני עימוד שנשארו מהמסמך.
- לא מפצל זווית אחת לכמה שורות ולא מאחד כמה זוויות לשורה אחת.
- לא ממציא כותרת כשיש כותרת במסמך. רק אם באמת אין — גוזר אותה מהניסוח.

## מה חשוב שתשים ב-notes
כל דבר שהמשתמש צריך לבדוק: עמודות שלא הצלחת למפות, שורות שדילגת עליהן
ולמה, מקרים שבהם הכרעת בין שתי פרשנויות, ותאריכים או שדות אחרים שהיו
במסמך ולא נכנסים לטבלה (המערכת קובעת תאריכים בעצמה).`;
}

/**
 * @param {number|string} campaignId
 * @param {{kind:'text'|'pdf', text?:string, base64?:string, source:string}} doc
 */
export async function analyzeDocument(campaignId, doc) {
  const campaign = await one('select * from campaigns where id = $1', [campaignId]);
  if (!campaign) throw new Error('לא נמצא קמפיין כזה');

  const [all, mine] = await Promise.all([
    rows('select id, name from channels where active = true order by sort_order, id'),
    rows(`select ch.id from campaign_channels cc join channels ch on ch.id = cc.channel_id
           where cc.campaign_id = $1`, [campaignId]),
  ]);
  const mineIds = new Set(mine.map((m) => m.id));
  const channels = all.map((c) => ({ ...c, inCampaign: mineIds.has(c.id) }));

  const notes = [];
  let content;
  if (doc.kind === 'pdf') {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } },
      { type: 'text', text: 'המר את המסמך הזה לטבלת התוכן.' },
    ];
  } else {
    let text = doc.text ?? '';
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      notes.push(`המסמך ארוך מ-${MAX_CHARS.toLocaleString('he-IL')} תווים ונקרא רק חלקו הראשון`);
    }
    content = [{ type: 'text', text: `המר את המסמך הזה לטבלת התוכן:\n\n${text}` }];
  }

  // בסטרימינג ולא בקריאה רגילה: max_tokens גבוה על מסמך ארוך חוצה את
  // תקרת הזמן של בקשה יחידה, וה-SDK מסרב לשלוח אותה בלי סטרימינג
  let res;
  try {
    const stream = anthropic().messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: prompt(campaign, channels),
      messages: [{ role: 'user', content }],
    });
    res = await stream.finalMessage();
  } catch (e) {
    throw friendlyAiError(e);
  }

  if (res.stop_reason === 'refusal') throw new Error('לא הצלחתי לנתח את המסמך הזה');
  if (res.stop_reason === 'max_tokens') {
    notes.push('המסמך גדול מדי לניתוח אחד — חלק מהשורות ייתכן שחסרות');
  }

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('הניתוח לא החזיר תוצאה');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('הניתוח החזיר תשובה שלא ניתן לקרוא');
  }

  return {
    tsv: toTsv(parsed.rows ?? [], channels),
    notes: [...notes, ...(parsed.notes ?? [])],
    layout: parsed.layout ?? '',
    count: (parsed.rows ?? []).length,
    usage: {
      input_tokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens,
      usd: +((res.usage.input_tokens / 1e6) * 5 + (res.usage.output_tokens / 1e6) * 25).toFixed(4),
    },
  };
}

const KIND_HE = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };

/**
 * הופך את התוצאה לטבלה מופרדת בטאבים — אותו פורמט שהייבוא הידני מקבל.
 * זה מה שמאפשר להציג את התוצאה בתיבה ניתנת לעריכה במקום לכתוב אותה מיד.
 */
function toTsv(list, channels) {
  // רק מדיות שבאמת קיבלו טקסט נכנסות לכותרות, אחרת נוצרות עמודות ריקות
  const used = channels.filter((c) =>
    list.some((r) => (r.variants ?? []).some((v) => v.channel === c.name)));

  const header = ['כותרת', 'סוג', ...used.map((c) => c.name)];

  // פוסט אמיתי מכיל שורות חדשות, ולכן תא כזה מצוטט במקום להישטח לשורה
  // אחת. המפרק של הייבוא יודע לקרוא ציטוט, כולל מרכאות בתוך מרכאות.
  const cell = (v) => {
    const t = String(v ?? '').replace(/\r/g, '').trim();
    return /[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  const body = list.map((r) => {
    const byChannel = new Map((r.variants ?? []).map((v) => [v.channel, v.body]));
    return [cell(r.title), KIND_HE[r.kind] ?? 'ערך',
            ...used.map((c) => cell(byChannel.get(c.name)))].join('\t');
  });

  return [header.join('\t'), ...body].join('\n');
}
