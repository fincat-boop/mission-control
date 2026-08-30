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
 * התצוגה הנוכחית נשמרת ב-hash של הכתובת (#plan;e=3;c=7) — רענון מחזיר
 * לאותו טאב ולאותו דרילדאון במקום לדף הבית. replaceState ולא כתיבה
 * ל-location.hash — שלא ייערמו רשומות היסטוריה על כל מעבר טאב.
 */
export function persistView() {
  let h = state.tab;
  if (state.tab === 'plan') {
    if (state.planEndpoint) h += `;e=${state.planEndpoint}`;
    if (state.planCampaign) h += `;c=${state.planCampaign}`;
  }
  history.replaceState(null, '', `#${h}`);
}

/** קורא את ה-hash אל ה-state — פעם אחת, לפני הרינדור הראשון. */
export function restoreView() {
  const parts = location.hash.slice(1).split(';');
  if (!TABS.includes(parts[0])) return;
  state.tab = parts[0];
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k === 'e') state.planEndpoint = Number(v) || null;
    if (k === 'c') state.planCampaign = Number(v) || null;
  }
}

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
