import { confirmDialog } from './confirm.js';
import { sessionExpired } from './session.js';

/** ההודעה של פעולה שנכשלה כי החיבור פג — החלון של session.js מסביר את השאר */
export const SESSION_ERROR = 'החיבור פג — מתחברים מחדש וחוזרים על הפעולה';

/** כל הנתונים מגיעים מ-/api. שכבה 0. */
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    // לא עוזבים את הדף: טופס פתוח נשאר כמו שהוא עד שמתחברים מחדש
    sessionExpired();
    const err = new Error(SESSION_ERROR);
    err.status = 401;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // גוף התשובה נשמר על השגיאה: יש נתיבים שמחזירים אזהרה שאפשר לאשר
    const err = new Error(data.error || 'הפעולה נכשלה');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/** כפתור האישור אומר מה קורה — לא "אישור" (docs/ux-overhaul.md, כפתורים) */
const GAP_VERBS = { 'לשבץ בכל זאת?': 'שבץ בכל זאת', 'לשמור בכל זאת?': 'שמור בכל זאת',
                    'לשייך בכל זאת?': 'שייך בכל זאת' };

/**
 * שיבוץ שהשרת מזהיר עליו (צמוד מדי, מחוץ לחלון הקמפיין, פוסט מקושר באותו
 * יום, חריגה ממכסות). האזהרה אינה חסימה: מציגים את כל מה שהשרת יודע
 * בחלון אחד ושואלים, ומי שמאשר שולח שוב עם confirm_warnings (ו-confirm_gap,
 * שנתיבי הקמפיין עוד קוראים) — אישור אחד לכל האזהרות.
 */
export async function postWithGapCheck(path, body, method = 'PATCH', question = 'לשבץ בכל זאת?') {
  try {
    return await api(path, { method, body });
  } catch (e) {
    if (e.status !== 409 || !e.payload?.needs_confirm) throw e;
    const w = e.payload.warning;
    const okLabel = GAP_VERBS[question] ?? 'המשך בכל זאת';
    if (!(await confirmDialog(`${w.message}\n\n${question}`, { okLabel }))) return null;
    return api(path, { method, body: { ...body, confirm_gap: true, confirm_warnings: true } });
  }
}
