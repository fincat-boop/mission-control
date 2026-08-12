/**
 * העוזר שחי בתוך המערכת.
 *
 * שני סוגי כלים:
 *  - כלי קריאה  — רצים מיד, לא משנים כלום.
 *  - כלי כתיבה  — לא מבצעים כלום. הם מייצרים "הצעה" שמוצגת למשתמש,
 *                 והביצוע קורה רק אחרי אישור מפורש שלו.
 *
 * הצעה שאושרה מבוצעת דרך אותם נתיבי API שהממשק משתמש בהם — עם הקוקי של
 * המשתמש. כך אותן בדיקות תקינות ואותן הרשאות חלות עליו כמו על כל פעולה
 * אחרת, בלי עותק שני של הלוגיקה שיכול לסטות.
 *
 * מה שהעוזר לא נוגע בו: כללי המנוע והרצת המנוע. הוא יכול להסביר אותם
 * ולהראות מה המנוע היה מציע — אבל לא לשנות אותם ולא להריץ אותם.
 */

import Anthropic from '@anthropic-ai/sdk';
import { one, rows } from './db.js';
import { buildAlerts } from './alerts.js';
import { campaignsWithHealth, currentAllocation, shareTimeline } from './campaigns.js';
import { buildBoard, ymd } from './board.js';
import { planWeek } from './engine.js';
import { VIA_HEADER } from './audit.js';
import { buildStats, readActivity } from './stats.js';
import { gapWarning } from './gap.js';
import { friendlyAiError } from './ai-errors.js';

const MODEL = 'claude-opus-5';
// דולר למיליון טוקן, לפי המחירון של claude-opus-5
const PRICE_IN = 5;
const PRICE_OUT = 25;
const MAX_TURNS = 8;          // סבבי כלים לפני שמפסיקים
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('העוזר לא מחובר — חסר ANTHROPIC_API_KEY במשתני הסביבה');
  }
  client ??= new Anthropic();
  return client;
}

export const assistantReady = () => !!process.env.ANTHROPIC_API_KEY;

/* ========================= הצעות ממתינות ========================= */

/** הצעות שנוצרו ועוד לא אושרו. נשמרות בשרת כדי שהלקוח לא יוכל להמציא פעולה. */
const pending = new Map();
let seq = 0;

function remember(userId, proposal) {
  const id = `p${++seq}_${Date.now().toString(36)}`;
  pending.set(id, { ...proposal, id, user_id: userId, at: Date.now() });
  // ניקוי עצל של הצעות ישנות
  for (const [k, v] of pending) if (Date.now() - v.at > PROPOSAL_TTL_MS) pending.delete(k);
  return id;
}

export function takeProposal(id, userId) {
  const p = pending.get(id);
  if (!p) return null;
  if (p.user_id !== userId) return null;
  pending.delete(id);
  return p;
}

/* ========================= תמונת מצב לפרומפט ========================= */

/**
 * מה שהעוזר צריך לדעת בלי לשאול: המבנה של המערכת.
 * הפרטים הכבדים — לוח, תוכן, התראות — מגיעים דרך כלי קריאה לפי הצורך.
 */
