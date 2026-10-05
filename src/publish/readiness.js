/**
 * "מוכן" של גרסה — כללי התוכן בלבד, בלי DB ובלי חיבורים.
 *
 * מקור אחד לשני מקומות שחייבים להסכים: publishBlocker (runner.js) — מה
 * חוסם פרסום אוטומטי בפועל — וסימון "מוכן" בעריכת הגרסה (נתיבי התוכן,
 * הייבוא, והתא "מוכן ⚠" ברשת הקמפיין). אם הסימון מאשר מה שהפרסום ידחה,
 * הפוסט נכשל רק ביום הפרסום, כשכבר מאוחר.
 *
 * מה לא כאן (נשאר ב-publishBlocker): חיבור לערוץ, טוקן, מזהי עמוד, הגדרות
 * R2 בשרת — אלה מצב של המערכת, לא של התוכן שהמשתמש כתב.
 */

import { newsletterContentBlocker } from './newsletter.js';

const isMedia = (m) => /^(image|video)\//.test(m ?? '');


/**
 * מה חסר בתוכן של גרסה כדי שתצא בערוץ הזה? null = שום דבר.
 * @param {{platform:string, variant:{body?:string, meta?:object}|null,
 *          assets?:{mime:string}[]}} p assets — הקבצים שהגרסה תצא איתם
 *          (משותפים לזווית + של הגרסה, ובמשבצת מקושרת — של המקור)
 */
export function contentBlocker({ platform, variant, assets = [] }) {
  const v = variant ?? {};
  const text = String(v.body ?? '').trim();

  // ניוזלטר: כלל אחד עם ההעברה ל-HUB — נושא + (גוף או ערך שמולא בעורך ה-HUB)
  if (platform === 'newsletter') return newsletterContentBlocker(v);

  const media = assets.filter((a) => isMedia(a.mime));
  if (platform === 'instagram') {
    return media.length ? null : 'אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט';
  }
  if (!media.length && !text) return 'אין טקסט ואין מדיה — אין מה לפרסם';
  return null;
}

/** ההודעה למשתמש כשהסימון "מוכן" נדחה */
export const readyRejection = (reason) => `אי אפשר לסמן "מוכן": ${reason}`;
