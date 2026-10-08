/**
 * הרשאות של מפתחות API, ואילו נתיבים כל אחת פותחת. מודול טהור.
 * המבנה הועתק מ-Backbone (lib/auth/api-scopes.ts).
 *
 * עקרונות:
 *  - הרשאה לכל פעולה, עדינה יותר ממתגי ההרשאות של בני אדם (content/settings/
 *    approve/users). בעל המפתח מסמן בדיוק מה הסוכן צריך.
 *  - הסוכן עובר דרך אותם נתיבים שהממשק משתמש בהם (ולכן אותן בדיקות, אותו
 *    יומן), אבל רק דרך נתיבים שמופיעים ב-ROUTES. כל השאר — 404. רשימה לבנה:
 *    נתיב חדש בממשק לא נפתח לסוכנים מעצמו.
 *  - מחוץ לרשימה בכוונה (החלטת המשתמש 8.10.26): מחיקה מכל סוג, אישור/דחייה
 *    של פוסטים, פרסום ושליחה, ניהול קמפיינים ומנוע השיבוץ, הגדרות, ערוצים,
 *    חיבורים ומשתמשים. מה שלא ברשימה — לא קיים ל-API.
 *  - מעבר לרשימה, כללים שחלים רק על סוכן (guards.js): לא משנה תוכן של פוסט
 *    מאושר, לא מעביר תוכן בין קמפיינים, לא מחליף/מוחק בקישור או בתוצאות.
 *  - implies גוזר רק קריאות שהכתיבה צריכה, אף פעם כתיבה. ההרחבה קורית
 *    באימות ולא בשמירה — במסד נשמר מה שאדם סימן.
 *  - הרשאות נשמרות במסד כטקסט; parseScopes מסנן כל מה שלא ברשימה — גם
 *    משורה ישנה במסד. הוספת הרשאה = שורה כאן, בלי מיגרציה.
 */

export const API_SCOPE_REGISTRY = {
  'board.read': {
    group: 'read', label: 'צפייה בלוח',
    description: 'הלוח השבועי, הפוסטים, תצוגה מקדימה ויומן הפרסום של פוסט',
  },
  'campaigns.read': {
    group: 'read', label: 'צפייה בקמפיינים',
    description: 'קמפיינים, נקודות קצה, ערוצים, אסטרטגיה והתראות',
  },
  'content.read': {
    group: 'read', label: 'צפייה בתוכן',
    description: 'מאגר התוכן, הניסוחים לכל ערוץ והקבצים המצורפים',
  },
  'tasks.read': {
    group: 'read', label: 'צפייה במשימות',
    description: 'רשימת המשימות והמונה שלהן',
  },
  'results.read': {
    group: 'read', label: 'צפייה בתוצאות',
    description: 'סטטיסטיקות, ביצועים ותוצאות שהוזנו לפוסטים',
  },
  'content.write': {
    group: 'write', label: 'כתיבת תוכן',
    description: 'יצירה ועריכה של תוכן, ניסוח לכל ערוץ והעלאת קבצים. בלי מחיקה, ולא תוכן של פוסט שכבר אושר',
    implies: ['content.read', 'campaigns.read'],
  },
  'content.schedule': {
    group: 'write', label: 'שיבוץ תוכן במשבצות',
    description: 'שיוך תוכן לפוסט בלוח, וקישור/ניתוק של תוכן בין ערוצים. לא מאשר ולא מפרסם',
    implies: ['board.read', 'content.read'],
  },
  'tasks.write': {
    group: 'write', label: 'עדכון משימות',
    description: 'יצירה ועדכון של משימות. משימת אישור נשארת סגורה לסוכן. בלי מחיקה',
    implies: ['tasks.read'],
  },
  'results.write': {
    group: 'write', label: 'הזנת תוצאות',
    description: 'הזנת תוצאות (חשיפות, קליקים, לידים) לפוסטים שפורסמו',
    implies: ['results.read', 'board.read'],
  },
};

export const API_SCOPES = Object.keys(API_SCOPE_REGISTRY);

/**
 * הנתיבים הפתוחים לסוכנים, יחסית ל-/api/v1. scope null = כל מפתח תקף.
 * כתובות זהות לנתיבי /api של הממשק — אותו handler בדיוק.
 */