async function snapshot() {
  const [endpoints, channels, campaigns, settings, counts] = await Promise.all([
    rows('select id, name, importance, min_days_between, active from endpoints order by id'),
    rows(`select id, name, max_per_week, target_per_week, max_promo_per_week,
                 max_value_per_week, max_hybrid_per_week, urgent_reserve_pct,
                 blocked_days, active
            from channels order by sort_order, id`),
    rows(`select c.id, c.name, c.endpoint_id, c.starts_on, c.ends_on, c.share_pct,
                 c.importance, c.target_posts, c.active, c.paused_at,
                 (select count(*)::int from content_items ci where ci.campaign_id = c.id) as content_count,
                 (select coalesce(array_agg(cc.channel_id order by cc.channel_id), '{}')
                    from campaign_channels cc where cc.campaign_id = c.id) as channel_ids
            from campaigns c order by c.starts_on nulls last, c.id`),
    one('select * from engine_settings limit 1'),
    one(`select
           (select count(*)::int from content_items) as content,
           (select count(*)::int from posts where status in ('scheduled','pending_approval')) as scheduled,
           (select count(*)::int from posts where status = 'hole') as holes,
           (select count(*)::int from tasks where done = false) as open_tasks`),
  ]);
  return { today: ymd(new Date()), endpoints, channels, campaigns, settings, counts };
}

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function systemPrompt(user, snap) {
  return `אתה העוזר של "Mission Control" של חתול פיננסי — מערכת לניהול הפרסום.
אתה חי בתוך המערכת ורואה את הנתונים האמיתיים שלה.

## התפקיד שלך
עיקר התפקיד: להסביר, לכוון ולהמליץ. אתה יודע גם לבצע, אבל ביצוע הוא הברירה
האחרונה ולא הראשונה. כשמשתמש שואל שאלה — ענה עליה. כשהוא מבקש פעולה — קודם
הסבר מה זה אומר ומה ההשלכות, ורק אז הצע את הפעולה.

## איך המערכת בנויה
- **נקודת קצה** = מוצר או יעד שיווקי. לכל אחת משקל (importance) שקובע כמה שטח אוויר מגיע לה.
- **קמפיין** שייך לנקודת קצה אחת, יש לו חלון תאריכים, נתח (share_pct) או משקל, ורשימת מדיות.
- **תוכן** (זווית) שייך לקמפיין או רץ ברקע (evergreen). לכל זווית יש **גרסה נפרדת לכל מדיה** —
  אותו רעיון, ניסוח אחר לפייסבוק ולניוזלטר.
- **פוסט** = שיבוץ בפועל של תוכן בערוץ בתאריך.
- **המנוע** משבץ אוטומטית לפי "חוב אוויר": ותק בלי פרסום, פער מול הנתח שמגיע, ומשקל.

## כללים שאתה לא עוקף
1. **אסור לך לגעת במנוע.** לא לשנות את כללי המנוע (engine_settings) ולא להריץ שיבוץ
   אוטומטי. אתה יכול להראות מה המנוע היה מציע (engine_preview) ולהסביר למה — זה הכול.
2. **לפני כל פעולה — לוודא.** אל תציע כתיבה על סמך הנחה. תמיד קרא קודם את המצב
   הרלוונטי בכלי קריאה: שהמזהים קיימים, שהתאריכים בטווח הקמפיין, שאין התנגשות,
   שהמדיה לא חסומה באותו יום. אם חסר לך מידע — שאל את המשתמש, אל תנחש.
3. **פעולה אחת = הצעה אחת.** כלי כתיבה לא מבצע כלום. הוא מייצר הצעה שהמשתמש
   רואה ומאשר. אחרי שהצעת — תאר בקצרה מה יקרה ומה ההשלכה, ואל תגיד שזה בוצע.
4. **אל תערום הצעות.** מקסימום 3 הצעות בתשובה אחת, ורק אם הן באמת קשורות זו לזו.
5. אם משהו נראה לך רעיון רע — תגיד את זה במשפט, ואז תן למשתמש להחליט.

## סגנון
אתה כותב בתוך חלון צ'אט צר, ולכן:
- **טקסט רגיל בלבד.** בלי כותרות markdown, בלי \`##\`, בלי \`**\`, בלי טבלאות.
  הדגשה נעשית במילים, לא בסימנים. רשימה נפתחת בקו מפריד "- " בתחילת שורה.
- קצר. שתיים־שלוש פסקאות קצרות זה המקסימום לתשובה רגילה. אם יש עוד מה
  לומר — תסיים במשפט אחד שמציע להעמיק, ותן למשתמש לבחור.
- פותחים בשורה התחתונה: מה המצב או מה מצאת. הפירוט אחר כך.
- עברית, ישיר, בלי הקדמות. מספרים ותאריכים מדויקים.
- כשאתה מסביר החלטה — תגיד על מה היא מבוססת (איזה נתון ראית).

## מי מולך
${user.name}${user.is_owner ? ' (בעלים — כל ההרשאות)' : ''}
הרשאות: ${['content', 'settings', 'approve', 'users']
    .filter((p) => user.is_owner || user[`perm_${p}`]).join(', ') || 'צפייה בלבד'}
כלים שאין לו הרשאה אליהם פשוט לא זמינים לך.

## תמונת מצב (${snap.today}, יום ${HE_DAYS[new Date().getDay()]})
נקודות קצה: ${JSON.stringify(snap.endpoints)}
ערוצים: ${JSON.stringify(snap.channels)}
(blocked_days: 0=ראשון ... 6=שבת — ימים שהערוץ לא מקבל בהם תוכן)
קמפיינים: ${JSON.stringify(snap.campaigns)}
כללי המנוע (לקריאה בלבד): ${JSON.stringify(snap.settings)}
מונים: ${JSON.stringify(snap.counts)}`;
}

/* ========================= כלי קריאה ========================= */

