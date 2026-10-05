/**
 * לאן לחזור אחרי התחברות (?next=). מגיע מהדפדפן, ולכן כל ערך שאינו נתיב
 * יחסי באותו אתר נדחה — אחרת זו הפניה פתוחה: קישור התחברות אמיתי שמנחית
 * את המשתמש באתר זר.
 *
 * מותר: נתיב שמתחיל ב-"/" (לא "//" ולא "/\"), בלי לוכסן הפוך, בלי תווי
 * בקרה, שנפתר לאותו מקור. לא לנתיבי /api ולא בחזרה לדף הכניסה.
 * @returns {string|null} הנתיב המנורמל (נתיב + query + hash), או null
 */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // דפדפנים מתייחסים ל-"\" כמו "/" — "/\evil.com" הוא "//evil.com"
  if (value.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex -- זה בדיוק מה שנבדק
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  const base = 'http://next.invalid';
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== base) return null;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/login' || url.pathname.startsWith('/login.')) return null;
  const out = `${url.pathname}${url.search}${url.hash}`;
  // הנרמול מקפל קטעי נקודה ("/.//x", "/a/..//x", "/%2e//x") — והתוצאה עלולה
  // להפוך ל-"//x", שהדפדפן קורא כאתר אחר. הבדיקות חוזרות על מה שיוצא בפועל.
  if (!out.startsWith('/') || out.startsWith('//') || out.includes('\\')) return null;
  return out;
}