export const ROUTES = [
  ['GET', '/whoami', null],

  ['GET', '/board', 'board.read'],
  ['GET', '/posts/candidates', 'board.read'],
  ['GET', '/posts/unconfirmed', 'board.read'],
  ['GET', '/posts/:id/preview', 'board.read'],
  ['GET', '/posts/:id/publish-log', 'board.read'],

  ['GET', '/campaigns', 'campaigns.read'],
  ['GET', '/endpoints', 'campaigns.read'],
  ['GET', '/channels', 'campaigns.read'],
  ['GET', '/strategy', 'campaigns.read'],
  ['GET', '/alerts', 'campaigns.read'],

  ['GET', '/content', 'content.read'],
  ['GET', '/assets/:id', 'content.read'],

  ['GET', '/tasks', 'tasks.read'],
  ['GET', '/tasks/count', 'tasks.read'],

  ['GET', '/stats', 'results.read'],
  ['GET', '/performance', 'results.read'],
  ['GET', '/results', 'results.read'],
  ['GET', '/results/summary', 'results.read'],

  ['POST', '/content', 'content.write'],
  ['PATCH', '/content/:id', 'content.write'],
  ['PUT', '/content/:id/variants/:channelId', 'content.write'],
  ['POST', '/content/:id/copy-assets', 'content.write'],
  // קבצים רק דרך R2 (sign → PUT ישיר → complete), שם סוג הקובץ נבדק מול רשימה
  // (media.js isAllowedMime). לא המסלול הישן (multipart → המסד): הוא שומר כל
  // סוג קובץ ומגיש אותו inline מהדומיין שלנו (XSS מול הבעלים), ובלי תקרה
  // אמיתית ממלא את ה-volume. גם PUT /results המרוכז לא — הוא מוחק שורות.
  ['POST', '/content/:id/uploads/sign', 'content.write'],
  ['POST', '/content/:id/uploads/complete', 'content.write'],

  ['POST', '/posts/:id/attach-content', 'content.schedule'],
  ['POST', '/content/:id/link', 'content.schedule'],
  ['POST', '/content/:id/unlink', 'content.schedule'],

  ['POST', '/tasks', 'tasks.write'],
  ['PATCH', '/tasks/:id', 'tasks.write'],

  ['PUT', '/posts/:id/results', 'results.write'],
];

const COMPILED = ROUTES.map(([method, path, scope]) => ({
  method, path, scope,
  re: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '[^/]+')}/?$`),
}));

/** הנתיב הפתוח שמתאים לבקשה, או null (= לא קיים לסוכנים) */
export function matchRoute(method, path) {
  // HEAD נענה כמו GET (express עושה אותו דבר)
  const m = method === 'HEAD' ? 'GET' : method;
  return COMPILED.find((r) => r.method === m && r.re.test(path)) ?? null;
}

/** מסנן קלט (טופס או שורה במסד) לרשימת הרשאות תקפה, בסדר הרישום */
export function parseScopes(input) {
  const wanted = new Set((Array.isArray(input) ? input : []).filter((v) => typeof v === 'string'));
  return API_SCOPES.filter((s) => wanted.has(s));
}

/** ההרשאות שסומנו + מה שהן גוזרות (קריאות בלבד) */
export function expandScopes(scopes) {
  const out = new Set();
  const queue = [...parseScopes(scopes)];
  while (queue.length) {
    const s = queue.shift();
    if (out.has(s)) continue;
    out.add(s);
    for (const implied of API_SCOPE_REGISTRY[s].implies ?? []) queue.push(implied);
  }
  return API_SCOPES.filter((s) => out.has(s));
}

/** מה שנגזר ולא סומן במפורש — לתצוגה "כלול אוטומטית" */
export function derivedScopes(granted) {
  const explicit = new Set(parseScopes(granted));
  return expandScopes(granted).filter((s) => !explicit.has(s));
}

/** מפתח עם הרשאת כתיבה כלשהי עובר את requirePerm('content') של הנתיבים */
export const writesContent = (scopes) => scopes.some((s) => API_SCOPE_REGISTRY[s].group === 'write');