const READ_TOOLS = {
  get_board: {
    description: 'הלוח השבועי: כל השיבוצים של שבוע מסוים, לפי ערוץ ויום. ' +
      'בלי week מקבלים את השבוע הנוכחי.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'string', description: 'תאריך עוגן בשבוע, YYYY-MM-DD' } },
    },
    run: (a) => buildBoard(a.week),
  },

  get_campaigns: {
    description: 'כל הקמפיינים עם מצב המלאות שלהם: כמה תוכן חסר, מה הנתח בפועל מול המתוכנן. ' +
      'לפירוט ברמת הזווית והמדיה — get_content עם campaign_id.',
    input_schema: { type: 'object', properties: {} },
    run: async () => ({
      // grid היא מטריצת התאים שהממשק מצייר — כ-10KB לקמפיין, ואותו מידע
      // זמין דחוס יותר ב-get_content. בלי הגזימה הזו שאלה אחת עלתה פי שניים.
      campaigns: (await campaignsWithHealth()).map(({ grid, content, ...c }) => ({
        ...c,
        content: (content ?? []).map((x) => ({
          id: x.id, title: x.title, kind: x.kind, evergreen: x.evergreen,
        })),
      })),
      allocation: await currentAllocation(),
    }),
  },

  get_content: {
    description: 'ספריית התוכן. אפשר לסנן לפי קמפיין או נקודת קצה. ' +
      'עם content_id מקבלים גם את הטקסט המלא של כל גרסה לפי מדיה.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'integer' },
        endpoint_id: { type: 'integer' },
        content_id: { type: 'integer', description: 'פריט בודד, כולל הטקסטים המלאים' },
      },
    },
    run: (a) => readContent(a),
  },

  get_post: {
    description: 'שיבוץ בודד: מה בדיוק אמור לצאת שם — הטקסט של המדיה והקבצים.',
    input_schema: {
      type: 'object',
      properties: { post_id: { type: 'integer' } },
      required: ['post_id'],
    },
    run: (a) => readPost(a.post_id),
  },

  get_alerts: {
    description: 'ההתראות הפעילות — מחושבות מהמצב האמיתי ברגע זה.',
    input_schema: { type: 'object', properties: {} },
    run: () => buildAlerts(),
  },

  get_strategy: {
    description: 'תמונת האסטרטגיה: חלוקת השטח בין נקודות הקצה לאורך הזמן מול מה שקרה בפועל.',
    input_schema: { type: 'object', properties: {} },
    run: async () => ({
      timeline: await shareTimeline(),
      allocation: await currentAllocation(),
    }),
  },

  get_tasks: {
    description: 'המשימות הפתוחות והמשימות שנסגרו השבוע.',
    input_schema: { type: 'object', properties: {} },
    run: async () => ({
      open: await rows(
        `select t.id, t.title, t.subtitle, t.kind, t.urgent, t.due_on, u.name as assignee
           from tasks t left join users u on u.id = t.assignee_id
          where t.done = false order by t.urgent desc, t.due_on nulls last, t.id`),
    }),
  },

  get_stats: {
    description: 'סטטיסטיקה לתקופה: כמה פורסם, לפי סוג ולפי ערוץ, חלוקת השטח בין ' +
      'נקודות הקצה, קצב בפועל מול היעד, ומשימות. בלי תאריכים — 30 הימים האחרונים.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
    run: (a) => buildStats(a.from, a.to),
  },

  get_activity: {
    description: 'יומן הפעולות — מי עשה מה ומתי. אפשר לסנן לפי משתמש, לפי מקור ' +
      '(ui / assistant) ולפי סוג ישות.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        user_id: { type: 'integer' },
        via: { type: 'string', enum: ['ui', 'assistant', 'system'] },
        entity: { type: 'string', description: 'posts / campaigns / content / channels ...' },
        limit: { type: 'integer' },
      },
    },
    run: (a) => readActivity({ ...a, limit: Math.min(a.limit ?? 60, 120) }),
  },

  engine_preview: {
    description: 'מה המנוע היה משבץ השבוע ולמה — תצוגה מקדימה בלבד. ' +
      'לא כותב כלום ואי אפשר להפעיל ממנה שיבוץ. משמש להסביר את שיקולי המנוע.',
    input_schema: {
      type: 'object',
      properties: { week: { type: 'string', description: 'תאריך עוגן, YYYY-MM-DD' } },
    },
    run: (a) => planWeek(a.week),
  },
};

async function readContent({ campaign_id, endpoint_id, content_id }) {
  if (content_id) {
    const item = await one(
      `select ci.*, e.name as endpoint_name, c.name as campaign_name
         from content_items ci
         join endpoints e on e.id = ci.endpoint_id
         left join campaigns c on c.id = ci.campaign_id
        where ci.id = $1`, [content_id]);
    if (!item) return { error: 'לא נמצא תוכן עם המזהה הזה' };
    const variants = await rows(
      `select v.id, v.channel_id, ch.name as channel_name, v.status, v.body
         from content_variants v join channels ch on ch.id = v.channel_id
        where v.content_id = $1 order by ch.sort_order, ch.id`, [content_id]);
    return { content: item, variants };
  }

  const where = [];
  const params = [];
  if (campaign_id) { params.push(campaign_id); where.push(`ci.campaign_id = $${params.length}`); }
  if (endpoint_id) { params.push(endpoint_id); where.push(`ci.endpoint_id = $${params.length}`); }

  const items = await rows(
    `select ci.id, ci.title, ci.kind, ci.campaign_id, ci.endpoint_id, ci.evergreen,
            ci.reuse_after_days, ci.sort_order,
            coalesce(p.n, 0) as placements
       from content_items ci
       left join (select content_id, count(*)::int as n from posts
                   where content_id is not null group by content_id) p on p.content_id = ci.id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by ci.campaign_id nulls last, ci.sort_order, ci.id
      limit 200`, params);

  const ids = items.map((i) => i.id);
  const variants = ids.length
    ? await rows(
        `select content_id, channel_id, status from content_variants
          where content_id = any($1::int[])`, [ids])
    : [];

  return {
    content: items.map((i) => ({
      ...i,
      variants: variants.filter((v) => v.content_id === i.id)
        .map((v) => ({ channel_id: v.channel_id, status: v.status })),
    })),
  };
}

