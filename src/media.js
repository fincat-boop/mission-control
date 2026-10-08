import { createHmac, randomUUID } from 'node:crypto';
import { copyObject, deleteObject, headObject, listObjects, presignPut, putObject } from './r2.js';
import { publicAssetsReady } from './publish/public-assets.js';

/**
 * אחסון המדיה (תמונות/סרטונים/קבצים) ב-bucket ציבורי של Cloudflare R2.
 *
 * כל קובץ מקבל קישור ציבורי קבוע שאי אפשר לנחש (UUID במפתח) — מעתיקים
 * אותו לרשת חברתית או שולחים לעורך. ההעלאה עצמה ישירה מהדפדפן ל-R2
 * (presigned PUT), בלי לעבור בזיכרון של השרת.
 *
 * פריסת המפתחות: media/<org>/<uuid>/<שם-קובץ-בטוח>
 *               media/<org>/legacy-<hmac>/<שם>   (העברת bytea ישנים)
 *
 * ה-URL המלא לא נשמר במסד — רק המפתח (storage_key). הכתובת נגזרת בזמן
 * קריאה מ-R2_PUBLIC_BASE_URL, כדי שמעבר לדומיין מותאם לא ידרוש מיגרציה.
 *
 * משתני סביבה: R2_PUBLIC_BUCKET, R2_PUBLIC_BASE_URL (+ R2_* של החשבון),
 * MAX_MEDIA_MB (ברירת מחדל 1024).
 */

export const mediaReady = () => publicAssetsReady();

// תקרה 2047MB: content_assets.size_bytes הוא int (עד 2^31-1 בייטים)
const envMb = Number(process.env.MAX_MEDIA_MB);
export const MAX_MEDIA_MB = Number.isFinite(envMb) && envMb > 0 ? Math.min(envMb, 2047) : 1024;
export const MAX_MEDIA_BYTES = Math.floor(MAX_MEDIA_MB * 1024 * 1024);

/** ימים שקובץ שנמחק נשאר ב-bucket לפני מחיקה סופית (חלון שחזור) */
export const TRASH_DAYS = 30;

/**
 * פעולות R2 שהמדיה נשענת עליהן — אובייקט ולא יבוא ישיר, כדי שטסטים
 * יחליפו אותן בלי רשת.
 */
/**
 * לחתום גם content-length בהעלאה (הגודל המוצהר) — כך R2 עצמו דוחה PUT בגודל
 * אחר, ולא רק ה-HEAD ב-complete. דפדפנים קובעים Content-Length לבד ובדיוק.
 * אם יתברר ש-R2 לא מקבל content-length חתום ב-presign — מכבים כאן (false),
 * וה-HEAD ב-complete נשאר האכיפה היחידה של הגודל.
 */
export const SIGN_CONTENT_LENGTH = true;

/** הכותרות שנחתמות ב-presigned PUT. content-type תמיד (מהרשימה הסגורה). */
export const uploadSignedHeaders = (mime, size) => ({
  'content-type': String(mime).toLowerCase(),
  ...(SIGN_CONTENT_LENGTH ? { 'content-length': String(Number(size)) } : {}),
});

export const mediaStore = {
  presignPut: (key, headers = {}) =>
    presignPut(key, { bucket: process.env.R2_PUBLIC_BUCKET, headers }),
  head: (key) => headObject(key, process.env.R2_PUBLIC_BUCKET),
  put: (key, body, mime) => putObject(key, body, mime, process.env.R2_PUBLIC_BUCKET),
  copy: (src, dst) => copyObject(src, dst, process.env.R2_PUBLIC_BUCKET),
  del: (key, bucket = process.env.R2_PUBLIC_BUCKET) => deleteObject(key, bucket),
  list: (prefix) => listObjects(prefix, '', { bucket: process.env.R2_PUBLIC_BUCKET }),
};

/**
 * סוגי הקבצים המותרים — רשימה סגורה, לא תבנית. ה-bucket מוגש מתת-דומיין של
 * backbone.co.il (media.backbone.co.il), ולכן שום דבר שהדפדפן עלול להריץ
 * לא עולה לשם: SVG, HTML, XML, JS ו-text/* נדחים. קובץ ישן מסוג אחר מועבר
 * כ-application/octet-stream (הורדה בלבד), ראו legacyUploadMime.
 */
