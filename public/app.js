/* Mission Control — הלקוח. כל הנתונים מגיעים מ-/api. */

import { $, $$, esc, run } from './js/core/dom.js';
import { api } from './js/core/api.js';

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
import { renderData } from './js/features/data.js';
import { leavePlanView, renderPlan, wireMailPreview } from './js/features/plan.js';
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
});

boot();

async function boot() {
  try {
    const { user, media } = await api('/me');
    if (!user) return void (location.href = '/login.html');
    state.me = user;
    state.media = media ?? null;
  } catch {
    return void (location.href = '/login.html');
  }

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

  wireChrome();
  // שחזור התצוגה מה-hash — לפני הרינדור הראשון, כדי שרענון לא יחזיר לדף הבית
  restoreView();
  $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.t === state.tab)));
  for (const key of TABS) $(`#${key}`).hidden = key !== state.tab;

  const [{ channels }, { endpoints }, { users }] = await Promise.all([
    api('/channels'), api('/endpoints'), api('/users'),
  ]);
  state.channels = channels;
  state.endpoints = endpoints;
  rebuildEpColors();
  state.users = users;

  await refreshAfterPostChange();
  wirePolling();
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

/** מעבר לטאב מתוך קוד (למשל לחיצה על פעמון ההתראות) */
async function showTab(tab) {
  // מצב "בחירת משבצת לקישור" שייך למסך הקמפיין — יציאה ממנו מבטלת אותו
  if (tab !== 'plan') leavePlanView();
  state.tab = tab;
  $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.t === tab)));
  for (const key of TABS) $(`#${key}`).hidden = key !== tab;
  persistView();
  await renderTab(tab);
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
