/* Mission Control — הלקוח. כל הנתונים מגיעים מ-/api. */

import { $, $$, esc, run } from './js/core/dom.js';
import { api } from './js/core/api.js';

import { TABS, state, rebuildEpColors } from './js/core/state.js';
import { registerRefreshers, refreshAfterPostChange, goToTab } from './js/ui/refresh.js';
import { wireGenericDialog } from './js/ui/dialog.js';
import { wireEngineDialog } from './js/ui/engineDialog.js';
import { openUrgent, wireUrgentDialog } from './js/ui/urgent.js';
import { wireImportDialog } from './js/ui/importDialog.js';
import { wireAddPostDialog } from './js/ui/addPost.js';
import { wirePostDialog } from './js/ui/postDialog.js';
import { renderStrategy } from './js/features/strategy.js';
import { wireAIWidget } from './js/features/assistant.js';
import { renderTasks } from './js/features/tasks.js';
import { renderData } from './js/features/data.js';
import { renderPlan } from './js/features/plan.js';
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
  currentTab: () => renderTab(state.tab),
  goToTab: (tab) => showTab(tab),
});

boot();

async function boot() {
  try {
    const { user } = await api('/me');
    if (!user) return void (location.href = '/login.html');
    state.me = user;
  } catch {
    return void (location.href = '/login.html');
  }

  const initial = (state.me.name || '?').trim().charAt(0).toUpperCase();
  $('#btnProfile').textContent = initial;
  $('#btnProfile').title = state.me.name;
  $('#pName').innerHTML =
    `${esc(state.me.name)}${state.me.is_owner ? ' <span class="owner-tag">בעלים</span>' : ''}`;
  $('#pEmail').textContent = state.me.email ?? '';

  wireChrome();

  const [{ channels }, { endpoints }, { users }] = await Promise.all([
    api('/channels'), api('/endpoints'), api('/users'),
  ]);
  state.channels = channels;
  state.endpoints = endpoints;
  rebuildEpColors();
  state.users = users;

  await refreshAfterPostChange();
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
  state.tab = tab;
  $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.t === tab)));
  for (const key of TABS) $(`#${key}`).hidden = key !== tab;
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
  $$('.tab').forEach((t) => t.addEventListener('click', run(async () => {
    state.tab = t.dataset.t;
    $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const key of TABS) {
      $(`#${key}`).hidden = key !== state.tab;
    }
    await renderTab(state.tab);
  })));

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
}

async function refreshTaskBadgeImpl() {
  const { open_count } = await api('/tasks');
  const badge = $('#taskBadge');
  badge.hidden = open_count === 0;
  badge.textContent = open_count;
}