export const ALLOWED_MIMES = Object.freeze([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v',
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const ALLOWED_SET = new Set(ALLOWED_MIMES);

/** בדיקה מדויקת (case-insensitive), בלי פרמטרים — "image/png; x=1" נדחה */
export const isAllowedMime = (m) => typeof m === 'string' && ALLOWED_SET.has(m.toLowerCase());

export const TYPE_ERROR = 'סוג קובץ לא נתמך — רק תמונות, סרטונים, אודיו, PDF ומסמכי Office';

/**
 * סוגים שמותר להגיש inline מהדומיין שלנו (GET /api/assets/:id, קובץ ישן
 * במסד): תמונה/וידאו/אודיו מהרשימה, ו-PDF. כל השאר — כולל text/html, JS
 * ו-SVG שנשמרו לפני שהרשימה נאכפה במסלול הישן — יורד כקובץ ולא נפתח בדף:
 * דף שנפתח מהדומיין שלנו רץ עם הקוקי של מי שפתח אותו.
 */
export const isInlineSafeMime = (m) => isAllowedMime(m) &&
  /^(image|video|audio)\/|^application\/pdf$/i.test(m);

/**
 * שם קובץ בטוח למפתח וגם ל-URL: בלי נתיב, בלי תווי בקרה ותווים מיוחדים,
 * רווחים הופכים למקף, אורך מוגבל, הסיומת נשמרת. עברית מותרת.
 */
export function safeFilename(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.split(/[/\\]/).pop();                       // רק השם, בלי נתיב
  const m = s.match(/\.([A-Za-z0-9]{1,10})$/);
  const ext = m ? `.${m[1].toLowerCase()}` : '';
  let base = m ? s.slice(0, -m[0].length) : s;
  base = base
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-')      // כל השאר (רווח, ?, #, %, בקרה) → מקף
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  base = [...base].slice(0, 80).join('').replace(/[-.]+$/, '');
  return `${base || 'file'}${ext}`;
}

export const newMediaKey = (orgId, filename) =>
  `media/${Number(orgId)}/${randomUUID()}/${safeFilename(filename)}`;

/**
 * המפתח של קובץ ישן שהועבר מ-bytea: media/<org>/legacy-<hmac>/<שם>.
 * דטרמיניסטי (הרצה חוזרת דורסת את אותו אובייקט, לא משכפלת), אבל אי אפשר
 * לנחש אותו בלי SESSION_SECRET — מזהה רץ (legacy-17) היה חושף את כל הקבצים
 * הישנים ב-bucket הציבורי. גם מונע התנגשות בין מסד מקומי לפרוד באותו bucket
 * (לכל סביבה סוד אחר).
 */
export function legacyMediaKey(orgId, assetId, filename, secret = process.env.SESSION_SECRET) {
  if (!secret) throw new Error('חסר SESSION_SECRET — נדרש למפתח של קובץ ישן');
  const tag = createHmac('sha256', secret)
    .update(`legacy:${Number(orgId)}:${Number(assetId)}`).digest('hex').slice(0, 32);
  return `media/${Number(orgId)}/legacy-${tag}/${safeFilename(filename)}`;
}

/** התחילית של כל המדיה של ארגון — לסריקת יתומים */
export const orgMediaPrefix = (orgId) => `media/${Number(orgId)}/`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * האם המפתח הונפק לארגון הזה במסלול ההעלאה (media/<org>/<uuid>/<שם>).
 * לא מקבל מפתחות legacy — אותם רק התחזוקה יוצרת.
 */
export function isOwnKey(orgId, key) {
  if (typeof key !== 'string' || key.length > 512) return false;
  const re = new RegExp(`^media/${Number(orgId)}/${UUID}/[^/]+$`);
  return re.test(key) && !key.split('/').some((p) => p === '..' || p === '.');
}

const publicBase = () => (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

/** הקישור הציבורי הקבוע של קובץ, או null אם הכתובת הציבורית לא מוגדרת */
export function mediaUrl(key) {
  const base = publicBase();
  if (!base || !key) return null;
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** שורת content_assets כפי שהיא יוצאת ב-API: url במקום storage_key */
export function assetView(a) {
  const { storage_key: key, data: _data, ...rest } = a;
  return { ...rest, url: key ? mediaUrl(key) : null };
}

/* ========================= ולידציה של מסלול ההעלאה ========================= */

/**
 * בקשת חתימה: {filename, mime, size}. מחזיר הודעת שגיאה, או null אם תקין.
 */
export function validateSignRequest(b, max = MAX_MEDIA_BYTES) {
  if (!b || typeof b !== 'object') return 'בקשה ריקה';
  if (typeof b.filename !== 'string' || !b.filename.trim()) return 'חסר שם קובץ';
  if (!isAllowedMime(b.mime)) return TYPE_ERROR;
  const size = Number(b.size);
  if (!Number.isInteger(size) || size <= 0) return 'גודל הקובץ חסר או לא תקין';
  if (size > max) return `הקובץ גדול מדי — עד ${fmtLimit(max)} לקובץ`;
  return null;
}

/**
 * תוצאת HEAD אחרי ההעלאה. מחזיר {error, status, purge} — purge=true כשאת
 * האובייקט שעלה צריך למחוק (חורג מהמגבלה / סוג אסור) — או null אם תקין.
 */
export function validateUploaded(head, max = MAX_MEDIA_BYTES) {
  if (!head) return { error: 'הקובץ לא נמצא באחסון — ההעלאה לא הושלמה', status: 409, purge: false };
  if (head.size > max) {
    return { error: `הקובץ גדול מדי — עד ${fmtLimit(max)} לקובץ`, status: 413, purge: true };
  }
  if (head.size <= 0) return { error: 'הקובץ שהועלה ריק', status: 400, purge: true };
  const mime = (head.contentType ?? '').split(';')[0].trim();
  if (!isAllowedMime(mime)) return { error: TYPE_ERROR, status: 415, purge: true };
  return null;
}

export const fmtLimit = (bytes) =>
  bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0
    ? `${bytes / 1024 ** 3}GB` : `${Math.round(bytes / 1048576)}MB`;

/** מה הלקוח צריך לדעת בעלייה — נשלח עם /api/me */
export const mediaConfig = () => ({
  ready: mediaReady(), max_mb: MAX_MEDIA_MB, allowed_mimes: ALLOWED_MIMES,
});

/**
 * בדיקת אובייקט שהדפדפן העלה: HEAD (הגודל והסוג האמיתיים, לא מה שהלקוח
 * הצהיר), ומחיקה מיידית של מה שחורג מהמגבלה או מסוג אסור. presigned PUT
 * לא אוכף גודל — האכיפה כאן, ואובייקט שאף אחד לא השלים נאסף בסריקת היתומים.
 * @returns {Promise<{head?:{size:number, contentType:string|null}, problem?:{error:string, status:number}}>}
 */
export async function verifyUploaded(key, { store = mediaStore, max = MAX_MEDIA_BYTES } = {}) {
  const head = await store.head(key);
  const problem = validateUploaded(head, max);
  if (!problem) return { head };
  if (problem.purge) {
    await store.del(key).catch((e) =>
      console.error(`מחיקת העלאה פסולה ${key} נכשלה (תיאסף בסריקת היתומים):`, e.message));
  }
  return { problem: { error: problem.error, status: problem.status } };
}

/** הסוג כפי ש-R2 שמר אותו, בלי פרמטרים (charset וכו') */
export const headMime = (head) =>
  (head?.contentType ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';

/**
 * מחיקה סופית מהסל וסריקת יתומים — רק בפרודקשן (או MEDIA_SWEEP=1 במפורש).
 * שרת מקומי שמחובר בטעות ל-bucket של פרוד רואה מסד אחר, ולכן כל אובייקט
 * של פרוד נראה לו "יתום" — בלי השער הזה הוא היה שולח אותם לסל ומוחק.
 */
export const mediaSweepEnabled = (env = process.env) =>
  env.NODE_ENV === 'production' || env.MEDIA_SWEEP === '1';

/** שעות שאובייקט בלי שורה צריך לחכות לפני שהוא נחשב יתום (העלאה באמצע) */
export const ORPHAN_GRACE_HOURS = 24;

/**
 * יתומים: אובייקטים ישנים מ-ORPHAN_GRACE_HOURS שאף שורה לא מצביעה עליהם
 * ושעוד לא בסל המחזור. known = מפתחות שמוכרים (שורות + סל).
 */
export function pickOrphans(objects, known, now = new Date()) {
  const cutoff = now.getTime() - ORPHAN_GRACE_HOURS * 3600000;
  return objects
    .filter((o) => o.lastModified && o.lastModified.getTime() < cutoff && !known.has(o.key))
    .map((o) => o.key);
}

/** הסוג שבו קובץ ישן עולה ל-bucket הציבורי: סוג לא מותר יוגש כהורדה בלבד */
export const legacyUploadMime = (mime) =>
  (isAllowedMime(mime) ? mime : 'application/octet-stream');