async function readPost(id) {
  const p = await one(
    `select p.*, c.name as channel_name, e.name as endpoint_name,
            ci.title as content_title, ci.evergreen
       from posts p
       left join channels c on c.id = p.channel_id
       left join endpoints e on e.id = p.endpoint_id
       left join content_items ci on ci.id = p.content_id
      where p.id = $1`, [id]);
  if (!p) return { error: 'לא נמצא שיבוץ עם המזהה הזה' };
  const variant = p.content_id
    ? await one('select status, body from content_variants where content_id = $1 and channel_id = $2',
        [p.content_id, p.channel_id])
    : null;
  return { post: p, variant };
}

/* ========================= כלי כתיבה (הצעות בלבד) ========================= */

/**
 * כל כלי כתיבה מתורגם לבקשה לאותו נתיב API שהממשק משתמש בו.
 * `check` רץ לפני שההצעה מוצגת, ומחזיר אזהרות או שגיאה מוקדמת —
 * כדי שהעוזר יתקן את עצמו במקום להציע משהו שייפול.
 */
const WRITE_TOOLS = {
  create_campaign: {
    perm: 'settings',
    description: 'קמפיין חדש על נקודת קצה קיימת.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint_id: { type: 'integer' },
        name: { type: 'string' },
        starts_on: { type: 'string', description: 'YYYY-MM-DD' },
        ends_on: { type: 'string', description: 'YYYY-MM-DD' },
        share_pct: { type: 'integer', description: 'נתח קבוע באחוזים. בלעדיו הנתח נגזר מהמשקל.' },
        importance: { type: 'integer' },
        target_posts: { type: 'integer' },
        goal: { type: 'string' },
        channel_ids: { type: 'array', items: { type: 'integer' }, description: 'המדיות שהקמפיין יושב עליהן' },
      },
      required: ['endpoint_id', 'name'],
    },
    request: (a) => ({ method: 'POST', path: '/campaigns', body: a }),
    check: (a) => checkCampaignWindow(a),
  },

  update_campaign: {
    perm: 'settings',
    description: 'עדכון קמפיין קיים. שינוי starts_on גורר איתו את השיבוצים העתידיים של הקמפיין.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'integer' },
        name: { type: 'string' },
        starts_on: { type: 'string' },
        ends_on: { type: 'string' },
        share_pct: { type: 'integer', description: 'נתח קבוע באחוזים' },
        importance: { type: 'integer' },
        target_posts: { type: 'integer' },
        goal: { type: 'string' },
        active: { type: 'boolean' },
        channel_ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['campaign_id'],
    },
    request: ({ campaign_id, ...rest }) => ({
      method: 'PATCH', path: `/campaigns/${campaign_id}`, body: rest,
    }),
    check: (a) => checkCampaignUpdate(a),
  },

  pause_campaign: {
    perm: 'settings',
    description: 'השהיית קמפיין. לא מוחק כלום — השיבוצים נשמרים ומוסתרים עד להפעלה מחדש.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'integer' } },
      required: ['campaign_id'],
    },
    request: (a) => ({ method: 'POST', path: `/campaigns/${a.campaign_id}/pause` }),
    check: async (a) => {
      const c = await one('select name, paused_at from campaigns where id = $1', [a.campaign_id]);
      if (!c) return { error: 'לא נמצא קמפיין עם המזהה הזה' };
      if (c.paused_at) return { error: `הקמפיין "${c.name}" כבר מושהה` };
      const held = await one(
        `select count(*)::int as n from posts p join content_items ci on ci.id = p.content_id
          where ci.campaign_id = $1 and p.status in ('scheduled','pending_approval','hole')
            and p.scheduled_at >= now()`, [a.campaign_id]);
      return { warnings: held.n ? [`${held.n} שיבוצים עתידיים ייעלמו מהלוח עד להפעלה מחדש`] : [] };
    },
  },

  resume_campaign: {
    perm: 'settings',
    description: 'הפעלה מחדש של קמפיין מושהה.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'integer' } },
      required: ['campaign_id'],
    },
    request: (a) => ({ method: 'POST', path: `/campaigns/${a.campaign_id}/resume` }),
  },

  create_content: {
    perm: 'content',
    description: 'זווית תוכן חדשה. אם היא שייכת לקמפיין — נקודת הקצה נגזרת ממנו. ' +
      'channel_ids פותח טיוטה לכל מדיה; את הניסוח לכל מדיה כותבים אחר כך ב-write_variant.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', enum: ['promo', 'value', 'hybrid'] },
        campaign_id: { type: 'integer' },
        endpoint_id: { type: 'integer', description: 'נדרש רק לתוכן שוטף בלי קמפיין' },
        body: { type: 'string', description: 'ניסוח בסיס משותף' },
        channel_ids: { type: 'array', items: { type: 'integer' } },
        evergreen: { type: 'boolean' },
        reuse_after_days: { type: 'integer' },
      },
      required: ['title', 'kind'],
    },
    request: (a) => ({ method: 'POST', path: '/content', body: a }),
    check: async (a) => {
      if (!a.campaign_id && !a.endpoint_id) {
        return { error: 'תוכן בלי קמפיין חייב endpoint_id' };
      }
      return { warnings: [] };
    },
  },

  update_content: {
    perm: 'content',
    description: 'עדכון זווית תוכן קיימת.',
    input_schema: {
      type: 'object',
      properties: {
        content_id: { type: 'integer' },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['promo', 'value', 'hybrid'] },
        campaign_id: { type: 'integer' },
        body: { type: 'string' },
        evergreen: { type: 'boolean' },
        reuse_after_days: { type: 'integer' },
        sort_order: { type: 'integer' },
      },
      required: ['content_id'],
    },
    request: ({ content_id, ...rest }) => ({
      method: 'PATCH', path: `/content/${content_id}`, body: rest,
    }),
  },

  write_variant: {
    perm: 'content',
    description: 'כתיבת הניסוח של זווית למדיה מסוימת. status=ready מסמן שהוא מוכן לשיבוץ.',
    input_schema: {
      type: 'object',
      properties: {
        content_id: { type: 'integer' },
        channel_id: { type: 'integer' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'ready', 'not_relevant'] },
      },
      required: ['content_id', 'channel_id', 'body'],
    },
    request: ({ content_id, channel_id, ...rest }) => ({
      method: 'PUT', path: `/content/${content_id}/variants/${channel_id}`, body: rest,
    }),
    check: async (a) => {
      const v = await one(
        'select status, body from content_variants where content_id = $1 and channel_id = $2',
        [a.content_id, a.channel_id]);
      return {
        warnings: v?.body?.trim() ? ['יש כבר ניסוח למדיה הזו — הוא יידרס'] : [],
      };
    },
  },

  move_post: {
    perm: 'content',
    description: 'הזזת שיבוץ ליום אחר או למדיה אחרת.',
    input_schema: {
      type: 'object',
      properties: {
        post_id: { type: 'integer' },
        scheduled_at: { type: 'string', description: 'ISO 8601 מלא, למשל 2026-08-03T10:00:00' },
        channel_id: { type: 'integer' },
      },
      required: ['post_id'],
    },
    request: ({ post_id, ...rest }) => ({
      method: 'PATCH', path: `/posts/${post_id}`, body: rest,
    }),
    check: (a) => checkMove(a),
  },

  delete_post: {
    perm: 'content',
    description: 'הסרת שיבוץ מהלוח. התוכן עצמו נשאר בספרייה.',
    input_schema: {
      type: 'object',
      properties: { post_id: { type: 'integer' } },
      required: ['post_id'],
    },
    request: (a) => ({ method: 'DELETE', path: `/posts/${a.post_id}` }),
    check: async (a) => {
      const p = await one('select title, status, scheduled_at from posts where id = $1', [a.post_id]);
      if (!p) return { error: 'לא נמצא שיבוץ עם המזהה הזה' };
      return { warnings: p.status === 'published' ? ['השיבוץ הזה כבר סומן כפורסם'] : [] };
    },
  },

  create_endpoint: {
    perm: 'settings',
    description: 'נקודת קצה חדשה.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        importance: { type: 'integer', description: '1–10' },
        min_days_between: { type: 'integer' },
      },
      required: ['name'],
    },
    request: (a) => ({ method: 'POST', path: '/endpoints', body: a }),
  },

  update_endpoint: {
    perm: 'settings',
    description: 'עדכון נקודת קצה. שינוי importance משנה את חלוקת השטח בין כל הנקודות.',
    input_schema: {
      type: 'object',
      properties: {
        endpoint_id: { type: 'integer' },
        name: { type: 'string' },
        importance: { type: 'integer' },
        min_days_between: { type: 'integer' },
        active: { type: 'boolean' },
      },
      required: ['endpoint_id'],
    },
    request: ({ endpoint_id, ...rest }) => ({
      method: 'PATCH', path: `/endpoints/${endpoint_id}`, body: rest,
    }),
    check: async (a) => ({
      warnings: a.importance != null
        ? ['שינוי משקל משנה את הנתח של כל שאר נקודות הקצה']
        : [],
    }),
  },

  create_channel: {
    perm: 'settings',
    description: 'ערוץ מדיה חדש.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, max_per_week: { type: 'integer' } },
      required: ['name'],
    },
    request: (a) => ({ method: 'POST', path: '/channels', body: a }),
  },

  update_channel: {
    perm: 'settings',
    description: 'עדכון ערוץ: קצב שבועי, תקרות לפי סוג, וימים חסומים. ' +
      'blocked_days הוא מערך מספרי ימים, 0=ראשון עד 6=שבת.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'integer' },
        name: { type: 'string' },
        max_per_week: { type: 'integer' },
        target_per_week: { type: 'number' },
        max_promo_per_week: { type: 'integer' },
        max_value_per_week: { type: 'integer' },
        max_hybrid_per_week: { type: 'integer' },
        blocked_days: { type: 'array', items: { type: 'integer' } },
        active: { type: 'boolean' },
      },
      required: ['channel_id'],
    },
    request: ({ channel_id, ...rest }) => ({
      method: 'PATCH', path: `/channels/${channel_id}`, body: rest,
    }),
    check: (a) => checkChannelUpdate(a),
  },

  create_task: {
    perm: 'content',
    description: 'משימה חדשה לצוות.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        due_on: { type: 'string', description: 'YYYY-MM-DD' },
        assignee_id: { type: 'integer' },
        endpoint_id: { type: 'integer' },
        urgent: { type: 'boolean' },
      },
      required: ['title'],
    },
    request: (a) => ({ method: 'POST', path: '/tasks', body: a }),
  },

  create_milestone: {
    perm: 'settings',
    description: 'אבן דרך על ציר האסטרטגיה — תאריך שמסומן בלוח הזמנים.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        on_date: { type: 'string', description: 'YYYY-MM-DD' },
        endpoint_id: { type: 'integer' },
      },
      required: ['label', 'on_date'],
    },
    request: (a) => ({ method: 'POST', path: '/strategy/milestones', body: a }),
  },
};

