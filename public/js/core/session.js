import { $, toast } from './dom.js';
import { state } from './state.js';

/**
 * חיבור שפג באמצע עבודה.
 *
 * עד עכשיו כל 401 העביר מיד לדף הכניסה — וכל מה שהיה פתוח (טופס, טקסט
 * באמצע כתיבה) הלך לאיבוד. במקום זה: חלון שנשאר מעל הכול, התחברות בלשונית
 * חדשה, ובחזרה לכאן בדיקה של /api/me. רק כשהיא מצליחה החלון נסגר — והפעולה
 * שנכשלה כבר הציגה הודעה שצריך לחזור עליה.
 *
 * שכבה 0: נשען על dom ו-state בלבד, ו-api.js קורא לו.
 */

/** דף הכניסה, עם חזרה לתצוגה הנוכחית אחרי ההתחברות (השרת מאמת את next) */
export const loginUrl = () =>
  `/login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

let wired = false;
let checking = false;

/** האם יש שוב חיבור. רשת שנפלה = עדיין לא, בלי לזרוק. */
async function stillOut() {
  try {
    const res = await fetch('/api/me');
    const { user } = await res.json();
    if (!user) return true;
    // התחברו בלשונית החדשה כמשתמש אחר — המסך הזה שייך למישהו אחר
    if (state.me && user.id !== state.me.id) {
      location.reload();
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

let explain = false; // לחיצה על "נסה שוב" בזמן בדיקה שקטה — ההסבר יוצג בסופה

async function check({ quiet = false } = {}) {
  const dlg = $('#authDlg');
  if (!quiet) explain = true;
  // הלחיצה עצמה מחזירה פוקוס לחלון — בדיקה שקטה כבר רצה, והיא תענה לשתיהן
  if (!dlg.open || checking) return;
  checking = true;
  try {
    if (await stillOut()) {
      if (explain) $('#authMsg').textContent = 'עדיין לא מחוברים. מתחברים בלשונית שנפתחה ואז לוחצים "נסה שוב".';
      return;
    }
    dlg.close();
    toast('מחוברים שוב. מה שנכשל קודם — חוזרים עליו עכשיו.');
  } finally {
    checking = false;
    explain = false;
  }
}

function wire(dlg) {
  if (wired) return;
  wired = true;
  // Esc לא סוגר: בלי חיבור כל פעולה תיכשל שוב
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  $('#authLogin').addEventListener('click', () => {
    window.open(loginUrl(), '_blank', 'noopener');
    $('#authMsg').textContent = 'אחרי ההתחברות חוזרים ללשונית הזו — החלון ייסגר לבד.';
  });
  $('#authRetry').addEventListener('click', () => check());
  // חוזרים מהלשונית של ההתחברות — בודקים לבד
  window.addEventListener('focus', () => check({ quiet: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check({ quiet: true });
  });
}

/** נקרא על כל 401. פותח את החלון פעם אחת, גם כשכמה בקשות נכשלות יחד. */
export function sessionExpired() {
  const dlg = $('#authDlg');
  // לפני שהממשק עלה (או דף בלי החלון) — אין עבודה לשמור, ישר לכניסה
  if (!dlg || !state.me) {
    location.href = loginUrl();
    return;
  }
  wire(dlg);
  if (dlg.open) return;
  $('#authMsg').textContent = '';
  dlg.showModal();
}
