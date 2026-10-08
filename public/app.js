/* Mission Control — הלקוח. כל הנתונים מגיעים מ-/api. */

import { $, $$, esc, run } from './js/core/dom.js';
import { api } from './js/core/api.js';
import { forgetSessionData, loginUrl } from './js/core/session.js';

import { TABS, state, rebuildEpColors, persistView, restoreView } from './js/core/state.js';
import { registerRefreshers, refreshAfterPostChange, goToTab } from './js/ui/refresh.js';
import { wireGenericDialog } from './js/ui/dialog.js';
import { wireEngineDialog } from './js/ui/engineDialog.js';
import { openUrgent, wireUrgentDialog } from './js/ui/urgent.js';
import { wireImportDialog } from './js/ui/importDialog.js';
import { wireAddPostDialog } from './js/ui/addPost.js';
import { wirePostDialog } from './js/ui/postDialog.js';
import { renderStrategy } from './js/features/strategy.js';
import { wireAIWidget } from './js/features/assistant.js';
import { paintTaskBadge, renderTasks } from './js/features/tasks.js';
import { confirmLeaveData, renderData } from './js/features/data.js';
import { openPostEditor, renderPlan, wireMailPreview } from './js/features/plan.js';
import { renderManage } from './js/features/manage.js';
import { renderBoard } from './js/features/board.js';

/* ========================= טעינה ראשונית ========================= */

// הרנדררים נרשמים לפני כל רינדור, כדי ששום פעולה לא תקרא לרענון
// שעוד לא קיים. מכאן והלאה אף מודול לא צריך להכיר רנדרר של מודול אחר.
registerRefreshers({
  board: () => renderBoard(),
  plan: () => renderPlan(),
  strategy: () => renderStrategy(),
  manage: () => renderManage(),
  data: () => renderData(),
  tasks: () => renderTasks(),
  taskBadge: () => refreshTaskBadgeImpl(),
  alerts: () => refreshAlertsImpl(),
  attention: () => refreshAttentionImpl(),
  // טאב הנתונים מציג פוסטים (ביצועים) — אחרי שינוי בפוסט הוא מתעדכן אם מוצג.
  // התוכן לא: יש בו עורכים פתוחים, ו"פתח בתוכן" ממילא מנווט אליו מחדש.
  postViews: () => (state.tab === 'data' ? renderData() : undefined),
  currentTab: () => renderTab(state.tab),
  goToTab: (tab) => showTab(tab),
  openPostEditor: (post, hooks) => openPostEditor(post, hooks),
});

let chromeWired = false;
let pollingWired = false;

$('#bootRetry').addEventListener('click', () => boot());
boot();

/**
 * עלייה. נכשלת לכרטיס שגיאה עם "נסה שוב" — לא למסך ריק ולא לדף הכניסה:
 * רק תשובה של /me בלי משתמש (או 401) אומרת שצריך להתחבר. נפילת רשת או
 * שרת היא תקלה זמנית, והכניסה לא תפתור אותה. "נסה שוב" מריץ את העלייה
 * מחדש בלי לטעון את הדף — אם השרת למטה, טעינה הייתה מראה דף שגיאה של הדפדפן.
 */