/* ========================= בדיקות מוקדמות ========================= */

async function checkCampaignWindow(a) {
  const e = await one('select name, active from endpoints where id = $1', [a.endpoint_id]);
  if (!e) return { error: 'לא נמצאה נקודת קצה עם המזהה הזה' };

  const warnings = [];
  if (!e.active) warnings.push(`נקודת הקצה "${e.name}" לא פעילה`);
  if (a.starts_on && a.ends_on && a.starts_on > a.ends_on) {
    return { error: 'תאריך הסיום מוקדם מתאריך ההתחלה' };
  }
  if (a.starts_on && a.ends_on) {
    const overlap = await rows(
      `select name from campaigns
        where endpoint_id = $1 and active = true and paused_at is null
          and coalesce(starts_on, '-infinity') <= $3::date
          and coalesce(ends_on, 'infinity') >= $2::date`,
      [a.endpoint_id, a.starts_on, a.ends_on]);
    if (overlap.length) {
      warnings.push(
        `חופף לקמפיינים קיימים על אותה נקודת קצה: ${overlap.map((c) => c.name).join(', ')} — ` +
        'השטח יתחלק ביניהם');
    }
  }
  if (Array.isArray(a.channel_ids) && a.channel_ids.length) {
    const found = await rows('select id from channels where id = any($1::int[]) and active = true',
      [a.channel_ids]);
    if (found.length !== a.channel_ids.length) {
      return { error: 'חלק מהמדיות שנבחרו לא קיימות או לא פעילות' };
    }
  } else {
    warnings.push('לא נבחרו מדיות — הקמפיין לא יקבל שיבוצים עד שיוגדרו');
  }
  return { warnings };
}

