/**
 * מתאם הרענון.
 *
 * הבעיה שהוא פותר: כמעט כל פעולה במערכת צריכה לרענן את הלוח אחריה —
 * מחיקת פוסט, הזזת קמפיין, שינוי כלל בניהול, סימון משימה. אם כל מודול
 * מייבא את הלוח ישירות בשביל זה, נוצרים מעגלים: הלוח פותח את דיאלוג
 * הפוסט, והדיאלוג מרענן את הלוח. וכך גם מול הוספת פוסט ידנית ומול המנוע.
 *
 * הפתרון הוא היפוך תלות: אף מודול לא מייבא רנדרר של מודול אחר. כולם
 * קוראים לפעולת רענון מכאן, והרנדררים האמיתיים נרשמים פעם אחת בעלייה
 * (registerRefreshers ב-app.js). התלות הופכת מ"פיצ'ר -> פיצ'ר" ל-
 * "פיצ'ר -> תשתית", והמעגלים נעלמים.
 *
 * שכבה 1 — מייבא כלום, ולכן בטוח לייבוא מכל מקום.
 */

const reg = {};

/**
 * נקרא פעם אחת בזמן העלייה, לפני הרינדור הראשון.
 * @param {Record<string, () => Promise<void>|void>} map
 */
export function registerRefreshers(map) {
  Object.assign(reg, map);
}

/**
 * קריאה לרנדרר שלא נרשם היא באג בסדר האתחול, לא מצב לגיטימי — עדיף
 * להיכשל ברור מאשר לרענן בשקט כלום ולהשאיר מסך ישן.
 */
function call(name) {
  const fn = reg[name];
  if (!fn) throw new Error(`רנדרר "${name}" לא נרשם במתאם הרענון`);
  return fn();
}

export const refreshBoard = () => call('board');
export const refreshPlan = () => call('plan');
export const refreshStrategy = () => call('strategy');
export const refreshManage = () => call('manage');
export const refreshData = () => call('data');
export const refreshTasks = () => call('tasks');
export const refreshTaskBadge = () => call('taskBadge');
export const refreshAlerts = () => call('alerts');

/** מרענן את הטאב שמוצג כרגע, יהיה אשר יהיה */
export const refreshCurrentTab = () => call('currentTab');

/**
 * מה שצריך לרענן אחרי שינוי בשיבוץ: הלוח עצמו, מונה המשימות (שיבוץ
 * יכול ליצור או לסגור משימה) ומונה ההתראות. הצירוף הזה חזר במילה במילה
 * בחמישה מקומות, ועדיף שם אחד מאשר חמש רשימות שאפשר לשכוח לעדכן.
 */
export const refreshAfterPostChange = () =>
  Promise.all([call('board'), call('taskBadge'), call('alerts')]);