async function boot() {
  showBootError(null);
  let me;
  try {
    me = await api('/me');
  } catch (e) {
    return showBootError(e);
  }
  // לא מחוברים — לכניסה, ומשם חזרה לאותה תצוגה (קישור שהודבק לא הולך לאיבוד)
  if (!me.user) return void (location.href = loginUrl());
  state.me = me.user;
  state.media = me.media ?? null;

  const initial = (state.me.name || '?').trim().charAt(0).toUpperCase();
  $('#btnProfile').textContent = initial;
  $('#btnProfile').title = state.me.name;
  $('#pName').innerHTML =
    `${esc(state.me.name)}${state.me.is_owner ? ' <span class="owner-tag">בעלים</span>' : ''}`;
  $('#pEmail').textContent = state.me.email ?? '';
  if (state.me.org_name) {
    const org = $('#pOrg');
    org.textContent = state.me.org_name;
    org.hidden = false;
  }

  if (!chromeWired) {
    wireChrome();
    chromeWired = true;
  }
  // שחזור התצוגה מה-hash — לפני הרינדור הראשון, כדי שרענון לא יחזיר לדף הבית
  restoreView();
  paintTabs(state.tab);
  markEntry();

  try {
    const [{ channels }, { endpoints }, { users }, { settings }] = await Promise.all([
      api('/channels'), api('/endpoints'), api('/users'), api('/settings'),
    ]);
    state.autopublish = !!settings?.autopublish_enabled;
    state.channels = channels;
    state.endpoints = endpoints;
    rebuildEpColors();
    state.users = users;

    await refreshAfterPostChange();
    // refreshAfterPostChange מצייר לוח/משימות/נתונים בלבד — טאב אחר שחזר
    // מה-hash (ניהול, אסטרטגיה, קמפיינים) היה נשאר ריק עד לחיצה עליו
    if (!['board', 'tasks', 'data'].includes(state.tab)) await renderTab(state.tab);
  } catch (e) {
    return showBootError(e);
  }
  if (!pollingWired) {
    wirePolling();
    pollingWired = true;
  }
}

/** כרטיס שגיאה במקום התוכן (e=null מסתיר אותו) */
function showBootError(e) {
  $('#bootErr').hidden = !e;
  $('main').hidden = !!e;
  if (!e) return;
  // fetch שלא הגיע לשרת זורק TypeError ("Failed to fetch") — באנגלית ובלי פרטים
  $('#bootErrMsg').textContent = e instanceof TypeError
    ? 'אין חיבור לשרת. בודקים את החיבור לאינטרנט ולוחצים "נסה שוב".'
    // 5xx, או תשובה בלי הודעה שלנו (דף שגיאה של הפרוקסי בזמן פריסה)
    : e.status >= 500 || (e.status && !e.payload?.error)
      ? 'השרת לא זמין כרגע או נתקל בתקלה. בדרך כלל זה עובר תוך דקה — לוחצים "נסה שוב".'
      : e.message;
  $('#bootRetry').focus();
}

const RENDERERS = {
  board: () => renderBoard(),
  strategy: () => renderStrategy(),
  plan: () => renderPlan(),
  tasks: () => renderTasks(),
  data: () => renderData(),
  manage: () => renderManage(),
};

const renderTab = (tab) => RENDERERS[tab]();

/**
 * הטאב הנבחר: aria-selected, ה-tabindex המתגלגל (רק הנבחר נגיש ב-Tab),
 * והאזור שמוצג. בטלפון רצועת הטאבים נגללת בתוכה — הנבחר נגלל לתצוגה.
 */
