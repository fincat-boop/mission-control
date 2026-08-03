/**
 * המצב המשותף של הלקוח, וצבע נקודות הקצה שנגזר ממנו.
 * שכבה 0 — כל מודול קורא וכותב לאותו אובייקט state.
 */

export const TABS = ['board', 'strategy', 'plan', 'tasks', 'data', 'manage'];

export const state = {
  me: null,
  week: null,          // תאריך עוגן לשבוע המוצג
  channels: [],
  endpoints: [],
  users: [],
  campaigns: [],
  planEndpoint: null,      // נקודת הקצה שנבחרה בדרילדאון
  planCampaign: null,      // הקמפיין שנבחר בתוכה
  planBackground: false,   // האם מציגים את התוכן השוטף של הנקודה
  dataPeriod: '30',        // התקופה בטאב הנתונים: מספר ימים או 'custom'
  dataFrom: null,
  dataTo: null,
  dataVia: '',             // סינון היומן לפי מקור הפעולה
  tab: 'board',
};

export const can = (perm) => !!state.me && (state.me.is_owner || state.me[`perm_${perm}`]);

/**
 * צבע לכל נקודת קצה.
 *
 * לפי המיקום במיון לפי מזהה — לא לפי id % palette, שיכול לתת לשתי נקודות
 * את אותו צבע, ולא לפי המיקום ברשימה המוצגת, שמשתנה כשמשנים משקל.
 * המזהה לא זז לעולם, ולכן הצבע גם יציב וגם ייחודי.
 */
const EP_COLORS = ['#4da3ff', '#1baf7a', '#eb6834', '#a06cd5', '#f0b429',
                   '#2ec5c0', '#e5679a', '#8bc34a', '#ff8f5c', '#7c8cff'];

let epColors = new Map();

export function rebuildEpColors() {
  epColors = new Map();
  [...state.endpoints]
    .sort((a, b) => a.id - b.id)
    .forEach((e, i) => epColors.set(e.id, EP_COLORS[i % EP_COLORS.length]));
}

export const epColor = (id) => epColors.get(Number(id)) ?? 'var(--muted)';
