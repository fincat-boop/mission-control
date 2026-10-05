// נטען ראשון בכל קובץ טסט, לפני ייבוא מודולים של src, כדי ש-db.js ו-auth.js
// לא יזרקו על משתני סביבה חסרים. ה-Pool נוצר עצל ולא מתחבר עד query ראשון,
// ולכן טסטים על פונקציות טהורות לא נוגעים ב-DB אמיתי.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-secret-at-least-16-chars-long';
// הלוח, המנוע והמבצע הדחוף עובדים בשעון ישראל (Railway: TZ=Asia/Jerusalem).
// ברירת מחדל לטסטים, אם לא הוגדר אחר. הטסטים של שעות עגולות בונים תאריכים
// בזמן מקומי, ולכן עוברים גם עם TZ=UTC npm test.
process.env.TZ ??= 'Asia/Jerusalem';
