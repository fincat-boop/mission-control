/**
 * "הוראות חיבור לסוכן" — טקסט שמדביקים בהנחיות המערכת של הבוט. נבנה
 * מהרשימה ב-scopes.js, כך שהוא תמיד תואם למה שהשער אוכף בפועל.
 * הועתק מ-Backbone (lib/agent/handbook.ts).
 */

import { API_SCOPE_REGISTRY, API_SCOPES, ROUTES } from './scopes.js';
import { PER_IP_PER_MINUTE, PER_KEY_PER_MINUTE } from './authenticate.js';

export function buildAgentHandbook(baseUrl) {
  const base = `${String(baseUrl).replace(/\/$/, '')}/api/v1`;
  const lines = [];
  const add = (...l) => lines.push(...l);

  add(
    '# Mission Control (מרכז בקרה) — API לסוכנים',
    '',
    'מרכז בקרה מתכנן ומשבץ תוכן שיווקי: קמפיינים, נקודות קצה (מוצרים/הצעות), ערוצים',
    '(פייסבוק, אינסטגרם, ניוזלטר, וואטסאפ...), פריטי תוכן עם ניסוח לכל ערוץ, ופוסטים',
    'בלוח השבועי. הסוכן קורא, כותב תוכן ומשבץ אותו — אדם מאשר ומפרסם.',
    '',
    '## חיבור',
    `כתובת בסיס: ${base}`,
    'כל בקשה: Authorization: Bearer <המפתח>',
    'גוף בקשה: JSON (Content-Type: application/json). העלאת קבצים: multipart/form-data.',
    'קריאה מהשרת בלבד: בקשה עם כותרת Origin (מדפדפן) נדחית ב-403.',
    'מפתח mc_test_ עובד רק מחוץ לפרודקשן; בפרודקשן — mc_live_.',
    'בדיקת חיבור: GET /whoami מחזיר את שם המפתח ואת ההרשאות שלו.',
    '',
    '## תשובות',
    'הצלחה: 200/201 עם JSON. שגיאה: { "error": "<הסבר בעברית>" }. להחליט לפי הסטטוס, לא לפי הטקסט:',
    '400 — הבקשה לא תקינה (ההסבר אומר מה לתקן)',
    '401 — המפתח חסר, שגוי, מבוטל או פג תוקף',
    '403 — למפתח אין את ההרשאה לנתיב (ההסבר מציין איזו), או בקשה מדפדפן',
    '404 — הנתיב לא פתוח לסוכנים, או שהפריט לא נמצא',
    '409 — התנגשות: מישהו שינה את הפריט בינתיים, או שמצבו לא מאפשר את הפעולה. לקרוא מחדש ולנסות שוב',
    `429 — יותר מדי בקשות (${PER_KEY_PER_MINUTE} לדקה למפתח, ${PER_IP_PER_MINUTE} לדקה לכתובת IP). לחכות דקה`,
    '',
    '## כללים',
    '- אין מחיקה, אין אישור או דחייה של פוסטים, ואין פרסום. אלה נשארים בידי אדם.',
    '- תוכן שהסוכן כותב מסומן "טיוטה" או "מוכן" — אדם מאשר לפני שהוא יוצא.',
    '- משימת אישור לא נסגרת על ידי סוכן.',
    '- כל פעולה נרשמת ביומן הפעולות בשם "סוכן: <שם המפתח>".',
    '',
    '## נתיבים',
  );

  for (const scope of [null, ...API_SCOPES]) {
    const routes = ROUTES.filter(([, , s]) => s === scope);
    if (!routes.length) continue;
    const meta = scope ? API_SCOPE_REGISTRY[scope] : null;
    add('', scope ? `### ${scope} — ${meta.label}` : '### כל מפתח', ...(meta ? [meta.description] : []));
    for (const [method, path] of routes) add(`${method} ${path}`);
  }

  add(
    '',
    '## דוגמאות גוף',
    'POST /content — { "title": "...", "body": "...", "kind": "value|promo|hybrid", "campaign_id": 12 }',
    '  (בלי קמפיין: "endpoint_id" במקום campaign_id)',
    'PUT /content/{id}/variants/{channelId} — { "body": "...", "status": "draft|ready|not_relevant" }',
    'POST /posts/{id}/attach-content — { "content_id": 34 }',
    'POST /tasks — { "title": "...", "due_on": "2026-10-20" }',
    'PUT /posts/{id}/results — { "reach": 1200, "engagement": 80, "clicks": 15, "leads": 2 }',
    '',
    '## הרשאות קיימות',
    ...API_SCOPES.map((s) => {
      const m = API_SCOPE_REGISTRY[s];
      const implies = m.implies?.length ? ` (כולל: ${m.implies.join(', ')})` : '';
      return `${s} — ${m.label}: ${m.description}${implies}`;
    }),
  );

  return lines.join('\n');
}