function paintTabs(tab) {
  for (const t of $$('.tab')) {
    const on = t.dataset.t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  for (const key of TABS) $(`#${key}`).hidden = key !== tab;
}

/**
 * מעבר לטאב (לחיצה, פעמון, ניווט מתוך קוד). מעבר לטאב אחר מוסיף רשומה
 * להיסטוריה — "אחורה" בדפדפן חוזר לטאב הקודם (onHashChange). persistView
 * עצמו מחליף את הרשומה הנוכחית (replaceState), ולכן קודם משכפלים אותה:
 * הישנה נשארת מאחור, והחדשה מקבלת את ה-hash של הטאב החדש.
 */
async function showTab(tab) {
  if (tab !== state.tab) {
    history.pushState(null, '', location.href);
    navPos += 1;
  }
  state.tab = tab;
  paintTabs(tab);
  persistView();
  markEntry();
  await renderTab(tab);
}

/**
 * מיקום הרשומה בהיסטוריה (history.state.navPos), כדי לחזור בדיוק לרשומה
 * של הנתונים כש"אחורה"/"קדימה" מהם בוטל. persistView (state.js, גם
 * בדרילדאון של plan.js) קורא ל-replaceState עם null — העטיפה כאן שומרת
 * את הסימון הקיים במקום למחוק אותו. רשומה בלי סימון היא hash שהוקלד
 * בשורת הכתובת: רשומה חדשה, תמיד בראש ההיסטוריה.
 */
const replaceEntry = history.replaceState.bind(history);
history.replaceState = (data, title, url) => replaceEntry(data ?? history.state, title, url);

let navPos = 0;
let returningToData = false; // ה-hashchange הבא הוא החזרה שלנו לנתונים — לא לצייר
const markEntry = () => replaceEntry({ navPos }, '', location.href);

/** "אחורה"/"קדימה"/hash שהוקלד בוטלו בנתונים — חוזרים לרשומה של הנתונים עצמה */
function returnToData() {
  const pos = history.state?.navPos;
  returningToData = true;
  if (pos == null) history.back();          // hash שהוקלד — הנתונים רשומה אחת אחורה
  else history.go(navPos - pos);
}

/**
 * "אחורה"/"קדימה" בדפדפן, או hash שהודבק לשורת הכתובת: התצוגה נקראת
 * מחדש מה-hash (restoreView) ומצוירת. hash שאינו טאב — מתעלמים.
 * יציאה מהנתונים עם תוצאות שלא נשמרו שואלת קודם, כמו לחיצה על טאב.
 */
async function onHashChange() {
  if (!state.me) return; // עוד בעלייה — boot קורא את ה-hash בעצמו
  // בלי hash = דף הבית (הכתובת שבה המשתמש נחת לפני המעבר הראשון)
  const target = location.hash.slice(1).split(';')[0] || 'board';
  if (returningToData) {
    returningToData = false;
    if (target === 'data') return; // חזרנו לרשומה של הנתונים — הטבלה לא נגעה
  }
  if (!TABS.includes(target)) return;
  if (state.tab === 'data' && target !== 'data' && !(await confirmLeaveData())) {
    // נשארים. לא persistView: הוא היה כותב #data על הרשומה הזו, ובהיסטוריה
    // היו נשארות שתי רשומות של הנתונים
    returnToData();
    return;
  }
  const pos = history.state?.navPos;
  const typed = pos == null; // hash שהוקלד — רשומה חדשה אחרי הנוכחית
  navPos = typed ? navPos + 1 : pos;
  // restoreView קובע דרילדאון רק כשהוא ב-hash; בלעדיו — רמת הנקודות
  if (target === 'plan') {
    state.planEndpoint = null;
    state.planCampaign = null;
  }
  state.tab = target;
  restoreView();
  paintTabs(state.tab);
  if (typed) markEntry();
  await renderTab(state.tab);
}

/**
 * מקלדת ברצועת הטאבים (תבנית tablist של WAI-ARIA, הפעלה ידנית): חיצים
 * מזיזים את הפוקוס — ב-RTL שמאלה זה הבא — Home/End לקצוות, ו-Enter/רווח
 * (הכפתור עצמו) פותח. ההפעלה לא נגררת אחרי הפוקוס: כל טאב טוען נתונים,
 * ומעבר בחיצים היה מריץ בקשות על כל טאב בדרך.
 */
function wireTabKeys() {
  const list = $('.tabs');
  list.addEventListener('keydown', (e) => {
    const tabs = $$('.tab', list);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = document.dir === 'rtl';
    let j;
    if (e.key === 'ArrowLeft') j = rtl ? i + 1 : i - 1;
    else if (e.key === 'ArrowRight') j = rtl ? i - 1 : i + 1;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    else return;
    e.preventDefault();
    j = (j + tabs.length) % tabs.length;
    tabs.forEach((t, k) => { t.tabIndex = k === j ? 0 : -1; });
    tabs[j].focus();
  });
  // יציאה מהרצועה בלי לפתוח — Tab בחזרה נוחת על הטאב הנבחר, לא על האחרון שעבר
  list.addEventListener('focusout', (e) => {
    if (!list.contains(e.relatedTarget)) paintTabs(state.tab);
  });
}

/** מונה ההתראות בפעמון. נקרא אחרי כל פעולה שעשויה לשנות את המצב. */
async function refreshAlertsImpl() {
  const { alerts, counts } = await api('/alerts');
  state.alerts = alerts;
  const badge = $('#alertBadge');
  badge.hidden = counts.total === 0;
  badge.textContent = counts.total;
  badge.style.background = counts.crit > 0 ? 'var(--st-crit)' : 'var(--st-warn)';
  return { alerts, counts };
}

function wireChrome() {
  $$('.tab').forEach((t) => t.addEventListener('click', run(() => showTab(t.dataset.t))));
  wireTabKeys();
  window.addEventListener('hashchange', run(onHashChange));

  $('#btnAlerts').addEventListener('click', run(() => showTab('tasks')));

  const profileBtn = $('#btnProfile');
  const profileMenu = $('#profileMenu');
  const setProfileOpen = (open) => {
    profileMenu.hidden = !open;
    profileBtn.setAttribute('aria-expanded', String(open));
  };
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setProfileOpen(profileMenu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!profileMenu.hidden && !$('#profile').contains(e.target)) setProfileOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setProfileOpen(false);
  });

  $('#btnLogout').addEventListener('click', run(async () => {
    await api('/auth/logout', { method: 'POST' });
    forgetSessionData(); // שיחות העוזר של המשתמש לא נשארות בלשונית
    location.href = '/login.html';
  }));

  $('#btnUrgent').addEventListener('click', openUrgent);

  // tooltip
  const tt = $('#tt');
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tt]');
    if (el) {
      tt.textContent = el.dataset.tt;
      tt.style.display = 'block';
      tt.style.left = `${Math.min(e.clientX + 14, innerWidth - tt.offsetWidth - 10)}px`;
      tt.style.top = `${e.clientY + 16}px`;
    } else tt.style.display = 'none';
  });

  wirePostDialog();
  wireAddPostDialog();
  wireUrgentDialog();
  wireEngineDialog();
  wireGenericDialog();
  wireAIWidget();
  wireImportDialog();
  wireMailPreview();
}

