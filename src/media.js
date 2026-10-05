import { randomUUID } from 'node:crypto';
import { deleteObject, headObject, listObjects, presignPut, putObject } from './r2.js';
import { publicAssetsReady } from './publish/public-assets.js';

/**
 * אחסון המדיה (תמונות/סרטונים/קבצים) ב-bucket ציבורי של Cloudflare R2.
 *
 * כל קובץ מקבל קישור ציבורי קבוע שאי אפשר לנחש (UUID במפתח) — מעתיקים
 * אותו לרשת חברתית או שולחים לעורך. ההעלאה עצמה ישירה מהדפדפן ל-R2
 * (presigned PUT), בלי לעבור בזיכרון של השרת.
 *
 * פריסת המפתחות: media/<org>/<uuid>/<שם-קובץ-בטוח>
 *               media/<org>/legacy-<asset id>/<שם>   (העברת bytea ישנים)
 *
 * ה-URL המלא לא נשמר במסד — רק המפתח (storage_key). הכתובת נגזרת בזמן
 * קריאה מ-R2_PUBLIC_BASE_URL, כדי שמעבר לדומיין מותאם לא ידרוש מיגרציה.
 *
 * משתני סביבה: R2_PUBLIC_BUCKET, R2_PUBLIC_BASE_URL (+ R2_* של החשבון),
 * MAX_MEDIA_MB (ברירת מחדל 1024).
 */

export const mediaReady = () => publicAssetsReady();

const envMb = Number(process.env.MAX_MEDIA_MB);
export const MAX_MEDIA_MB = Number.isFinite(envMb) && envMb > 0 ? envMb : 1024;
export const MAX_MEDIA_BYTES = Math.floor(MAX_MEDIA_MB * 1024 * 1024);

/** ימים שקובץ שנמחק נשאר ב-bucket לפני מחיקה סופית (חלון שחזור) */
export const TRASH_DAYS = 30;

/**
 * פעולות R2 שהמדיה נשענת עליהן — אובייקט ולא יבוא ישיר, כדי שטסטים
 * יחליפו אותן בלי רשת.
 */
export const mediaStore = {
  presignPut: (key) => presignPut(key, { bucket: process.env.R2_PUBLIC_BUCKET }),
  head: (key) => headObject(key, process.env.R2_PUBLIC_BUCKET),
  put: (key, body, mime) => putObject(key, body, mime, process.env.R2_PUBLIC_BUCKET),
  del: (key, bucket = process.env.R2_PUBLIC_BUCKET) => deleteObject(key, bucket),
  list: (prefix) => listObjects(prefix, '', { bucket: process.env.R2_PUBLIC_BUCKET }),
};

/** סוגי קבצים מותרים: תמונה, וידאו, אודיו, PDF */
export const isAllowedMime = (m) =>
  typeof m === 'string' &&
  (/^(image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/i.test(m) || m.toLowerCase() === 'application/pdf');

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

/** המפתח של קובץ ישן שהועבר מ-bytea — דטרמיניסטי, ולכן הרצה חוזרת לא משכפלת */
export const legacyMediaKey = (orgId, assetId, filename) =>
  `media/${Number(orgId)}/legacy-${Number(assetId)}/${safeFilename(filename)}`;

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
  if (!isAllowedMime(b.mime)) return 'סוג קובץ לא נתמך — רק תמונה, וידאו, אודיו או PDF';
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) return 'גודל הקובץ חסר או לא תקין';
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
  if (!isAllowedMime(mime)) {
    return { error: 'סוג קובץ לא נתמך — רק תמונה, וידאו, אודיו או PDF', status: 415, purge: true };
  }
  return null;
}

export const fmtLimit = (bytes) =>
  bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0
    ? `${bytes / 1024 ** 3}GB` : `${Math.round(bytes / 1048576)}MB`;

/** מה הלקוח צריך לדעת בעלייה — נשלח עם /api/me */
export const mediaConfig = () => ({ ready: mediaReady(), max_mb: MAX_MEDIA_MB });