async function checkCampaignUpdate(a) {
  const c = await one('select * from campaigns where id = $1', [a.campaign_id]);
  if (!c) return { error: 'לא נמצא קמפיין עם המזהה הזה' };

  const starts = a.starts_on ?? c.starts_on;
  const ends = a.ends_on ?? c.ends_on;
  if (starts && ends && String(starts).slice(0, 10) > String(ends).slice(0, 10)) {
    return { error: 'תאריך הסיום מוקדם מתאריך ההתחלה' };
  }

  const warnings = [];
  if (a.starts_on && c.starts_on && String(a.starts_on).slice(0, 10) !== String(c.starts_on).slice(0, 10)) {
    const moving = await one(
      `select count(*)::int as n from posts p join content_items ci on ci.id = p.content_id
        where ci.campaign_id = $1 and p.status in ('scheduled','pending_approval','hole')
          and p.scheduled_at >= now()`, [c.id]);
    if (moving.n) warnings.push(`${moving.n} שיבוצים עתידיים יזוזו יחד עם הקמפיין`);
  }
  return { warnings };
}

async function checkChannelUpdate(a) {
  const ch = await one('select * from channels where id = $1', [a.channel_id]);
  if (!ch) return { error: 'לא נמצא ערוץ עם המזהה הזה' };

  const warnings = [];
  const blocked = a.blocked_days;
  if (Array.isArray(blocked)) {
    if (blocked.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { error: 'blocked_days חייב להכיל מספרים בין 0 ל-6' };
    }
    if (blocked.length >= 7) return { error: 'אי אפשר לחסום את כל ימות השבוע' };
    const added = blocked.filter((d) => !(ch.blocked_days ?? []).includes(d));
    if (added.length) {
      const clash = await rows(
        `select id, title, scheduled_at from posts
          where channel_id = $1 and status in ('scheduled','pending_approval','hole')
            and scheduled_at >= now()
            and extract(dow from scheduled_at)::int = any($2::int[])`,
        [a.channel_id, added]);
      if (clash.length) {
        warnings.push(
          `${clash.length} שיבוצים עתידיים כבר יושבים על ימים שייחסמו — הם לא יוזזו אוטומטית ` +
          `(${clash.slice(0, 3).map((p) => p.title).join(', ')})`);
      }
    }
  }
  const cap = a.max_per_week;
  if (cap != null && cap < (ch.target_per_week ?? 0)) {
    warnings.push(`התקרה השבועית (${cap}) נמוכה מהיעד השבועי (${ch.target_per_week})`);
  }
  return { warnings };
}

