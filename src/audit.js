/**
 * יומן הפעולות.
 *
 * נרשם במקום אחד — middleware שיושב מעל כל נתיבי ה-API — ולא בכל נתיב
 * בנפרד. כך שום פעולה לא נשכחת כשמוסיפים נתיב חדש, ופעולה שהעוזר הציע
 * והמשתמש אישר נרשמת בדיוק כמו פעולה ידנית, כי היא עוברת באותו נתיב.
 *
 * הרישום קורה אחרי שהתשובה נשלחה, ורק אם היא הצליחה. כישלון בכתיבה
 * ליומן לא מפיל את הבקשה — היומן הוא תיעוד, לא חלק מהפעולה.
 */

import { one, query } from './db.js';

/** הכותרת שהעוזר מוסיף כשהוא מבצע הצעה שאושרה */
export const VIA_HEADER = 'x-mb-via';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** נתיבים שאין טעם לתעד: הם לא משנים נתונים, או שהם רועשים מדי */
const SKIP = [
  /^\/assistant\/(chat|status)$/,   // שיחה עם העוזר — הפעולה עצמה נרשמת באישור
  /^\/engine\/plan$/,               // תכנון בלבד, לא כותב כלום
  /^\/urgent\/preview$/,
];

const ENTITY_HE = {
  posts: 'שיבוץ',
  campaigns: 'קמפיין',
  content: 'תוכן',
  endpoints: 'נקודת קצה',
  channels: 'ערוץ',
  tasks: 'משימה',
  users: 'משתמש',
  assets: 'קובץ',
  settings: 'כללי המנוע',
  strategy: 'אבן דרך',
  engine: 'מנוע השיבוץ',
  urgent: 'מבצע דחוף',
  auth: 'התחברות',
};

/** שם הישות מתוך גוף התשובה — כך היומן מציג שם ולא רק מזהה */
function nameOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['campaign', 'content', 'endpoint', 'channel', 'task', 'user', 'post', 'milestone']) {
    const v = payload[key];
    if (v && typeof v === 'object') return v.name ?? v.title ?? null;
  }
  return null;
}

/**
 * מתרגם בקשה לשורה ביומן.
 * @returns {{action:string, entity:string, entity_id:string|null, summary:string}}
 */
function describe(req, payload, deletedName) {
  const parts = req.path.split('/').filter(Boolean);   // ['campaigns','4','pause']
  const [entity, id, sub] = parts;
  const he = ENTITY_HE[entity] ?? entity;
  const name = deletedName ?? nameOf(payload) ?? req.body?.name ?? req.body?.title ?? null;
  const label = name ? `"${name}"` : id ? `#${id}` : '';

  // פעולות עם שם משלהן — לפני הכלל הכללי לפי המתודה
  const special = {
    'posts/publish':      ['publish', `סימן שיבוץ ${label} כפורסם`],
    'posts/approve':      ['approve', `אישר שיבוץ ${label}`],
    'campaigns/pause':    ['pause',   `השהה קמפיין ${label}`],
    'campaigns/resume':   ['resume',  `הפעיל מחדש קמפיין ${label}`],
    'campaigns/order':    ['update',  `סידר מחדש את התוכן בקמפיין ${label}`],
    'campaigns/bulk':     ['create',  `העלה קבצים לקמפיין ${label}`],
    'campaigns/assets':   ['create',  `העלה קבצים לקמפיין ${label}`],
    'content/assets':     ['create',  `הוסיף קבצים לתוכן ${label}`],
    'content/variants':   ['update',  `כתב ניסוח לתוכן ${label} במדיה #${parts[3] ?? ''}`],
    'engine/apply':       ['apply',   'הריץ את מנוע השיבוץ ומילא את השבוע'],
    'urgent/commit':      ['create',  `שיבץ מבצע דחוף ${label}`],
    'auth/login':         ['login',   'התחבר למערכת'],
    'auth/logout':        ['logout',  'התנתק'],
  };

  const key = sub ? `${entity}/${sub}` : id && !/^\d+$/.test(id) ? `${entity}/${id}` : null;
  if (key && special[key]) {
    const [action, summary] = special[key];
    return { action, entity, entity_id: /^\d+$/.test(id ?? '') ? id : null, summary };
  }
  // מחיקת גרסה למדיה מגיעה כ-DELETE על content/:id/variants/:channelId
  if (entity === 'content' && sub === 'variants' && req.method === 'DELETE') {
    return { action: 'delete', entity, entity_id: id, summary: `מחק ניסוח מתוכן ${label}` };
  }

  const byMethod = {
    POST:   ['create', `יצר ${he} ${label}`],
    PATCH:  ['update', `עדכן ${he} ${label}`],
    PUT:    ['update', `עדכן ${he} ${label}`],
    DELETE: ['delete', `מחק ${he} ${label}`],
  }[req.method];

  return {
    action: byMethod[0],
    entity,
    entity_id: /^\d+$/.test(id ?? '') ? id : null,
    summary: byMethod[1].trim(),
  };
}

