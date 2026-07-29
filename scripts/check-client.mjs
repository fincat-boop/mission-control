import { readFile } from 'node:fs/promises';

/**
 * בדיקה סטטית קטנה ל-public/app.js.
 *
 * הקובץ בנוי סעיפים-סעיפים, ופעמיים כבר קרה ששכתוב של סעיף שלם מחק קבוע
 * שסעיף אחר עדיין השתמש בו. הדפדפן גילה את זה רק בלחיצה על טאב מסוים.
 * הבדיקה הזו תופסת את זה בלי דפדפן.
 *
 *   npm run check
 */
const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

const problems = [];

/* ---------- קבועים בכתיב UPPER_CASE שנעשה בהם שימוש ולא הוגדרו ---------- */
// async function foo — המילה async באה לפני, ובלעדיה הפונקציה נראית לא מוגדרת
const DECL = /^(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
const declared = new Set([...src.matchAll(DECL)].map((m) => m[1]));

// (?<!\.) — Date.UTC ודומיו הם גישה לתכונה, לא מזהה חופשי.
// טקסט בתוך <code> הוא מה שמוצג למשתמש (למשל שם משתנה סביבה) ולא קוד.
const scanned = src.replace(/<code>[\s\S]*?<\/code>/g, '');
const used = new Set(
  [...scanned.matchAll(/(?<![.\w])([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1])
);
// מילים ששייכות לשפה או למחרוזות ולא לקוד שלנו
const IGNORE = new Set(['JSON', 'GET', 'POST', 'PATCH', 'PUT', 'DELETE',
                        'UTF', 'MB', 'KB', 'URL', 'API', 'RTL', 'LTR', 'CSS', 'HTML', 'PDF', 'CSV', 'TSV', 'XLSX', 'AI']);

for (const name of used) {
  if (!declared.has(name) && !IGNORE.has(name) && !/^T\d/.test(name)) {
    problems.push(`קבוע בשימוש ולא מוגדר: ${name}`);
  }
}

/* ---------- הצהרות כפולות של אותו שם ברמה העליונה ---------- */
const counts = new Map();
for (const m of src.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
  counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
}
for (const [name, n] of counts) {
  if (n > 1) problems.push(`מוגדר ${n} פעמים ברמה העליונה: ${name}`);
}

/* ---------- שאריות של 'async' יתום אחרי הסרת פונקציה ---------- */
// לפי כללי ASI זה נקרא כשם משתנה, והערכת המודול נופלת שם בשקט
if (/^async\s*$/m.test(src)) {
  problems.push("נשארה שורת 'async' יתומה — הערכת המודול תיפול שם");
}

/* ---------- כל רנדרר שמוזכר ב-RENDERERS חייב להיות מוגדר ---------- */
const renderers = src.match(/const RENDERERS = \{([\s\S]*?)\};/);
if (renderers) {
  for (const m of renderers[1].matchAll(/=>\s*(\w+)\(/g)) {
    if (!declared.has(m[1])) problems.push(`רנדרר חסר: ${m[1]}`);
  }
}

if (problems.length) {
  console.error('נמצאו בעיות ב-public/app.js:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('public/app.js תקין: אין קבועים חסרים, כפילויות או שאריות async.');
