import { api } from '../core/api.js';
import { goToTab, refreshAlerts, refreshBoard, refreshTaskBadge } from '../ui/refresh.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { can, state } from '../core/state.js';
import { openPostPreview } from '../ui/postDialog.js';
import { hhmm } from '../core/format.js';

/* ========================= משימות ========================= */

export async function renderTasks() {
  const [t, alertData] = await Promise.all([api('/tasks'), refreshAlerts()]);

  const group = (title, items, emptyText) => `
    <div class="tgroup">
      <h2>${esc(title)}</h2>
      <div class="panel">${items.map(taskRow).join('') || `<div class="empty">${esc(emptyText)}</div>`}</div>
    </div>`;

  $('#tasks').innerHTML = `<div class="tasks">
    ${alertsPanel(alertData)}
    ${group('היום', t.today, 'אין משימות להיום.')}
    ${group('דורש טיפול', t.attention, 'הכול מטופל.')}
    ${group('הושלם השבוע', t.done_this_week, 'עוד לא הושלמו משימות השבוע.')}
  </div>`;

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

  $$('#tasks [data-task-done]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      await api(`/tasks/${cb.dataset.taskDone}`, { method: 'PATCH', body: { done: cb.checked } });
      await Promise.all([renderTasks(), refreshTaskBadge()]);
    })));

  $$('#tasks [data-copy]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('הטקסט הועתק.');
    })));

  $$('#tasks [data-approve]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/posts/${b.dataset.approve}/approve`, { method: 'POST' });
      toast('אושר. השיבוץ נכנס ללוח.');
      await Promise.all([renderTasks(), refreshTaskBadge(), refreshBoard()]);
    })));

  $$('#tasks [data-publish]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/posts/${b.dataset.publish}/publish`, { method: 'POST' });
      toast('סומן כפורסם.');
      await Promise.all([renderTasks(), refreshTaskBadge(), refreshBoard()]);
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
      await Promise.all([renderTasks(), refreshTaskBadge(), refreshBoard()]);
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
      <button class="btn small act" data-goto="${esc(a.tab)}"
        data-campaign="${a.campaign_id ?? ''}" data-endpoint="${a.endpoint_id ?? ''}"
        data-post="${a.post_id ?? ''}">פתח</button>
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

function taskRow(t) {
  const sub = [t.subtitle, t.channel_name, t.scheduled_at ? hhmm(t.scheduled_at) : null]
    .filter(Boolean).join(' · ');

  let action = '';
  if (t.done) action = '';
  else if (t.kind === 'approve' && t.post_id && can('approve')) {
    action = `<button class="btn small act" data-approve="${t.post_id}">אשר</button>`;
  } else if (t.kind === 'publish' && t.post_id) {
    const text = t.content_body || t.post_title || t.title;
    action = `<button class="btn small act" data-copy="${esc(text)}">העתק טקסט</button>
              <button class="btn small act" data-publish="${t.post_id}">סמן כפורסם</button>`;
  } else if (t.kind === 'swap' && t.post_id && can('content')) {
    // ההצעה נשמרת ב-meta של המשימה עצמה — לא צריך לחשב אותה שוב בלחיצה
    action = `<button class="btn small act primary" data-swap-post="${t.post_id}"
      data-swap-task="${t.id}" data-swap-meta="${esc(JSON.stringify(t.meta ?? {}))}">
      החלף בתוכן המוצע</button>`;
  }

  return `<div class="task${t.urgent && !t.done ? ' urgent' : ''}"${t.done ? ' style="opacity:.5"' : ''}>
    <input type="checkbox" data-task-done="${t.id}" ${t.done ? 'checked' : ''}>
    <div class="tx"><b>${esc(t.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${action}</div>`;
}
