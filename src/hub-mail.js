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
 *   HUB_APP_URL — (רשות) כתובת הדשבורד של ה-HUB, כשהיא שונה מ-HUB_API_URL
 *                 (למשל API ב-app.backbone.co.il והדשבורד ב-backbone.co.il).
 *                 ממנה נפתחים עורך המייל ומסך האישור, והיא המקור היחיד
 *                 שהלוח מקבל ממנו הודעות של העורך. בלי — HUB_API_URL.
 * אם חסרים — hubMailReady() מחזיר false והערוץ פשוט לא זמין, כלום לא נשבר.
 */

export const hubMailReady = () => !!(process.env.HUB_API_URL && process.env.HUB_API_KEY);

const base = () => String(process.env.HUB_API_URL ?? '').replace(/\/+$/, '');

/** בסיס הדשבורד של ה-HUB (HUB_APP_URL, אחרת HUB_API_URL), בלי / בסוף; '' כשלא מוגדר */
export const hubAppBase = (env = process.env) =>
  String(env.HUB_APP_URL || env.HUB_API_URL || '').trim().replace(/\/+$/, '');

/** עורך המייל של ה-HUB לבקרת שיגור (מילוי התבנית, חוזר ללוח ב-postMessage) */
export const hubFillUrl = (env = process.env) =>
  (hubAppBase(env) ? `${hubAppBase(env)}/dashboard/mission-control/fill` : null);

/** מסך העריכה והאישור של קמפיין ב-HUB */
export const hubCampaignUrl = (campaignId, env = process.env) =>
  (hubAppBase(env) && campaignId
    ? `${hubAppBase(env)}/dashboard/campaigns/${encodeURIComponent(campaignId)}/edit` : null);

/**
 * המקורות (origin) שהלוח מקבל מהם הודעות של עורך המייל: הדשבורד, ובנוסף
 * כתובת ה-API — אם הדשבורד לא הוגדר בנפרד וה-HUB מפנה את הדף לכתובת אחרת,
 * ההודעה תגיע מהיעד; מה שלא ברשימה נזרק בצד הלקוח.
 */
export function hubOrigins(env = process.env) {
  const out = new Set();
  for (const u of [env.HUB_APP_URL, env.HUB_API_URL]) {
    try { if (u?.trim()) out.add(new URL(u.trim()).origin); } catch { /* כתובת לא תקינה — מדלגים */ }
  }
  return [...out];
}

/** שגיאה עם message ידידותי מה-HUB (הוא מחזיר {error} בעברית) + סטטוס. */
export class HubMailError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubMailError';
    this.status = status;
  }
}

/**
 * מדיניות ניסיון חוזר — רק לקריאות idempotent (יצירת ניוזלטר לפי external_ref,
 * שאילתת סטטוס): עד שני ניסיונות נוספים, בהפסקה קצרה, ורק על תקלה זמנית —
 * רשת נפלה או 5xx. סירוב של ה-HUB (4xx) או הגדרה חסרה לא חוזרים.
 */
export const RETRY_DELAYS_MS = [1000, 3000];

export const isTransientHubError = (e) => e instanceof HubMailError && e.retryable === true;

const realSleep = (ms) => new Promise((res) => setTimeout(res, ms));