async function checkMove({ post_id, scheduled_at, channel_id }) {
  const p = await one('select * from posts where id = $1', [post_id]);
  if (!p) return { error: 'לא נמצא שיבוץ עם המזהה הזה' };
  if (!scheduled_at && !channel_id) return { error: 'צריך תאריך חדש או מדיה חדשה' };

  const when = scheduled_at ?? p.scheduled_at;
  const target = channel_id ?? p.channel_id;
  const when_ = new Date(when);
  if (Number.isNaN(when_.getTime())) return { error: 'התאריך לא תקין' };

  const ch = await one('select name, blocked_days from channels where id = $1', [target]);
  if (!ch) return { error: 'לא נמצאה מדיה עם המזהה הזה' };
  if ((ch.blocked_days ?? []).includes(when_.getDay())) {
    return { error: `${ch.name} לא מקבל תוכן בימי ${HE_DAYS[when_.getDay()]}` };
  }

  if (p.endpoint_id) {
    const clash = await one(
      `select title from posts
        where id <> $1 and endpoint_id = $2 and channel_id = $3 and scheduled_at::date = $4::date`,
      [p.id, p.endpoint_id, target, when]);
    if (clash) {
      return { error: `כבר יש פוסט לאותה נקודת קצה במדיה הזו באותו יום: ${clash.title}` };
    }
  }

  if (channel_id && channel_id !== p.channel_id && p.content_id) {
    const v = await one(
      'select status from content_variants where content_id = $1 and channel_id = $2',
      [p.content_id, channel_id]);
    if (!v) return { error: `אין לתוכן הזה גרסה ל${ch.name} — צריך לכתוב אותה קודם` };
  }

  const warnings = [];
  if (when_ < new Date()) warnings.push('התאריך החדש כבר עבר');

  // מרווח צמוד מדי הוא אזהרה למשתמש, לא סיבה לפסול את ההצעה
  const gap = await gapWarning({
    endpointId: p.endpoint_id, channelId: target, when, excludePostId: p.id,
  });
  if (gap) warnings.push(gap.message);
  return { warnings };
}

/* ========================= הרכבת רשימת הכלים ========================= */

const hasPerm = (user, perm) => !!user && (user.is_owner || user[`perm_${perm}`]);

function toolsFor(user) {
  const list = Object.entries(READ_TOOLS).map(([name, t]) => ({
    name, description: t.description, input_schema: t.input_schema,
  }));

  for (const [name, t] of Object.entries(WRITE_TOOLS)) {
    if (!hasPerm(user, t.perm)) continue;
    // כל הצעה חייבת לבוא עם משפט שמסביר למשתמש מה עומד לקרות
    const schema = structuredClone(t.input_schema);
    schema.properties.summary = {
      type: 'string',
      description: 'משפט אחד בעברית שמתאר למשתמש בדיוק מה יקרה אם יאשר',
    };
    schema.required = [...(schema.required ?? []), 'summary'];
    list.push({
      name,
      description: `${t.description}\n[פעולה — לא מתבצעת מיד. נוצרת הצעה שהמשתמש מאשר.]`,
      input_schema: schema,
    });
  }
  return list;
}

/* ========================= לולאת השיחה ========================= */

/**
 * @param {object} user       המשתמש המחובר
 * @param {Array}  history    היסטוריית ההודעות (נשמרת אצל הלקוח)
 * @param {string} message    ההודעה החדשה
 */