async function refreshTaskBadgeImpl() {
  const { open_count } = await api('/tasks/count');
  paintTaskBadge(open_count);
}

/** התגיות והפעמון; בטאב המשימות — הרשימה עצמה, שמעדכנת את שניהם בדרך */
async function refreshAttentionImpl() {
  if (state.tab === 'tasks') return renderTasks();
  await Promise.all([refreshTaskBadgeImpl(), refreshAlertsImpl()]);
}

/* ========================= רענון תקופתי ========================= */

/**
 * משימת וואטסאפ או כשל פרסום נוצרים בשרת בלי שאף אחד לחץ על כלום — בלי
 * רענון, התגיות נשארות על מה שהיה בטעינה. כל 90 שניות כשהדף גלוי, ומיד
 * כשחוזרים אליו. רק תשומת הלב: הלוח לא מצויר מחדש מתחת לידיים של המשתמש.
 */
const POLL_MS = 90000;
const POLL_MIN_GAP_MS = 5000; // focus ו-visibilitychange מגיעים כמעט יחד
let lastPoll = 0;
let polling = false;

async function pollAttention() {
  if (document.visibilityState !== 'visible' || polling) return;
  if (Date.now() - lastPoll < POLL_MIN_GAP_MS) return;
  polling = true;
  lastPoll = Date.now();
  try {
    await refreshAttentionImpl();
  } catch (e) {
    // בלי טוסט כל דקה וחצי — הפעולה הבאה של המשתמש תציג את השגיאה
    console.warn('רענון תקופתי נכשל:', e.message);
  } finally {
    polling = false;
  }
}

function wirePolling() {
  lastPoll = Date.now(); // הטעינה עצמה היא הרענון הראשון
  setInterval(pollAttention, POLL_MS);
  document.addEventListener('visibilitychange', pollAttention);
  window.addEventListener('focus', pollAttention);
}
