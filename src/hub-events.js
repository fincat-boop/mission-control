/**
 * אירועים יוצאים ל-HUB — כל מה שקורה כאן ושה-HUB (והאוטומציות שלו) צריך
 * לדעת עליו: פוסט פורסם, משימה הושלמה, קמפיין התחיל.
 *
 * אותם משתני סביבה כמו hub-mail.js (HUB_API_URL, HUB_API_KEY) — כיוון אחד,
 * סוד אחד. האירוע נרשם ב-HUB כ-mission_control.<type> ומפעיל אוטומציות אם
 * צורף email של איש קשר מוכר שם.
 *
 * idempotency: id ייחודי לכל אירוע (אצלנו: "<type>:<מזהה הישות>"). retry עם
 * אותו id לא נרשם פעמיים — לכן תמיד בטוח לקרוא שוב אחרי כשל רשת.
 *
 * שימוש בזרימות לוח: emitHubEventSafe — לא זורק לעולם. פרסום פוסט לא ייכשל
 * בגלל שה-HUB רגע לא זמין; הכשל נרשם ללוג וזהו.
 */

export const hubEventsReady = () => !!(process.env.HUB_API_URL && process.env.HUB_API_KEY);

const base = () => String(process.env.HUB_API_URL ?? '').replace(/\/+$/, '');

/**
 * כמה מחכים ל-HUB לכל היותר. אירוע נשלח גם מטיק הפרסום — HUB שנתקע בלי
 * לענות לא יעכב את שאר הפוסטים (וגם לא יחזיק בקשה פתוחה).
 */
export const HUB_EVENT_TIMEOUT_MS = 10000;

/**
 * שולח אירוע. זורק על כשל — לזרימות שבהן הקורא רוצה לדעת.
 * @param {{id:string, type:string, occurredAt?:string|Date, email?:string,
 *          data?:Record<string,unknown>}} input
 * @returns {Promise<{recorded:boolean, dispatched:boolean}>}
 */
export async function emitHubEvent(input, fetchImpl = fetch) {
  const { id, type, occurredAt, email, data } = input;
  if (!id || !type) throw new Error('אירוע ל-HUB חייב id ו-type');
  if (!hubEventsReady()) throw new Error('חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY)');

  const res = await fetchImpl(`${base()}/api/v1/mission-control/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(process.env.HUB_API_KEY ?? '').trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: String(id),
      type: String(type),
      occurred_at: new Date(occurredAt ?? Date.now()).toISOString(),
      ...(email ? { email: String(email) } : {}),
      ...(data ? { data } : {}),
    }),
    signal: AbortSignal.timeout(HUB_EVENT_TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch { /* לא-JSON — נטופל לפי הסטטוס */ }
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `שגיאת HUB (${res.status})`);
  }
  return { recorded: !!body?.recorded, dispatched: !!body?.dispatched };
}

/**
 * האירוע על גורל פוסט (טהורה — נבדקת בטסטים).
 * id: "<type>:<post id>" — כך retry של אותו אירוע לא נרשם פעמיים. כשל
 * פרסום מקבל גם attempt (מזהה שורת publish_log): כשל שני של אותו פוסט
 * הוא אירוע חדש, לא כפילות — אחרת ה-HUB היה מתעלם ממנו בשקט.
 * email: המייל של בעלי הארגון — אוטומציה ב-HUB נדלקת רק כשמצורף מייל
 * של איש קשר מוכר שם (למשל: לשלוח לבעלים מייל על כשל).
 */
export function postEventInput(type, post, { attempt = null, email = null, extra = {} } = {}) {
  return {
    id: attempt == null ? `${type}:${post.id}` : `${type}:${post.id}:${attempt}`,
    type,
    ...(email ? { email } : {}),
    data: {
      post_id: post.id, title: post.title, channel: post.channel_name,
      platform: post.platform, kind: post.kind, ...extra,
    },
  };
}

/**
 * גרסת fire-and-forget לזרימות לוח: כשל = console.error, לא זריקה.
 * מחזיר את התוצאה או null בכשל.
 */
export async function emitHubEventSafe(input, fetchImpl = fetch) {
  if (!hubEventsReady()) return null; // לא מוגדר — שקט לגמרי, כמו הגיבויים
  try {
    return await emitHubEvent(input, fetchImpl);
  } catch (e) {
    console.error(`שליחת אירוע ${input?.type} ל-HUB נכשלה:`, e.message);
    return null;
  }
}
