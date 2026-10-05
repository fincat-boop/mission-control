/**
 * ניוזלטר מול ה-HUB — הכללים הטהורים של הלקוח (בלי DOM ובלי state), כדי
 * שייבדקו בטסטים (test/hub-fill.test.js).
 *
 * עורך המייל הוא של ה-HUB עצמו (app/dashboard/mission-control/fill שם —
 * BoardFill.tsx): נפתח בחלון חדש, ומדבר איתנו בהודעות בין חלונות:
 *   1. העורך → אנחנו: {type:"mc-fill-ready"}           — מוכן לקבל ערכים
 *   2. אנחנו → העורך: {type:"mc-fill-init", values}     — הערכים השמורים
 *   3. העורך → אנחנו: {type:"mc-fill-save", values}     — שמירה (והחלון נסגר)
 * ה-HUB שולח רק למקור (origin) של הלוח; אנחנו מקבלים רק ממקורות ה-HUB
 * ורק מהחלון שפתחנו — כל הודעה אחרת נזרקת.
 */

export const FILL_READY = 'mc-fill-ready';
export const FILL_INIT = 'mc-fill-init';
export const FILL_SAVE = 'mc-fill-save';

/** תקרות הגנה על מה שמגיע מחלון אחר */
const MAX_FIELDS = 200;
const MAX_VALUE = 100000;

/** ערכי מילוי: רק מחרוזות לא ריקות, שם שדה עד 200 תווים */
export function cleanFillValues(values) {
  const out = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
  for (const [k, v] of Object.entries(values).slice(0, MAX_FIELDS)) {
    if (typeof v !== 'string' || !v.trim() || !k || k.length > 200) continue;
    out[k] = v.slice(0, MAX_VALUE);
  }
  return out;
}

/**
 * מפענח הודעה מחלון העורך. null — לא שלנו (מקור אחר, חלון אחר, סוג לא מוכר).
 * @param {{origin:string, source:any, data:any}} e אירוע message
 * @param {{origins:string[], source:any}} expect המקורות המורשים + החלון שפתחנו
 * @returns {{type:'ready'} | {type:'save', values:Record<string,string>} | null}
 */
export function readFillMessage(e, { origins, source }) {
  if (!e || !origins?.includes(e.origin)) return null;
  if (!source || e.source !== source) return null;
  const data = e.data;
  if (!data || typeof data !== 'object') return null;
  if (data.type === FILL_READY) return { type: 'ready' };
  if (data.type === FILL_SAVE) {
    if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values)) return null;
    return { type: 'save', values: cleanFillValues(data.values) };
  }
  return null;
}

/** ההודעה שעונה ל-"ready": הערכים השמורים אצלנו */
export const initMessage = (values) => ({ type: FILL_INIT, values: cleanFillValues(values) });

/** שדה התוכן של התבנית (לזריעה מגוף ישן) — לפי השמות המוכרים */
const CONTENT_NAMES = ['תוכן', 'גוף הגיליון', 'גוף ההודעה'];

/**
 * הערכים שנשלחים לעורך: מה שנשמר, ובנוסף — גוף שנכתב לפני המעבר לתבנית
 * נזרע לשדה התוכן אם הוא ריק (אחרת העורך היה נפתח ריק, והתצוגה מלאה).
 */
export function seedValues(fieldValues, body, fields = []) {
  const out = cleanFillValues(fieldValues);
  const content = fields.find((f) => CONTENT_NAMES.includes(f.name));
  if (content && body?.trim() && !out[content.name]) out[content.name] = body;
  return out;
}

/**
 * מצב ניוזלטר שהועבר ל-HUB, לתג בלוח ולחלון הפוסט — או null כשלא רלוונטי.
 * hub_status: הסטטוס האחרון שה-HUB דיווח (נשמר בכל בדיקה של הטיק).
 * @returns {{cls:string, label:string, tone:'warn'|'good', text:string}|null}
 */
export function newsletterHubTag(p) {
  if (p.status !== 'publishing' || !(p.hub_status || p.hub_transferred_at)) return null;
  if (p.hub_status === 'scheduled') {
    return { cls: 'auto', label: '✓ אושר ב-HUB', tone: 'good',
      text: 'אושר ב-HUB ומתוזמן לשליחה. הפוסט יסומן "פורסם" כשהשליחה תושלם.' };
  }
  if (p.hub_status === 'sending') {
    return { cls: 'auto', label: 'נשלח מה-HUB…', tone: 'good',
      text: 'ה-HUB שולח את הניוזלטר עכשיו. הפוסט יסומן "פורסם" כשהשליחה תושלם.' };
  }
  return { cls: 'yellow', label: 'ממתין לאישור ב-HUB', tone: 'warn',
    text: 'הניוזלטר הועבר ל-HUB וממתין לאישור שם. אחרי האישור הוא יישלח במועד, והפוסט יסומן "פורסם".' };
}

/**
 * מה אפשר לעשות עם פוסט ניוזלטר בעורך: 'transfer' (העבר ל-HUB), 'open'
 * (כבר בידי ה-HUB — פתח שם), או null + סיבה.
 */
export function newsletterPostAction(p, { now = new Date(), ready = false, subject = '' } = {}) {
  if (['publishing', 'published'].includes(p.status) && p.external_url) return { action: 'open' };
  if (p.status === 'published') return { action: null, reason: 'כבר נשלח' };
  if (!['scheduled', 'approved', 'failed'].includes(p.status)) return { action: null, reason: '' };
  if (new Date(p.scheduled_at).getTime() <= now.getTime()) {
    return { action: null, reason: 'המועד עבר — קובעים מועד חדש בלוח' };
  }
  if (!ready) return { action: null, reason: 'קודם מסמנים "מוכן" ושומרים' };
  if (!subject.trim()) return { action: null, reason: 'חסר נושא למייל' };
  return { action: 'transfer' };
}
