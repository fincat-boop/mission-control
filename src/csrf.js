/**
 * הגנת CSRF מבוססת Origin.
 *
 * בקשה משנת-מצב (POST/PUT/PATCH/DELETE) שמגיעה עם כותרת Origin חייבת שהיא
 * תתאים למארח של האפליקציה. דפדפנים שולחים Origin בכל בקשה חוצת-אתר משנת-מצב,
 * ולכן טופס זדוני מאתר אחר ייחסם — גם אם קוקי ההתחברות נשלח.
 *
 * בקשה בלי Origin עוברת: זה המצב של קריאות שרת-לשרת (למשל ביצוע הצעה שאושרה
 * דרך 127.0.0.1 ב-assistant.js), והן לא נובעות מדפדפן ולכן אינן וקטור CSRF.
 * זו שכבה שנייה מעבר ל-sameSite של הקוקי.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // לא-דפדפן — לא וקטור CSRF

  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'מקור הבקשה לא תקין' });
  }

  const expected = req.headers['x-forwarded-host'] || req.headers.host;
  if (host !== expected) {
    return res.status(403).json({ error: 'בקשה חוצת-מקור נחסמה' });
  }
  next();
}