export async function chat(user, history, message) {
  const snap = await snapshot();
  const system = systemPrompt(user, snap);
  const tools = toolsFor(user);

  const messages = [...trimHistory(history), { role: 'user', content: message }];
  const proposals = [];
  // מחיר משוער לשיחה — כדי שהעלות תהיה גלויה ולא הפתעה בסוף החודש
  const spent = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const cost = () => ({
    input_tokens: spent.input + spent.cacheWrite + spent.cacheRead,
    output_tokens: spent.output,
    cached: spent.cacheRead,
    usd: +(
      (spent.input + spent.cacheWrite * 1.25 + spent.cacheRead * 0.1) / 1e6 * PRICE_IN
      + spent.output / 1e6 * PRICE_OUT
    ).toFixed(4),
  });

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const res = await ask({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      // effort בינוני: העוזר קורא נתונים ומסביר, לא פותר בעיות קשות.
      // ב-high כל שאלה לקחה כ-45 שניות — יותר מדי לחלון צ'אט.
      output_config: { effort: 'medium' },
      // ההגדרות והכלים לא משתנים בין סבבי הכלים של אותה שאלה. נקודת מטמון
      // עליהם הופכת אותם לקריאה זולה מהסבב השני והלאה, במקום שליחה מלאה.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      tools,
      messages,
    });

    spent.input += res.usage.input_tokens;
    spent.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    spent.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    spent.output += res.usage.output_tokens;

    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'refusal') {
      return { messages, reply: 'לא הצלחתי לענות על זה.', proposals, usage: cost() };
    }
    if (res.stop_reason !== 'tool_use') {
      return { messages, reply: textOf(res.content), proposals, usage: cost() };
    }

    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      const out = await runTool(user, block, proposals);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out.value).slice(0, 60000),
        ...(out.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    messages,
    reply: 'הסתבכתי — יותר מדי שלבים. נסה לנסח את הבקשה בצורה ממוקדת יותר.',
    proposals,
    usage: cost(),
  };
}

/**
 * קריאה למודל, עם תרגום שגיאות הספק להודעה שאפשר לפעול לפיה.
 * בלי זה המשתמש מקבל JSON באנגלית מתוך ה-SDK.
 */
async function ask(params) {
  try {
    return await anthropic().messages.create(params);
  } catch (e) {
    throw friendlyAiError(e);
  }
}

const MAX_HISTORY = 40;

/**
 * גוזם היסטוריה ארוכה, אבל תמיד בגבול של הודעת משתמש רגילה —
 * חיתוך באמצע זוג tool_use/tool_result נדחה על ידי ה-API.
 */
function trimHistory(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length <= MAX_HISTORY) return list;

  for (let i = list.length - MAX_HISTORY; i < list.length; i += 1) {
    const m = list[i];
    if (m.role === 'user' && typeof m.content === 'string') return list.slice(i);
  }
  return [];
}

async function runTool(user, block, proposals) {
  const read = READ_TOOLS[block.name];
  if (read) {
    try {
      return { value: await read.run(block.input ?? {}) };
    } catch (e) {
      return { value: { error: e.message }, isError: true };
    }
  }

  const write = WRITE_TOOLS[block.name];
  if (!write) return { value: { error: 'כלי לא מוכר' }, isError: true };
  if (!hasPerm(user, write.perm)) {
    return { value: { error: 'למשתמש אין הרשאה לפעולה הזו' }, isError: true };
  }

  const { summary, ...args } = block.input ?? {};

  let warnings = [];
  if (write.check) {
    try {
      const checked = await write.check(args);
      if (checked?.error) {
        return { value: { error: checked.error, hint: 'תקן ונסה שוב, או שאל את המשתמש' }, isError: true };
      }
      warnings = checked?.warnings ?? [];
    } catch (e) {
      return { value: { error: e.message }, isError: true };
    }
  }

  const req = write.request(args);
  const id = remember(user.id, {
    tool: block.name,
    summary: summary || block.name,
    args,
    warnings,
    ...req,
  });
  proposals.push({ id, tool: block.name, summary: summary || block.name, args, warnings });

  return {
    value: {
      status: 'ההצעה הוצגה למשתמש וממתינה לאישור שלו. שום דבר עוד לא בוצע.',
      proposal_id: id,
      warnings,
    },
  };
}

const textOf = (content) =>
  content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
  || 'אין לי מה להוסיף.';

/* ========================= ביצוע הצעה שאושרה ========================= */

/**
 * מבצע דרך אותו נתיב API שהממשק משתמש בו, עם הקוקי של המשתמש —
 * כך שההרשאות והבדיקות זהות לחלוטין לפעולה ידנית.
 */
/** נחשף לבדיקות בלבד — לא בשימוש בשרת עצמו */
export const _internals = { READ_TOOLS, WRITE_TOOLS, toolsFor, remember };

export async function execute(proposal, cookie) {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const res = await fetch(`${base}/api${proposal.path}`, {
    method: proposal.method,
    headers: {
      cookie: cookie ?? '',
      // מסמן ביומן הפעולות שזו הצעה של העוזר שהמשתמש אישר, ולא פעולה ידנית
      [VIA_HEADER]: 'assistant',
      ...(proposal.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: proposal.body ? JSON.stringify(proposal.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'הפעולה נכשלה');
  return data;
}