export async function withRetry(fn, { delays = RETRY_DELAYS_MS, sleep = realSleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientHubError(e) || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}

export const HUB_TIMEOUT_MS = 15000;

const isAbort = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
const unreachable = (e) => Object.assign(
  new HubMailError(isAbort(e) ? `ה-HUB לא זמין: לא ענה תוך ${HUB_TIMEOUT_MS / 1000} שניות`
                              : `ה-HUB לא זמין: ${e.message}`, 502),
  { retryable: true });

async function call(method, path, body, fetchImpl = fetch) {
  if (!hubMailReady()) throw new HubMailError('חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY)', 503);
  let res;
  try {
    // בלי תקרת זמן, HUB תקוע היה מחזיק את טיק הפרסום (והטרנזקציה שלו) לנצח
    res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${(process.env.HUB_API_KEY ?? '').trim()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  } catch (e) {
    throw unreachable(e);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // הגוף נקטע בזמן הקריאה — תקלה זמנית, לא "תשובה ריקה"
    if (isAbort(e)) throw unreachable(e);
    /* גוף לא-JSON — נטופל לפי הסטטוס */
  }
  if (!res.ok || data?.ok === false) {
    // answered — ה-HUB עצמו ענה (JSON עם ok:false), לא דף שגיאה של פרוקסי/נתיב
    // שגוי. 404 "קמפיין לא נמצא" אמיתי נבדל כך מתקלת ניתוב.
    throw Object.assign(new HubMailError(data?.error || `שגיאת HUB (${res.status})`, res.status),
      { retryable: res.status >= 500, answered: data?.ok === false });
  }
  return data;
}

/**
 * יצירת/תזמון ניוזלטר ב-HUB.
 * fieldValues — מילוי שדות התבנית מהטופס בלוח ({שם שדה: ערך}); גובר על
 * המילוי האוטומטי של ה-HUB (תוכן/כותרת/תאריך).
 * ה-HUB יוצר תמיד **טיוטה שממתינה לאישור** (status "draft",
 * requires_approval) — בעל העסק מאשר במסך העריכה שם (hubCampaignUrl).
 * scheduledAt נשמר שם כזמן המוצע; templateId — התבנית שהערכים מולאו מולה.
 * @param {{externalRef:string, subject:string, htmlBody:string, listIds?:string[],
 *          segmentIds?:string[], name?:string, scheduledAt?:string|Date,
 *          templateId?:string, fieldValues?:Record<string,string>}} input
 * retry: תקלה זמנית (רשת/5xx) — עד שני ניסיונות נוספים; בטוח בזכות external_ref.
 * @returns {Promise<{campaign_id:string, status:string, recipient_count?:number,
 *                    scheduled_at:string, idempotent?:boolean, requires_approval?:boolean}>}
 */
export async function createNewsletter(input, fetchImpl = fetch, retry = {}) {
  const { externalRef, subject, htmlBody, listIds = [], segmentIds = [], name, scheduledAt,
          templateId, fieldValues } = input;
  if (!externalRef) throw new HubMailError('externalRef חסר — מזהה הפוסט שלנו', 400);
  return withRetry(() => call('POST', '/api/v1/mission-control/newsletters', {
    external_ref: String(externalRef),
    subject,
    html_body: htmlBody,
    list_ids: listIds,
    segment_ids: segmentIds,
    ...(name ? { name } : {}),
    ...(scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
    ...(templateId ? { template_id: String(templateId) } : {}),
    ...(fieldValues && Object.keys(fieldValues).length ? { field_values: fieldValues } : {}),
  }, fetchImpl), retry);
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
 *          templateId?:string, fieldValues?:Record<string,string>}} input
 * @returns {Promise<{subject:string, html:string, unsafe_vars:string[]}>}
 */
export async function newsletterPreview(input, fetchImpl = fetch) {
  const { subject, htmlBody, name, scheduledAt, templateId, fieldValues } = input;
  const when = scheduledAt ? new Date(scheduledAt) : null;
  return call('POST', '/api/v1/mission-control/newsletter-preview', {
    subject,
    html_body: htmlBody,
    ...(name ? { name } : {}),
    ...(when && !Number.isNaN(when.getTime()) ? { scheduled_at: when.toISOString() } : {}),
    ...(templateId ? { template_id: String(templateId) } : {}),
    ...(fieldValues && Object.keys(fieldValues).length ? { field_values: fieldValues } : {}),
  }, fetchImpl);
}

/**
 * סטטוס ניוזלטר — לפי campaign_id או external_ref.
 * @returns {Promise<{campaign_id:string, status:string, scheduled_at:string,
 *                    counts:{recipients:number, delivered:number, opened:number,
 *                            clicked:number, bounced:number, complained:number}}>}
 */
export const newsletterStatus = (idOrRef, fetchImpl = fetch, retry = {}) =>
  withRetry(() => call('GET', `/api/v1/mission-control/newsletters/${encodeURIComponent(idOrRef)}`,
    null, fetchImpl), retry);

/** רשימות הקהל ב-HUB — לבורר בממשק. @returns {Promise<Array<{id:string,name:string}>>} */
export const audienceLists = async (fetchImpl = fetch) =>
  (await call('GET', '/api/v1/mission-control/lists', null, fetchImpl)).lists;
