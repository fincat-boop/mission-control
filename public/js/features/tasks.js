import { api } from '../core/api.js';
import { goToTab, refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { $, $$, copyText, esc, run, toast } from '../core/dom.js';
import { can, state } from '../core/state.js';
import { openPostPreview } from '../ui/postDialog.js';
import { hhmm, fmtDate } from '../core/format.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from '../ui/dialog.js';

/* ========================= משימות ========================= */

/**
 * מצב התצוגה של הטאב, בין רינדור לרינדור: סינון "שלי" (נשמר בדפדפן),
 * האם קבוצת "נדחו" פתוחה, ומצב בחירה מרובה.
 */
const MINE_KEY = 'mc.tasks.mine';
const view = {
  mine: (() => { try { return localStorage.getItem(MINE_KEY) === '1'; } catch { return false; } })(),
  showSnoozed: false,
  selecting: false,
  selected: new Set(),
};

function setMine(on) {
  view.mine = on;
  try { localStorage.setItem(MINE_KEY, on ? '1' : '0'); } catch { /* דפדפן בלי אחסון — רק לרינדור הזה */ }
}

/** רינדור מתוך הטאב עצמו, אחרי פעולה של המשתמש */
const rerender = () => renderTasks({ force: true });

/** המשתמש באמצע פעולה בטאב: תפריט ⋯ פתוח, או פקד בתוך הטאב בפוקוס */
function tasksBusy() {
  const root = $('#tasks');
  if (!root) return false;
  if (root.querySelector('details.tmore[open]')) return true;
  const a = document.activeElement;
  return !!a && a !== document.body && root.contains(a) &&
    a.matches('input, select, textarea, button, summary');
}

/** "דחה עד מחר" = מחר ב-08:00 בשעון המקומי */
function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

/** משימת אישור בלי הרשאת אישור — לא נסגרת, לא נדחית ולא נבחרת (השרת אוכף) */
const approveLocked = (t) => t.kind === 'approve' && !can('approve');

/** התגית שעל טאב המשימות: מספר המשימות הפתוחות */
export function paintTaskBadge(openCount) {
  const badge = $('#taskBadge');
  badge.hidden = !openCount;
  badge.textContent = openCount;
}

/**
 * מצייר את הטאב, וגם מעדכן בדרך את הפעמון ואת תגית המשימות מאותם נתונים —
 * מי שקורא ל-renderTasks לא צריך למשוך אותם שוב.
 */
export async function renderTasks({ force = false } = {}) {
  // רענון מבחוץ (הרענון התקופתי, focus, שינוי בפוסט) בזמן שהמשתמש באמצע
  // פעולה בטאב — תפריט פתוח או שדה בפוקוס — לא מצייר מחדש מתחת לידיים
  // שלו: רק התגית והפעמון מתעדכנים. רינדור מתוך הטאב עצמו (force) — תמיד.
  if (!force && tasksBusy()) {
    await Promise.all([
      api('/tasks/count').then((c) => paintTaskBadge(c.open_count)),
      refreshAlerts(),
    ]);
    return;
  }
  const [t, alertData, users] = await Promise.all([
    api('/tasks'), refreshAlerts(),
    state.users.length ? state.users : api('/users').then((r) => r.users),
  ]);
  state.users = users;
  paintTaskBadge(t.open_count);

  // "שלי" = משויך אליי. הסינון בצד הלקוח — הרשימה ממילא קטנה. משימת אישור
  // נשארת גלויה למי שיכול לאשר: היא מחליפה את התראת "ממתין לאישור" (שמוסתרת
  // כשיש משימה), ובלעדיה המאשר לא היה רואה שום סימן
  const mineOnly = (list) => (view.mine
    ? list.filter((x) => x.assignee_id === state.me?.id || (x.kind === 'approve' && can('approve')))
    : list);
  // הבחירה המרובה — רק ממה שמוצג עכשיו (אחרי "שלי"); מה שהוסתר יוצא ממנה
  const visibleIds = new Set([...mineOnly(t.today), ...mineOnly(t.attention)].map((x) => x.id));
  for (const id of view.selected) if (!visibleIds.has(id)) view.selected.delete(id);

  const group = (title, items, emptyText) => `
    <div class="tgroup">
      <h2>${esc(title)}</h2>
      <div class="panel">${items.map(taskRow).join('') || `<div class="empty">${esc(emptyText)}</div>`}</div>
    </div>`;

  const snoozed = mineOnly(t.snoozed ?? []);
  $('#tasks').innerHTML = `<div class="tasks">
    ${alertsPanel(alertData)}
    ${tasksToolbar()}
    ${group('היום', mineOnly(t.today), view.mine ? 'אין לך משימות להיום.' : 'אין משימות להיום.')}
    ${group('דורש טיפול', mineOnly(t.attention), 'הכול מטופל.')}
    ${snoozed.length ? `<div class="tgroup">
      <button class="tsnoozed-toggle" id="taskSnoozedToggle" aria-expanded="${view.showSnoozed}">
        נדחו (${snoozed.length})</button>
      ${view.showSnoozed ? `<div class="panel">${snoozed.map(taskRow).join('')}</div>` : ''}
    </div>` : ''}
    ${group('הושלם השבוע', mineOnly(t.done_this_week), 'עוד לא הושלמו משימות השבוע.')}
  </div>`;

  wireToolbar();
  wireRowMenus();

  // "פתח" על התראת קמפיין/נקודת קצה קופץ ישר לתוכם, לא לדף שורש הבחירה
  $$('#tasks [data-goto]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (b.dataset.campaign) {
        state.planCampaign = Number(b.dataset.campaign);
        state.planEndpoint = null;
        state.planBackground = false;
      } else if (b.dataset.endpoint) {
        state.planEndpoint = Number(b.dataset.endpoint);
        state.planCampaign = null;
        state.planBackground = false;
      }
      await goToTab(b.dataset.goto);
      // התראה על פוסט ספציפי (חור/ממתין לאישור/בלי טקסט) פותחת אותו ישר,
      // לא רק מחליפה טאב ומשאירה למשתמש למצוא אותו בעצמו
      if (b.dataset.post) await openPostPreview(b.dataset.post);
    })));

  $$('#tasks [data-task-pick]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.taskPick);
      if (cb.checked) view.selected.add(id); else view.selected.delete(id);
      paintBulkBar();
    }));

  // "פתח" על משימה של פוסט — אותו חלון פוסט שההתראות פותחות, בלי לעזוב את הטאב
  $$('#tasks [data-open-post]').forEach((b) =>
    b.addEventListener('click', run(() => openPostPreview(b.dataset.openPost))));

  $$('#tasks [data-task-done]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      await api(`/tasks/${cb.dataset.taskDone}`, { method: 'PATCH', body: { done: cb.checked } });
      await rerender();
    })));

  $$('#tasks [data-copy]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await copyText(b.dataset.copy, b.parentElement);
      toast('הטקסט הועתק.');
    })));

  $$('#tasks [data-approve]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/posts/${b.dataset.approve}/approve`, { method: 'POST' });
      toast('אושר. השיבוץ נכנס ללוח.');
      await Promise.all([rerender(), refreshBoard()]);
    })));

  $$('#tasks [data-publish]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/posts/${b.dataset.publish}/publish`, { method: 'POST' });
      toast('סומן כפורסם.');
      await Promise.all([rerender(), refreshBoard()]);
    })));

  // הצעת החלפת תוכן: מעדכן את השיבוץ עם התוכן המוצע וסוגר את המשימה
  $$('#tasks [data-swap-post]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const meta = JSON.parse(b.dataset.swapMeta || '{}');
      if (!meta.suggested_content_id) return toast('אין הצעה שמורה למשימה הזו.', true);
      await api(`/posts/${b.dataset.swapPost}`, {
        method: 'PATCH',
        body: {
          content_id: meta.suggested_content_id,
          endpoint_id: meta.suggested_endpoint_id,
          title: meta.suggested_title,
          kind: meta.suggested_kind,
        },
      });
      await api(`/tasks/${b.dataset.swapTask}`, { method: 'PATCH', body: { done: true } });
      toast('הוחלף. השיבוץ מציג עכשיו את התוכן המוצע.');
      await Promise.all([rerender(), refreshBoard()]);
    })));
}

