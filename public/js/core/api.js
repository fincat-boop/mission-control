import { confirmDialog } from './confirm.js';
import { sessionExpired } from './session.js';
import { toastNote } from './dom.js';

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
  noteApprovalReset(path, data);
  return data;
}

/**
 * "N פוסטים מאושרים חזרו לאישור" — טהורה, לבדיקה. why: 'content' (התוכן
 * השתנה, סעיף 31) או 'channel' (הערוץ הפסיק להתפרסם לבד, D1)
 */
export function approvalResetText(n, why = 'content') {
  const head = n === 1 ? 'פוסט מאושר אחד חזר לאישור' : `${n} פוסטים מאושרים חזרו לאישור`;
  if (why === 'channel') return `${head} — הערוץ כבר לא מתפרסם לבד.`;
  return `${head} — ${n === 1 ? 'התוכן שלו' : 'התוכן שלהם'} השתנה אחרי האישור.`;
}

/**
 * סעיף 31: עריכת תוכן (גרסה, קבצים, קישור) שהחזירה פוסטים מאושרים לאישור —
 * השרת מחזיר approval_reset: N, וההודעה יוצאת מכאן, מכל מקום שעורך תוכן
 * (טופס, שמירה אוטומטית, העלאה). גם חיבור ערוץ (D1 — כיבוי האוטומטי או
 * ניתוק). בנתיבים אחרים approval_reset אומר דבר אחר, והמסך שלהם מסביר אותו.
 */
export function noteApprovalReset(path, data) {
  const n = Number(data?.approval_reset);
  if (!Number.isInteger(n) || n <= 0) return;
  if (/^\/(content|assets)\//.test(path)) toastNote(approvalResetText(n));
  else if (/^\/channels\/\d+\/connection$/.test(path)) toastNote(approvalResetText(n, 'channel'));
}

/** כפתור האישור אומר מה קורה — לא "אישור" (docs/ux-overhaul.md, כפתורים) */
const GAP_VERBS = { 'לשבץ בכל זאת?': 'שבץ בכל זאת', 'לשמור בכל זאת?': 'שמור בכל זאת',
                    'לשייך בכל זאת?': 'שייך בכל זאת', 'להחליף בכל זאת?': 'החלף בכל זאת' };

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
