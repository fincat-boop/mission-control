/**
 * ערוץ המייל של הלוח — קליינט דק ל-API של HUB (חתול פיננסי).
 *
 * העיקרון: למרכז-הבקרה אין צינור מייל משלו, בכוונה. ניוזלטר שמשובץ בלוח
 * נשלח דרך HUB, ששם חיים חוק הספאם ("פרסומת" בנושא, פוטר, הסרה),
 * ה-suppressions, מכסת Resend והמוניטין של דומיין השליחה. כאן רק מבקשים —
 * HUB מחליט אם לשלוח (הוא רשאי לסרב: preflight חוסם, מכסה, kill switch).
 *
 * idempotency: כל קריאה נושאת external_ref (מזהה הפוסט אצלנו). retry של
 * אותה קריאה מחזיר את הקמפיין הקיים — HUB לעולם לא ישלח פעמיים על אותו ref.
 *
 * משתני סביבה:
 *   HUB_API_URL — בסיס ה-HUB (למשל https://app.yourdomain.com), בלי / בסוף.
 *   HUB_API_KEY — Bearer; זהה ל-MISSION_CONTROL_API_KEY שמוגדר ב-HUB.
 * אם חסרים — hubMailReady() מחזיר false והערוץ פשוט לא זמין, כלום לא נשבר.
 */

export const hubMailReady = () => !!(process.env.HUB_API_URL && process.env.HUB_API_KEY);

const base = () => String(process.env.HUB_API_URL ?? '').replace(/\/+$/, '');

/** שגיאה עם message ידידותי מה-HUB (הוא מחזיר {error} בעברית) + סטטוס. */
export class HubMailError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubMailError';
    this.status = status;
  }
}

async function call(method, path, body, fetchImpl = fetch) {
  if (!hubMailReady()) throw new HubMailError('חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY)', 503);
  let res;
  try {
    res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.HUB_API_KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new HubMailError(`ה-HUB לא זמין: ${e.message}`, 502);
  }
  let data = null;
  try { data = await res.json(); } catch { /* גוף לא-JSON — נטופל לפי הסטטוס */ }
  if (!res.ok || data?.ok === false) {
    throw new HubMailError(data?.error || `שגיאת HUB (${res.status})`, res.status);
  }
  return data;
}

/**
 * יצירת/תזמון ניוזלטר ב-HUB.
 * fieldValues — מילוי שדות התבנית מהטופס בלוח ({שם שדה: ערך}); גובר על
 * המילוי האוטומטי של ה-HUB (תוכן/כותרת/תאריך).
 * @param {{externalRef:string, subject:string, htmlBody:string, listIds?:string[],
 *          segmentIds?:string[], name?:string, scheduledAt?:string|Date,
 *          fieldValues?:Record<string,string>}} input
 * @returns {Promise<{campaign_id:string, status:string, recipient_count?:number,
 *                    scheduled_at:string, idempotent?:boolean}>}
 */
export async function createNewsletter(input, fetchImpl = fetch) {
  const { externalRef, subject, htmlBody, listIds = [], segmentIds = [], name, scheduledAt, fieldValues } = input;
  if (!externalRef) throw new HubMailError('externalRef חסר — מזהה הפוסט שלנו', 400);
  return call('POST', '/api/v1/mission-control/newsletters', {
    external_ref: String(externalRef),
    subject,
    html_body: htmlBody,
    list_ids: listIds,
    segment_ids: segmentIds,
    ...(name ? { name } : {}),
    ...(scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
    ...(fieldValues && Object.keys(fieldValues).length ? { field_values: fieldValues } : {}),
  }, fetchImpl);
}

/**
 * תיאור תבנית הניוזלטר שמוגדרת ב-HUB — מזין את טופס המילוי בלוח.
 * template=null: לא הוגדרה תבנית, מציגים רק נושא+תוכן.
 * @returns {Promise<{id:string, name:string,
 *   fields:Array<{name:string, label?:string, multiline:boolean, max?:number}>} | null>}
 */
export const newsletterTemplate = async (fetchImpl = fetch) =>
  (await call('GET', '/api/v1/mission-control/newsletter-template', null, fetchImpl)).template;

/**
 * תצוגה מקדימה — ה-HUB מרנדר את מה שהנמען יראה (תבנית, מותג, פוטר,
 * ערכי דוגמה). הלוח רק מציג את ה-HTML שחוזר (iframe srcdoc).
 * @param {{subject:string, htmlBody:string, name?:string, scheduledAt?:string|Date,
 *          fieldValues?:Record<string,string>}} input
 * @returns {Promise<{subject:string, html:string, unsafe_vars:string[]}>}
 */
export async function newsletterPreview(input, fetchImpl = fetch) {
  const { subject, htmlBody, name, scheduledAt, fieldValues } = input;
  return call('POST', '/api/v1/mission-control/newsletter-preview', {
    subject,
    html_body: htmlBody,
    ...(name ? { name } : {}),
    ...(scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
    ...(fieldValues && Object.keys(fieldValues).length ? { field_values: fieldValues } : {}),
  }, fetchImpl);
}

/**
 * סטטוס ניוזלטר — לפי campaign_id או external_ref.
 * @returns {Promise<{campaign_id:string, status:string, scheduled_at:string,
 *                    counts:{recipients:number, delivered:number, opened:number,
 *                            clicked:number, bounced:number, complained:number}}>}
 */
export const newsletterStatus = (idOrRef, fetchImpl = fetch) =>
  call('GET', `/api/v1/mission-control/newsletters/${encodeURIComponent(idOrRef)}`, null, fetchImpl);

/** רשימות הקהל ב-HUB — לבורר בממשק. @returns {Promise<Array<{id:string,name:string}>>} */
export const audienceLists = async (fetchImpl = fetch) =>
  (await call('GET', '/api/v1/mission-control/lists', null, fetchImpl)).lists;