const ALERT_TONE = {
  crit: { color: 'var(--st-crit)', label: 'חוסם' },
  warn: { color: 'var(--st-warn)', label: 'דורש טיפול' },
  info: { color: 'var(--ink-2)', label: 'לידיעה' },
};

function alertsPanel({ alerts, counts }) {
  if (!alerts.length) {
    return `<div class="tgroup"><h2>התראות</h2>
      <div class="panel"><div class="empty">אין התראות פתוחות. הכול בקצב.</div></div></div>`;
  }

  // חומרת ההתראה מסומנת בנקודה, כמו בשבבי החמצן שבלוח
  const rows = alerts.map((a) => {
    const tone = ALERT_TONE[a.level];
    return `<div class="task">
      <span class="dot" style="background:${tone.color}" data-tt="${esc(tone.label)}"></span>
      <div class="tx">
        <b style="color:${tone.color}">${esc(a.title)}</b>
        <span>${esc(a.detail)}</span>
      </div>
      ${a.tab ? `<button class="btn small act" data-goto="${esc(a.tab)}"
        data-campaign="${a.campaign_id ?? ''}" data-endpoint="${a.endpoint_id ?? ''}"
        data-post="${a.post_id ?? ''}">פתח</button>` : ''}
    </div>`;
  }).join('');

  const summary = [
    counts.crit ? `<b style="color:var(--st-crit)">${counts.crit} חוסמות</b>` : '',
    counts.warn ? `<b style="color:var(--st-warn)">${counts.warn} דורשות טיפול</b>` : '',
    counts.info ? `${counts.info} לידיעה` : '',
  ].filter(Boolean).join(' · ');

  return `<div class="tgroup">
    <h2>התראות</h2>
    <div class="sumline" style="margin:0 0 10px">${summary}</div>
    <div class="panel">${rows}</div>
  </div>`;
}

