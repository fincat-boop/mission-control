import { randomUUID } from 'node:crypto';
import { deleteObject, putObject, r2Ready } from '../r2.js';

/**
 * הגשה ציבורית זמנית של מדיה לצורך פרסום באינסטגרם — Graph API מושך
 * את הקובץ מ-URL ציבורי ולא מקבל העלאה ישירה במסלול הזה.
 *
 * הקבצים עולים ל-bucket ציבורי נפרד (לא ה-bucket של הגיבויים, שנשאר
 * פרטי!) תחת מפתח אקראי, ונמחקים מיד אחרי הפרסום.
 *
 * משתני סביבה:
 *   R2_PUBLIC_BUCKET    שם ה-bucket הציבורי
 *   R2_PUBLIC_BASE_URL  הכתובת הציבורית שלו (r2.dev או דומיין), בלי / בסוף
 */

export const publicAssetsReady = () =>
  r2Ready() && !!(process.env.R2_PUBLIC_BUCKET && process.env.R2_PUBLIC_BASE_URL);

/** מעלה קובץ ומחזיר {url, key}. ה-key נשמר כדי למחוק אחרי הפרסום. */
export async function uploadPublicAsset({ buffer, mime, filename }) {
  if (!publicAssetsReady()) {
    throw new Error('הגשת מדיה ציבורית לא מוגדרת — חסרים R2_PUBLIC_BUCKET / R2_PUBLIC_BASE_URL');
  }
  // סיומת מהשם המקורי, מפתח אקראי — לא מנחשים ולא מתנגשים
  const ext = (filename?.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '').toLowerCase();
  const key = `publish/${randomUUID()}${ext}`;
  await putObject(key, buffer, mime, process.env.R2_PUBLIC_BUCKET);
  const base = process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
  return { url: `${base}/${key}`, key };
}

/** ניקוי אחרי פרסום. fail-soft: קובץ שנשאר הוא זבל, לא תקלה. */
export async function deletePublicAssets(keys) {
  for (const key of keys) {
    await deleteObject(key, process.env.R2_PUBLIC_BUCKET)
      .catch((e) => console.error(`מחיקת קובץ ציבורי ${key} נכשלה:`, e.message));
  }
}
