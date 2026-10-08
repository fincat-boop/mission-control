/**
 * כותרת אוטומטית לתוכן (סעיף 23, החלטה ה3). שכבה 0: פונקציות טהורות בלבד —
 * משותפות לדפדפן (חלון המשבצת, עורך הגרסאות, הייבוא) ולשרת (POST/PATCH
 * /content, src/import.js), כמו socialRules.js. נבדקות ב-test/title.test.js.
 *
 * הכותרת היא שם פנימי לזיהוי הפוסט בטבלה ובלוח — לא חלק ממה שמתפרסם. ולכן
 * היא לא חוסמת שמירה: כשאין כותרת ויש תוכן, היא נגזרת ממנו.
 */

/** אורך מקסימלי לכותרת שנגזרת מהטקסט */
export const TITLE_MAX = 60;

/**
 * השורה הראשונה שיש בה טקסט, מקוצרת: עד max תווים, נחתכת בגבול מילה עם "…".
 * מילה אחת ארוכה מאוד (קישור) — נחתכת באמצע.
 */
export function firstLineTitle(text, max = TITLE_MAX) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean) ?? '';
  // לפי תווים (code points), לא יחידות UTF-16 — אמוג'י לא נחתך לחצי
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** שם קובץ בלי סיומת, עם רווחים במקום _ ו־- (כמו בהעלאה המרוכזת) */
export const fileTitle = (name) =>
  String(name ?? '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "<ערוץ> · פוסט N" — משבצת בקמפיין כללי שאין ממה לגזור לה שם */
export const slotTitle = (channelName, index) =>
  [channelName, index ? `פוסט ${index}` : ''].filter(Boolean).join(' · ');

/**
 * הכותרת שנגזרת מהתוכן: השורה הראשונה של הטקסט, אחרת שם הקובץ הראשון בלי
 * סיומת, אחרת "<ערוץ> · פוסט N". בלי טקסט ובלי קבצים — '' (אין ממה לגזור,
 * ופוסט ריק לא נוצר).
 * @param {{body?:string, files?:string[], channelName?:string, index?:number}} src
 *        files — שמות הקבצים (קיימים + שנבחרו)
 */
export function deriveTitle({ body = '', files = [], channelName = '', index = null } = {}) {
  const fromText = firstLineTitle(body);
  if (fromText) return fromText;
  const names = (files ?? []).filter((f) => f != null);
  const fromFile = names.map(fileTitle).find(Boolean);
  if (fromFile) return fromFile.length > TITLE_MAX ? firstLineTitle(fromFile) : fromFile;
  if (names.length) return slotTitle(channelName, index) || 'פוסט';
  return '';
}

/**
 * האם כותרת שמורה היא הכותרת שנגזרה מהתוכן (ולא כותרת שמישהו הקליד). טופס
 * שנפתח עם כותרת כזו מציג אותה כ-placeholder וממשיך לגזור אותה מהטקסט —
 * כותרת שהמשתמש הקליד לעולם לא נדרסת.
 */
export function isDerivedTitle(title, src) {
  const t = String(title ?? '').trim();
  return !!t && t === deriveTitle(src);
}