/**
 * מה שווה לשמור מגוף הבקשה: השדות שהשתנו, בלי טקסטים ארוכים וקבצים.
 * המטרה היא לענות על "מה בדיוק השתנה", לא לשכפל את הנתונים.
 */
function slimBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v == null) { out[k] = null; continue; }
    if (typeof v === 'string') { out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v; continue; }
    if (typeof v === 'object') { out[k] = Array.isArray(v) ? v.slice(0, 20) : '[object]'; continue; }
    out[k] = v;
  }
  delete out.password;
  return Object.keys(out).length ? out : null;
}

/**
 * בטבלה שנמחקת ממנה שורה אין יותר מה לקרוא אחרי המחיקה, ולכן את השם
 * שולפים לפני. בלי זה היומן היה מציג "מחק נקודת קצה #4".
 */
const DELETE_SOURCE = {
  endpoints: ['endpoints', 'name'],
  campaigns: ['campaigns', 'name'],
  channels: ['channels', 'name'],
  content: ['content_items', 'title'],
  posts: ['posts', 'title'],
  tasks: ['tasks', 'title'],
  users: ['users', 'name'],
  assets: ['content_assets', 'filename'],
};

async function nameBeforeDelete(req) {
  const [entity, id] = req.path.split('/').filter(Boolean);
  const src = DELETE_SOURCE[entity];
  if (!src || !/^\d+$/.test(id ?? '')) return null;
  const [table, col] = src;
  try {
    return (await one(`select ${col} as n from ${table} where id = $1`, [id]))?.n ?? null;
  } catch {
    return null;   // היומן לא שובר בקשה
  }
}

export async function audit(req, res, next) {
  if (!MUTATING.has(req.method) || SKIP.some((re) => re.test(req.path))) return next();

  // חייב להסתיים לפני שהנתיב מוחק: השאילתה שלנו והמחיקה רצות על חיבורים
  // שונים בבריכה, ובלי המתנה המחיקה יכולה להקדים ולהחזיר כלום.
  const deletedName = req.method === 'DELETE' ? await nameBeforeDelete(req) : null;

  // גוף התשובה נחוץ כדי לדעת את שם הישות שנוצרה או עודכנה
  let payload = null;
  const json = res.json.bind(res);
  res.json = (body) => { payload = body; return json(body); };

  res.on('finish', () => {
    if (res.statusCode >= 400) return;

    // התחברות מזוהה מגוף התשובה: ב-loadUser עוד לא היה קוקי
    const user = req.user ?? payload?.user ?? null;
    if (!user) return;

    const { action, entity, entity_id, summary } = describe(req, payload, deletedName);
    const via = req.get(VIA_HEADER) === 'assistant' ? 'assistant' : 'ui';

    query(
      `insert into activity_log (user_id, user_name, via, action, entity, entity_id, summary, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user.id, user.name ?? 'לא ידוע', via, action, entity, entity_id ?? null, summary,
       slimBody(req.body)]
    ).catch((e) => console.error('כתיבה ליומן הפעולות נכשלה:', e.message));
  });

  next();
}