/** משימת אישור נסגרת רק בידי מי שמורשה לאשר (השרת אוכף; כאן רק לא מציעים) */
function checkbox(t) {
  // מצב בחירה: תיבה לבחירה במקום "בוצע". משימה שנדחתה לא נבחרת (היא לא ברשימה הפתוחה)
  if (view.selecting && !t.done && !isSnoozedRow(t)) {
    const locked = approveLocked(t);
    return `<input type="checkbox" class="tpick" data-task-pick="${t.id}"
      ${view.selected.has(t.id) ? 'checked' : ''}${
      locked ? ' disabled data-tt="רק מי שמורשה לאשר יכול לסגור או למחוק משימת אישור"' : ''}>`;
  }
  const locked = approveLocked(t);
  return `<input type="checkbox" data-task-done="${t.id}" ${t.done ? 'checked' : ''}${
    locked ? ' disabled data-tt="רק מי שמורשה לאשר יכול לסגור משימת אישור"' : ''}>`;
}

const isSnoozedRow = (t) => !t.done && t.snoozed_until && new Date(t.snoozed_until) > new Date();

/** תפריט "⋯" לשורה פתוחה: דחייה (או החזרה), שיוך, מחיקה */
function rowMenu(t) {
  if (t.done || !can('content')) return '';
  const locked = approveLocked(t);
  const snoozed = isSnoozedRow(t);
  const users = state.users ?? [];
  return `<details class="tmore">
    <summary class="btn small" aria-label="עוד פעולות">⋯</summary>
    <div class="tmenu">
      ${locked ? '' : snoozed
        ? `<button data-task-unsnooze="${t.id}">החזר לרשימה</button>`
        : `<button data-task-snooze="${t.id}">דחה עד מחר</button>`}
      <label class="tassign">שייך ל…
        <select data-task-assign="${t.id}">
          <option value="">— בלי —</option>
          ${users.map((u) => `<option value="${u.id}"${u.id === t.assignee_id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>
      </label>
      ${locked ? '' : `<div class="sep"></div>
      <button data-task-del="${t.id}" data-danger>מחק</button>`}
    </div>
  </details>`;
}

function taskRow(t) {
  const sub = [
    t.subtitle, t.channel_name, t.scheduled_at ? hhmm(t.scheduled_at) : null,
    !t.post_id && t.due_on ? `עד ${fmtDate(t.due_on)}` : null,
    isSnoozedRow(t) ? `נדחתה עד ${fmtDate(t.snoozed_until)}` : null,
  ].filter(Boolean).join(' · ');

  let action = '';
  if (t.done) action = '';
  else if (t.kind === 'approve' && t.post_id && can('approve')) {
    action = `<button class="btn small act" data-approve="${t.post_id}">אשר</button>`;
  } else if (t.kind === 'publish' && t.post_id) {
    action = `<button class="btn small act" data-copy="${esc(t.copy_text)}">העתק טקסט</button>
              <button class="btn small act" data-publish="${t.post_id}">סמן כפורסם</button>`;
  } else if (t.kind === 'swap' && t.post_id && can('content')) {
    // ההצעה נשמרת ב-meta של המשימה עצמה — לא צריך לחשב אותה שוב בלחיצה
    action = `<button class="btn small act primary" data-swap-post="${t.post_id}"
      data-swap-task="${t.id}" data-swap-meta="${esc(JSON.stringify(t.meta ?? {}))}">
      החלף בתוכן המוצע</button>`;
  }

  const open = t.post_id
    ? `<button class="btn small act" data-open-post="${t.post_id}">פתח</button>` : '';

  const who = t.assignee_name ? `<span class="twho">${esc(t.assignee_name)}</span>` : '';

  return `<div class="task${t.urgent && !t.done ? ' urgent' : ''}"${t.done ? ' style="opacity:.5"' : ''}>
    ${checkbox(t)}
    <div class="tx"><b>${esc(t.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${who}${view.selecting ? '' : `${action}${open}${rowMenu(t)}`}</div>`;
}

/* ========================= סרגל: הכול/שלי, בחירה, משימה חדשה ========================= */

function tasksToolbar() {
  const edit = can('content');
  return `<div class="toolbar ttools">
    <div class="periodpick small" role="group" aria-label="סינון משימות">
      <button data-task-view="all"${view.mine ? '' : ' class="on"'}>הכול</button>
      <button data-task-view="mine"${view.mine ? ' class="on"' : ''}>שלי</button>
    </div>
    ${edit ? `<span class="tspacer"></span>
      <button class="btn small" id="taskSelect">${view.selecting ? 'סיום בחירה' : 'בחירה'}</button>
      <button class="btn small primary" id="taskAdd">＋ משימה</button>` : ''}
  </div>
  ${view.selecting ? `<div class="tbulk" id="taskBulk">
    <span id="taskBulkCount"></span>
    <button class="btn small" id="taskBulkDone">סמן בוצע</button>
    <button class="btn small tdanger" id="taskBulkDel">מחק</button>
  </div>` : ''}`;
}

function paintBulkBar() {
  const n = view.selected.size;
  const count = $('#taskBulkCount');
  if (!count) return;
  count.textContent = n ? `נבחרו ${n}` : 'בוחרים משימות ברשימה';
  $('#taskBulkDone').disabled = !n;
  $('#taskBulkDel').disabled = !n;
}

async function bulk(action) {
  const ids = [...view.selected];
  const r = await api('/tasks/bulk', { method: 'POST', body: { ids, action } });
  view.selected.clear();
  view.selecting = false;
  const verb = action === 'delete' ? 'נמחקו' : 'סומנו כבוצעו';
  toast(`${r.affected} ${verb}` + (r.skipped ? ` · ${r.skipped} משימות אישור דולגו — רק מי שמורשה לאשר` : '.'));
  await rerender();
}

function wireToolbar() {
  $$('#tasks [data-task-view]').forEach((b) => b.addEventListener('click', run(async () => {
    setMine(b.dataset.taskView === 'mine');
    await rerender();
  })));
  $('#taskSelect')?.addEventListener('click', run(async () => {
    view.selecting = !view.selecting;
    view.selected.clear();
    await rerender();
  }));
  $('#taskAdd')?.addEventListener('click', openNewTask);
  $('#taskSnoozedToggle')?.addEventListener('click', run(async () => {
    view.showSnoozed = !view.showSnoozed;
    await rerender();
  }));
  $('#taskBulkDone')?.addEventListener('click', run(() => bulk('done')));
  $('#taskBulkDel')?.addEventListener('click', run(async () => {
    const n = view.selected.size;
    if (!await confirmDialog(`למחוק ${n === 1 ? 'משימה אחת' : `${n} משימות`}? אי אפשר לבטל.`,
      { okLabel: 'מחק', danger: true })) return;
    await bulk('delete');
  }));
  paintBulkBar();
}

/** פעולות התפריט של כל שורה */
function wireRowMenus() {
  // תפריט אחד פתוח בכל רגע
  $$('#tasks details.tmore').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) $$('#tasks details.tmore[open]').forEach((o) => { if (o !== d) o.open = false; });
  }));
  $$('#tasks [data-task-snooze]').forEach((b) => b.addEventListener('click', run(async () => {
    await api(`/tasks/${b.dataset.taskSnooze}`, { method: 'PATCH', body: { snoozed_until: tomorrowMorning() } });
    toast('נדחתה עד מחר בבוקר.');
    await rerender();
  })));
  $$('#tasks [data-task-unsnooze]').forEach((b) => b.addEventListener('click', run(async () => {
    await api(`/tasks/${b.dataset.taskUnsnooze}`, { method: 'PATCH', body: { snoozed_until: null } });
    await rerender();
  })));
  $$('#tasks [data-task-assign]').forEach((sel) => sel.addEventListener('change', run(async () => {
    await api(`/tasks/${sel.dataset.taskAssign}`, {
      method: 'PATCH', body: { assignee_id: sel.value ? Number(sel.value) : null },
    });
    toast(sel.value ? 'שויכה.' : 'השיוך הוסר.');
    await rerender();
  })));
  $$('#tasks [data-task-del]').forEach((b) => b.addEventListener('click', run(async () => {
    if (!await confirmDialog('למחוק את המשימה? אי אפשר לבטל.', { okLabel: 'מחק', danger: true })) return;
    await api(`/tasks/${b.dataset.taskDel}`, { method: 'DELETE' });
    toast('נמחקה.');
    await rerender();
  })));
}

/** משימה ידנית — תמיד "כללית" (השרת לא מקבל סוג אחר) */
function openNewTask() {
  const users = state.users ?? [];
  openGeneric({
    title: 'משימה חדשה',
    fields: [
      { name: 'title', label: 'מה צריך לעשות', type: 'text', max: 200 },
      { name: 'due_on', label: 'עד מתי (לא חובה)', type: 'date' },
      { name: 'assignee_id', label: 'אחראי', type: 'select',
        value: state.me?.id ?? '',
        options: [['', '— בלי —'], ...users.map((u) => [u.id, u.name])] },
    ],
    onSave: async (v) => {
      if (!v.title) throw new Error('צריך לכתוב מה המשימה');
      await api('/tasks', { method: 'POST', body: v });
      await rerender();
    },
  });
}
