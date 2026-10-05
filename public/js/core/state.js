/**
 * המצב המשותף של הלקוח, וצבע נקודות הקצה שנגזר ממנו.
 * שכבה 0 — כל מודול קורא וכותב לאותו אובייקט state.
 */

export const TABS = ['board', 'strategy', 'plan', 'tasks', 'data', 'manage'];

export const state = {
  me: null,
  media: null,         // { ready, max_mb } — אחסון המדיה ב-R2, מגיע עם /api/me
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
 * התצוגה הנוכחית נשמרת ב-hash של הכתובת (#plan;e=3;c=7, #board;w=2026-10-04)
 * — רענון מחזיר לאותו טאב, לאותו דרילדאון ולאותו שבוע במקום לדף הבית.
 * replaceState ולא כתיבה ל-location.hash — שלא ייערמו רשומות היסטוריה על
 * כל מעבר טאב.
 */
export function serializeView(s) {
  let h = s.tab;
  if (s.tab === 'plan') {
    if (s.planEndpoint) h += `;e=${s.planEndpoint}`;
    if (s.planCampaign) h += `;c=${s.planCampaign}`;
  }
  if (s.tab === 'board' && s.week) h += `;w=${s.week}`;
  return `#${h}`;
}

/** YYYY-MM-DD של תאריך אמיתי: הלוך-חזור דרך Date מחזיר את אותה מחרוזת (2026-02-30 לא) */
const isYmd = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '')) return false;
  const d = new Date(`${v}T00:00:00`);
  const p = (n) => String(n).padStart(2, '0');
  return !Number.isNaN(d.getTime()) &&
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === v;
};

/** מזהה מה-hash: ספרות בלבד, מספר שלם חיובי — אחרת null (לא 1.5, -3, 0x10) */
const idOf = (v) => {
  const n = Number(v);
  return /^\d+$/.test(v ?? '') && Number.isInteger(n) && n > 0 ? n : null;
};

/** hash → מה לשחזר, או null כשה-hash לא מוכר. טהורה — נבדקת בטסטים. */
export function parseView(hash) {
  const parts = String(hash ?? '').replace(/^#/, '').split(';');
  if (!TABS.includes(parts[0])) return null;
  const view = { tab: parts[0], planEndpoint: null, planCampaign: null, week: null };
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k === 'e') view.planEndpoint = idOf(v);
    if (k === 'c') view.planCampaign = idOf(v);
    if (k === 'w' && isYmd(v)) view.week = v;
  }
  return view;
}

export function persistView() {
  history.replaceState(null, '', serializeView(state));
}

/** קורא את ה-hash אל ה-state — פעם אחת, לפני הרינדור הראשון. */
export function restoreView() {
  const view = parseView(location.hash);
  if (!view) return;
  state.tab = view.tab;
  state.planEndpoint = view.planEndpoint;
  state.planCampaign = view.planCampaign;
  state.week = view.week;
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
