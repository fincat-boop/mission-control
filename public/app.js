/* מרכז בקרה פרסומי — הלקוח. כל הנתונים מגיעים מ-/api. */

/* ========================= עזרי בסיס ========================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('נדרשת התחברות');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'הפעולה נכשלה');
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = 'none'), 3200);
}

/** עוטף פעולה כך ששגיאת שרת תוצג כטוסט במקום להיעלם בקונסול */
const run = (fn) => async (...args) => {
  try { await fn(...args); }
  catch (e) { toast(e.message, true); }
};

const KIND_HE = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };
const KIND_VAR = { promo: 'var(--leg-promo)', value: 'var(--leg-value)', hybrid: 'var(--leg-hybrid)' };

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);

/* ========================= מצב ========================= */

const TABS = ['board', 'campaigns', 'content', 'tasks', 'manage'];

const state = {
  me: null,
  week: null,          // תאריך עוגן לשבוע המוצג
  channels: [],
  endpoints: [],
  users: [],
  campaigns: [],
  selectedCampaign: null,  // הקמפיין שנבחר בעמוד התוכן
  tab: 'board',
};

const can = (perm) => !!state.me && (state.me.is_owner || state.me[`perm_${perm}`]);

/* ========================= טעינה ראשונית ========================= */

boot();

async function boot() {
  try {
    const { user } = await api('/me');
    if (!user) return void (location.href = '/login.html');
    state.me = user;
  } catch {
    return void (location.href = '/login.html');
  }

  $('#userBadge').innerHTML =
    `<b>${esc(state.me.name)}</b>${state.me.is_owner ? ' <span class="owner-tag">בעלים</span>' : ''}`;

  wireChrome();

  const [{ channels }, { endpoints }, { users }] = await Promise.all([
    api('/channels'), api('/endpoints'), api('/users'),
  ]);
  state.channels = channels;
  state.endpoints = endpoints;
  state.users = users;

  await Promise.all([renderBoard(), refreshTaskBadge(), refreshAlerts()]);
}

const RENDERERS = {
  board: () => renderBoard(),
  campaigns: () => renderCampaigns(),
  content: () => renderContent(),
  tasks: () => renderTasks(),
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
async function refreshAlerts() {
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
  wireUrgentDialog();
  wireEngineDialog();
  wireGenericDialog();
}

async function refreshTaskBadge() {
  const { open_count } = await api('/tasks');
  const badge = $('#taskBadge');
  badge.hidden = open_count === 0;
  badge.textContent = open_count;
}

/* ========================= הלוח ========================= */

async function renderBoard() {
  const b = await api(`/board${state.week ? `?week=${state.week}` : ''}`);
  const editable = can('content');

  const oxy = b.oxygen.map((o) => {
    const when = o.days_since === null
      ? 'עוד לא פורסם'
      : o.days_since === 0 ? 'פורסם היום'
      : o.days_since === 1 ? 'פורסם אתמול'
      : `${o.days_since} ימים בלי פרסום`;
    const extra = o.stale && o.scheduled_this_week > 0
      ? ` — משובץ ${o.scheduled_this_week} פעמים השבוע` : '';
    return `<span class="oxychip${o.stale ? ' bad' : ''}">
      <span class="dot"></span><b>${esc(o.name)}</b>
      <span class="d">${esc(when + extra)}</span></span>`;
  }).join('');

  const head = b.week.days.map((d) => `<th>${esc(d.label)}</th>`).join('');

  const body = b.channels.map((ch) => {
    const full = ch.used >= ch.max_per_week;
    const days = ch.days.map((day) => {
      const cards = day.posts.map((p) => postCard(p)).join('');
      const add = editable
        ? `<button class="addslot" data-add-channel="${ch.id}" data-add-date="${day.date}" title="שיבוץ חדש">＋</button>`
        : '';
      return `<td class="day">${cards}${add}</td>`;
    }).join('');
    return `<tr>
      <td class="chan">
        <div class="cname">${esc(ch.name)}</div>
        <div class="cap${full ? ' full' : ''}">${ch.used} מתוך ${ch.max_per_week} השבוע</div>
      </td>${days}</tr>`;
  }).join('');

  const s = b.summary;
  const ratio = s.value_per_promo === null
    ? 'אין עדיין פוסטים מכירתיים השבוע'
    : `על כל מכירתי יש <b>${s.value_per_promo} פוסטי ערך</b> ${s.value_per_promo >= 3 ? '✓' : '⚠'}`;

  $('#board').innerHTML = `
    <div class="oxy"><span class="t">מי מקבל במה:</span>${oxy || '<span class="d">אין נקודות קצה פעילות</span>'}</div>

    <div class="toolbar">
      <div class="weeknav">
        <button data-week="${b.week.prevWeek}">‹</button>
        ${esc(b.week.label)}
        <button data-week="${b.week.nextWeek}">›</button>
      </div>
      <button class="btn small" id="thisWeek">השבוע</button>
      ${editable ? '<button class="btn small primary" id="runEngine">⚙ מלא את השבוע</button>' : ''}
      <div class="spacer"></div>
      <div class="legend">
        <span><i class="sw" style="background:var(--leg-promo)"></i>מכירתי</span>
        <span><i class="sw" style="background:var(--leg-value)"></i>ערך</span>
        <span><i class="sw" style="background:var(--leg-hybrid)"></i>משולב</span>
        <span>· ⚡ דחוף · ✓ פורסם</span>
      </div>
    </div>

    <div class="board panel">
      <table class="grid">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body || `<tr><td class="empty" colspan="8">אין ערוצים פעילים — מוסיפים אותם במסך "ניהול"</td></tr>`}</tbody>
      </table>
    </div>
    <div class="sumline">השבוע: <b>${s.total} פרסומים</b> · מהם <b>${s.promo} מכירתיים</b> · ${ratio}</div>`;

  $$('#board [data-week]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      state.week = btn.dataset.week;
      await renderBoard();
    })));
  $('#thisWeek').addEventListener('click', run(async () => {
    state.week = null;
    await renderBoard();
  }));
  $('#runEngine')?.addEventListener('click', run(openEngine));

  if (editable) {
    $$('#board [data-add-channel]').forEach((btn) =>
      btn.addEventListener('click', () => openPostDialog(null, {
        channel_id: Number(btn.dataset.addChannel),
        date: btn.dataset.addDate,
      })));
    $$('#board [data-post-id]').forEach((el) =>
      el.addEventListener('click', () => openPostDialog(JSON.parse(el.dataset.post))));
  }
}

function postCard(p) {
  const who = p.assignee_name ? ` · ${esc(p.assignee_name)}` : '';
  const payload = esc(JSON.stringify(p));
  const clickable = can('content') ? `data-post-id="${p.id}" data-post="${payload}"` : '';

  if (p.status === 'hole') {
    return `<div class="hole" ${clickable}
      data-tt="הלוח מחכה לתוכן: ${esc(KIND_HE[p.kind])} — ${esc(p.endpoint_name ?? '')}">
      מחכה לתוכן<br><small>${esc(KIND_HE[p.kind])} · ${esc(p.endpoint_name ?? '')}</small></div>`;
  }
  if (p.status === 'pending_approval') {
    return `<div class="pending" ${clickable}
      data-tt="ממתין לאישור — ${esc(p.title)}">
      ממתין לאישור<br><small>${esc(p.title)}</small></div>`;
  }
  const cls = `post ${p.kind}${p.status === 'published' ? ' published' : ''}`;
  const tip = `${KIND_HE[p.kind]} · ${p.endpoint_name ?? ''}${p.urgent ? ' · דחוף' : ''}` +
              `${p.assignee_name ? ` · אחראי: ${p.assignee_name}` : ''}`;
  return `<div class="${cls}" ${clickable} data-tt="${esc(tip)}">
    <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
    <div class="meta">${esc(p.time)}${who}</div></div>`;
}

/* ========================= דיאלוג שיבוץ ========================= */

let editingPost = null;

function wirePostDialog() {
  $('#pCancel').addEventListener('click', () => $('#postDlg').close());
  $('#pSave').addEventListener('click', run(savePost));
  $('#pDelete').addEventListener('click', run(async () => {
    if (!editingPost) return;
    await api(`/posts/${editingPost.id}`, { method: 'DELETE' });
    $('#postDlg').close();
    toast('השיבוץ נמחק.');
    await Promise.all([renderBoard(), refreshTaskBadge()]);
  }));
}

function openPostDialog(post, defaults = {}) {
  editingPost = post;
  $('#postDlgTitle').textContent = post ? 'עריכת שיבוץ' : 'שיבוץ חדש';
  $('#pDelete').hidden = !post;

  fillSelect($('#pEndpoint'), state.endpoints, 'name', 'ללא נקודת קצה');
  fillSelect($('#pChannel'), state.channels, 'name');
  fillSelect($('#pAssignee'), state.users, 'name', 'ללא אחראי');

  $('#pTitle').value = post?.title ?? '';
  $('#pEndpoint').value = post?.endpoint_id ?? '';
  $('#pChannel').value = post?.channel_id ?? defaults.channel_id ?? state.channels[0]?.id ?? '';
  $('#pKind').value = post?.kind ?? 'value';
  $('#pAssignee').value = post?.assignee_id ?? '';
  $('#pStatus').value = post?.status ?? 'scheduled';
  $('#pWhen').value = post
    ? toLocalInput(new Date(post.scheduled_at))
    : `${defaults.date ?? ymd(new Date())}T10:00`;

  $('#postDlg').showModal();
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function savePost() {
  const body = {
    title: $('#pTitle').value.trim(),
    endpoint_id: numOrNull($('#pEndpoint').value),
    channel_id: Number($('#pChannel').value),
    kind: $('#pKind').value,
    status: $('#pStatus').value,
    assignee_id: numOrNull($('#pAssignee').value),
    scheduled_at: new Date($('#pWhen').value).toISOString(),
  };
  if (!body.title) return toast('צריך כותרת', true);
  if (!body.channel_id) return toast('צריך לבחור ערוץ', true);

  if (editingPost) {
    const wasPublished = editingPost.status === 'published';
    await api(`/posts/${editingPost.id}`, { method: 'PATCH', body });
    // מעבר ל"פורסם" מחתים שעת פרסום וסוגר את המשימה הצמודה
    if (!wasPublished && body.status === 'published') {
      await api(`/posts/${editingPost.id}/publish`, { method: 'POST' });
    }
  } else {
    await api('/posts', { method: 'POST', body });
  }
  $('#postDlg').close();
  toast('נשמר. הלוח עודכן.');
  await Promise.all([renderBoard(), refreshTaskBadge()]);
}

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

function fillSelect(sel, items, labelKey, emptyLabel) {
  sel.innerHTML =
    (emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : '') +
    items.map((i) => `<option value="${i.id}">${esc(i[labelKey])}</option>`).join('');
}

/* ========================= מבצע דחוף ========================= */

function wireUrgentDialog() {
  $('#uCancel').addEventListener('click', () => $('#urgentDlg').close());
  $('#uCheck').addEventListener('click', run(previewUrgent));
  $('#uOk').addEventListener('click', run(commitUrgent));
}

function openUrgent() {
  if (!can('content')) return toast('אין לך הרשאה לשבץ תוכן', true);

  fillSelect($('#uEndpoint'), state.endpoints, 'name', 'ללא נקודת קצה');
  $('#uChannels').innerHTML = state.channels
    .filter((c) => c.active)
    .map((c) => `<label><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`)
    .join('');

  const inTwoDays = new Date(Date.now() + 2 * 86400000);
  $('#uUntil').value = ymd(inTwoDays);
  $('#uTitle').value = '';
  $('#uWhatIf').innerHTML = '<b>מה יקרה:</b> מלאו את הפרטים ולחצו "בדוק".';
  $('#uOk').disabled = true;
  $('#urgentDlg').showModal();
}

const urgentBody = () => ({
  title: $('#uTitle').value.trim(),
  endpoint_id: numOrNull($('#uEndpoint').value),
  until: $('#uUntil').value || null,
  channel_ids: $$('#uChannels input:checked').map((i) => Number(i.value)),
});

async function previewUrgent() {
  const plan = await api('/urgent/preview', { method: 'POST', body: urgentBody() });

  if (plan.errors?.length) {
    $('#uWhatIf').innerHTML = `<b>חסר מידע:</b>${plan.errors.map((e) => `<br>${esc(e)}`).join('')}`;
    $('#uOk').disabled = true;
    return;
  }
  const lines = plan.placements
    .map((p) => `${esc(p.channel_name)} ${esc(p.day_label)} ${esc(p.time)}`)
    .join(' · ');
  const warns = (plan.warnings ?? [])
    .map((w) => `<span class="warn2">שים לב: ${esc(w)}</span>`).join('<br>');

  $('#uWhatIf').innerHTML = `<b>מה יקרה:</b>
    ${lines ? `ישובץ: ${lines}<br>` : ''}
    שום פרסום מתוכנן לא זז<br>${warns}`;
  $('#uOk').disabled = !plan.ok;
}

async function commitUrgent() {
  const res = await api('/urgent/commit', { method: 'POST', body: urgentBody() });
  $('#urgentDlg').close();
  toast(res.pending
    ? 'נשלח לאישור — מופיע במשימות.'
    : `שובץ ב-${res.posts.length} ערוצים. הלוח עודכן.`);
  await Promise.all([renderBoard(), refreshTaskBadge()]);
}

/* ========================= מנוע השיבוץ ========================= */

function wireEngineDialog() {
  $('#eCancel').addEventListener('click', () => $('#engineDlg').close());
  $('#eApply').addEventListener('click', run(async () => {
    const res = await api('/engine/apply', { method: 'POST', body: { week: state.week } });
    $('#engineDlg').close();
    toast(`שובצו ${res.placed} פרסומים${res.holes ? ` · ${res.holes} חורים סומנו` : ''}.`);
    await Promise.all([renderBoard(), refreshTaskBadge()]);
  }));
}

async function openEngine() {
  $('#enginePlan').innerHTML = '<div class="empty">מחשב…</div>';
  $('#eApply').disabled = true;
  $('#engineDlg').showModal();

  const plan = await api('/engine/plan', { method: 'POST', body: { week: state.week } });

  const placed = plan.placements.map((p) => `
    <div class="camp"><div class="crow">
      <span class="sw" style="width:9px;height:9px;border-radius:3px;background:${KIND_VAR[p.kind]}"></span>
      <b>${esc(p.title)}</b>
      <span class="d">${esc(p.channel_name)} · ${esc(p.day_label)} ${esc(p.time)}</span>
    </div>
    <div class="d" style="margin-top:4px">${esc(p.reason)}</div></div>`).join('');

  const holes = plan.holes.map((h) => `
    <div class="camp" style="border-color:var(--st-crit)"><div class="crow">
      <b style="color:var(--st-crit)">מחכה לתוכן — ${esc(h.endpoint_name)}</b>
      <span class="d">${esc(h.channel_name)} · ${esc(h.day_label)}</span>
    </div>
    <div class="d" style="margin-top:4px">${esc(h.reason)}${
      h.days_since === null ? '' : ` · ${h.days_since} ימים בלי פרסום`}</div></div>`).join('');

  const notes = (plan.notes ?? []).map((n) => `<div class="d">${esc(n)}</div>`).join('');
  const r = plan.ratio;
  const ratioLine = r
    ? `<div class="sumline" style="margin:10px 0 0">אחרי השיבוץ: <b>${r.counts.promo} מכירתיים</b> ·
       <b>${r.counts.value} ערך</b> · <b>${r.counts.hybrid} משולב</b>${
         r.value_per_promo === null ? ''
           : ` — יחס ${r.value_per_promo} ערך למכירתי (מינימום ${r.minRatio})`}</div>`
    : '';

  $('#enginePlan').innerHTML = `
    <p class="sub" style="color:var(--muted);font-size:12.5px;margin-bottom:12px">
      ${esc(plan.week.label)} — המנוע ממלא רק שטח פנוי. שום דבר שכבר על הלוח לא יזוז.</p>

    ${plan.placements.length ? `<div class="subsec"><h4>ישובצו (${plan.placements.length})</h4>${placed}</div>` : ''}
    ${plan.holes.length ? `<div class="subsec"><h4>יסומנו כחורים (${plan.holes.length})</h4>${holes}</div>` : ''}
    ${ratioLine}
    ${notes ? `<div class="whatif">${notes}</div>` : ''}
    ${!plan.placements.length && !plan.holes.length
      ? '<div class="empty">אין מה לשבץ — הלוח מלא, או שאין תוכן מוכן שמתאים לשטח שנשאר.</div>' : ''}`;

  $('#eApply').disabled = plan.placements.length === 0 && plan.holes.length === 0;
}

/* ========================= קמפיינים ========================= */

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                   'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

const TONE_CLASS = { good: 'on', warn: '', bad: 'bad', muted: '' };

async function renderCampaigns() {
  const data = await api('/campaigns');
  state.campaigns = data.campaigns;

  const running = data.campaigns.filter((c) => c.phase === 'running');
  const upcoming = data.campaigns.filter((c) => c.phase === 'upcoming');
  const rest = data.campaigns.filter((c) => c.phase === 'ended' || c.phase === 'inactive');

  $('#campaigns').innerHTML = `
    <div class="toolbar">
      <div class="legend">
        <span><b>${running.length}</b> רצים</span>
        <span>·</span>
        <span><b>${upcoming.length}</b> מתוכננים</span>
        <span>·</span>
        <span><b>${rest.length}</b> הסתיימו</span>
      </div>
      <div class="spacer"></div>
      ${can('settings') ? '<button class="btn primary" id="addCampaign">＋ קמפיין חדש</button>' : ''}
    </div>

    <div class="panel" style="margin-bottom:16px">${timeline(data)}</div>

    ${group('רצים עכשיו', running)}
    ${group('מתוכננים', upcoming)}
    ${rest.length ? group('הסתיימו', rest) : ''}

    <div class="panel" style="max-width:640px;margin-top:16px">${allocPanel(data.allocation)}</div>`;

  wireCampaigns();

  function group(title, list) {
    if (!list.length) return '';
    return `<div class="setgroup" style="max-width:none">
      <h2>${esc(title)}</h2>
      <div class="panel">${list.map(campaignItem).join('')}</div>
    </div>`;
  }
}

function campaignItem(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';

  // רק ההתקדמות בפועל נצבעת. שכבת "יעד" ברוחב מלא הייתה נקראת כפס מלא.
  const bar = c.required
    ? `<div class="abar" style="max-width:180px" data-tt="${c.placed} מתוך ${c.required} שובצו">
         <div class="actual" style="width:${Math.min(100, Math.round((c.placed / c.required) * 100))}%"></div>
       </div>`
    : '';

  const content = c.content.length
    ? c.content.map((x) => contentLine(x, c)).join('')
    : '<div class="empty" style="padding:8px 0">אין תוכן משויך לקמפיין הזה.</div>';

  const paceNote = c.pace
    ? `<div class="sumline" style="margin-top:8px">לפי התדירות היו אמורים לצאת עד עכשיו
       <b>${c.pace.expected_by_now}</b> · יצאו <b>${c.pace.published}</b>${
         c.pace.behind > 0 ? ` <span class="off">⚠ מפגר ב-${c.pace.behind}</span>` : ' <span class="ok">✓</span>'}</div>`
    : '';

  return `<details class="item" data-campaign="${c.id}">
    <summary>
      <b>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</b>
      <span class="info">${esc(c.endpoint_name)} · ${esc(range)} · כל ${c.cadence_days} ימים</span>
      ${bar}
      <span class="chip ${TONE_CLASS[c.status.tone]}">${esc(c.status.label)}</span>
    </summary>
    <div class="ibody">
      ${c.goal ? `<p class="sub" style="color:var(--muted);font-size:12.5px;margin-bottom:10px">${esc(c.goal)}</p>` : ''}

      <div class="prow"><label>נדרש</label><span>${c.required ?? '—'} פוסטים${
        c.target_posts != null ? ' (נקבע ידנית)' : ` (נגזר: כל ${c.cadence_days} ימים)`}</span></div>
      <div class="prow"><label>יש תוכן</label><span>${c.content_count}${
        c.missing_content ? ` <span class="off">— חסרים ${c.missing_content}</span>` : ' <span class="ok">✓</span>'}</span></div>
      <div class="prow"><label>שובץ / פורסם</label><span>${c.scheduled} משובצים · ${c.published} פורסמו</span></div>
      <div class="prow"><label>נתח מהשטח</label><span>${c.share_pct != null ? c.share_pct + '%' : '—'}</span></div>
      <div class="prow"><label>חשיבות</label><span>${c.importance}</span></div>
      ${paceNote}

      <div class="subsec">
        <h4>תוכן הקמפיין — לפי סדר הפרסום</h4>
        ${content}
        ${can('content') ? `<button class="btn small primary" data-add-campaign-content="${c.id}">＋ הוסף תוכן לקמפיין</button>` : ''}
      </div>

      ${can('settings') ? `<div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn small" data-edit-campaign="${c.id}">ערוך</button>
        <button class="btn small" data-toggle-campaign="${c.id}" data-active="${c.active}">
          ${c.active ? 'השבת' : 'הפעל'}</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-campaign="${c.id}">מחק</button>
      </div>` : ''}
    </div>
  </details>`;
}

function contentLine(x, c) {
  const placed = x.posts.length;
  const where = placed
    ? x.posts.map((p) => `${esc(p.channel_name ?? '')} ${p.scheduled_at ? fmtDate(p.scheduled_at) : ''}`).join(' · ')
    : 'עוד לא שובץ';

  const move = can('content')
    ? `<span style="margin-inline-start:auto;display:flex;gap:4px">
         <button class="btn small" data-move="up" data-content="${x.id}" data-campaign="${c.id}">↑</button>
         <button class="btn small" data-move="down" data-content="${x.id}" data-campaign="${c.id}">↓</button>
       </span>`
    : '';

  return `<div class="contentline">
    <span class="sw" style="background:${KIND_VAR[x.kind]}"></span>
    <b>${x.sort_order}.</b> ${esc(x.title)}
    <span style="color:var(--muted)">${placed ? '— ' + where : '— ' + where}</span>
    ${move}</div>`;
}

/** ציר זמן של הקמפיינים. החליף את הגאנט של מסך האסטרטגיה. */
function timeline(data) {
  const dated = data.campaigns.filter((c) => c.starts_on && c.ends_on && c.active);
  if (!dated.length) return '<div class="empty">אין קמפיינים עם תאריכים.</div>';

  const base = new Date(dated.map((c) => c.starts_on).sort()[0] + 'T00:00:00');
  base.setDate(1);
  const monthOffset = (d) => {
    const x = new Date(d + 'T00:00:00');
    return (x.getFullYear() - base.getFullYear()) * 12 + (x.getMonth() - base.getMonth());
  };

  const head = Array.from({ length: 6 }, (_, i) => {
    const m = new Date(base.getFullYear(), base.getMonth() + i, 1);
    return `<span>${HE_MONTHS[m.getMonth()]}</span>`;
  }).join('');

  // שורה לכל נקודת קצה, עם כל הקמפיינים שלה עליה
  const byEndpoint = new Map();
  for (const c of dated) {
    if (!byEndpoint.has(c.endpoint_id)) byEndpoint.set(c.endpoint_id, []);
    byEndpoint.get(c.endpoint_id).push(c);
  }

  const rows = [...byEndpoint.values()].map((items) => {
    const bars = items.map((c) => {
      const from = Math.max(0, monthOffset(c.starts_on));
      const to = Math.min(6, monthOffset(c.ends_on) + 1);
      if (to <= from) return '';
      const soft = c.status.key === 'missing_content' ? ' soft' : '';
      const tip = `${c.name} · ${c.status.label}${c.share_pct != null ? ` · נתח ${c.share_pct}%` : ''}`;
      return `<div class="gbar${soft}" style="grid-column:${from + 2}/${to + 2}" data-tt="${esc(tip)}">
        ${esc(c.name)}${c.share_pct != null ? ` · <span class="pct">${c.share_pct}%</span>` : ''}</div>`;
    }).join('');

    const marks = data.milestones
      .filter((m) => m.endpoint_id === items[0].endpoint_id)
      .map((m) => {
        const off = monthOffset(m.on_date);
        if (off < 0 || off > 5) return '';
        return `<div class="gmark" style="grid-column:${off + 2}/${off + 3}"
          data-tt="אבן דרך: ${esc(m.label)}">◆ ${esc(m.label)} ${fmtDate(m.on_date)}</div>`;
      }).join('');

    return `<div class="grow">
      <div class="gname">${esc(items[0].endpoint_name)}
        <span class="d">חשיבות ${items[0].endpoint_importance}</span></div>
      ${bars}${marks}</div>`;
  }).join('');

  return `<div class="gantt">
    <div class="grow head"><span class="gname"></span>${head}</div>${rows}</div>`;
}

function allocPanel(alloc) {
  if (!alloc?.window || !alloc.rows.length) {
    return '<div class="alloc"><div class="empty">אין קמפיינים רצים עם נתח מוגדר.</div></div>';
  }
  const rows = alloc.rows.map((r) => `
    <div class="arow">
      <span class="an">${esc(r.endpoint_name)}</span>
      <div class="abar">
        <div class="target" style="width:${r.target_pct}%"></div>
        <div class="actual" style="width:${r.actual_pct}%"></div>
      </div>
      <span class="at">נתח ${r.target_pct}% · בפועל ${r.actual_pct}%
        ${r.lagging ? '<span class="off">⚠ מפגר</span>' : '<span class="ok">✓</span>'}</span>
    </div>`).join('');

  return `<div class="alloc">
    <h4>חלוקת השטח בפועל — ${fmtDate(alloc.window.from)} עד היום</h4>
    ${rows}
    <p class="sumline" style="margin-top:10px">נמדד על ${alloc.window.total_published} פרסומים שיצאו בתקופה.</p>
  </div>`;
}

function wireCampaigns() {
  const reload = run(async () => { await renderCampaigns(); await refreshAlerts(); });

  $('#addCampaign')?.addEventListener('click', () => openCampaignForm(null, reload));

  $$('#campaigns [data-edit-campaign]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.editCampaign));
      openCampaignForm(c, reload);
    }));

  $$('#campaigns [data-toggle-campaign]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/campaigns/${b.dataset.toggleCampaign}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true' } });
      await reload();
    })));

  $$('#campaigns [data-del-campaign]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את הקמפיין? התוכן שלו יישאר, רק ינותק ממנו.')) return;
      await api(`/campaigns/${b.dataset.delCampaign}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#campaigns [data-add-campaign-content]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.addCampaignContent));
      openContentForm({ campaign: c }, reload);
    }));

  $$('#campaigns [data-move]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const campaignId = Number(b.dataset.campaign);
      const c = state.campaigns.find((x) => x.id === campaignId);
      const ids = c.content.map((x) => x.id);
      const i = ids.indexOf(Number(b.dataset.content));
      const j = b.dataset.move === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api(`/campaigns/${campaignId}/order`, { method: 'PATCH', body: { content_ids: ids } });
      await reload();
    })));
}

function openCampaignForm(campaign, reload) {
  openGeneric({
    title: campaign ? 'עריכת קמפיין' : 'קמפיין חדש',
    fields: [
      { name: 'name', label: 'שם הקמפיין', type: 'text', value: campaign?.name },
      { name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]), value: campaign?.endpoint_id },
      { name: 'goal', label: 'מה המטרה', type: 'text', value: campaign?.goal },
      { name: 'starts_on', label: 'מתאריך', type: 'date', value: campaign?.starts_on },
      { name: 'ends_on', label: 'עד תאריך', type: 'date', value: campaign?.ends_on },
      { name: 'cadence_days', label: 'לפרסם כל כמה ימים', type: 'number',
        value: campaign?.cadence_days ?? 7 },
      { name: 'target_posts', label: 'מספר פוסטים (ריק = נגזר מהתדירות)', type: 'number',
        value: campaign?.target_posts },
      { name: 'share_pct', label: 'נתח מהשטח באחוזים (אופציונלי)', type: 'number',
        value: campaign?.share_pct },
      { name: 'importance', label: 'חשיבות (1–10)', type: 'number',
        value: campaign?.importance ?? 5 },
      { name: 'urgent', label: 'קמפיין דחוף', type: 'checkbox', value: campaign?.urgent },
    ],
    onSave: async (v) => {
      if (campaign) await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
      else await api('/campaigns', { method: 'POST', body: v });
      await reload();
    },
  });
}

/* ========================= תוכן ========================= */

const SLOT_STATE = {
  empty:     { label: 'ריקה',   tone: 'bad'  },
  ready:     { label: 'מוכן',   tone: 'warn' },
  scheduled: { label: 'משובץ',  tone: 'good' },
  published: { label: 'פורסם',  tone: 'good' },
};

const isImage = (mime) => typeof mime === 'string' && mime.startsWith('image/');
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

async function renderContent() {
  const [{ campaigns }, { content }] = await Promise.all([
    api('/campaigns'), api('/content'),
  ]);
  state.campaigns = campaigns;

  // ברירת מחדל: הקמפיין הרץ שהכי חסר לו תוכן
  if (!state.selectedCampaign || !campaigns.some((c) => c.id === state.selectedCampaign)) {
    const running = campaigns.filter((c) => c.phase === 'running');
    const pick = [...(running.length ? running : campaigns)]
      .sort((a, b) => b.missing_content - a.missing_content)[0];
    state.selectedCampaign = pick?.id ?? null;
  }

  const selected = campaigns.find((c) => c.id === state.selectedCampaign) ?? null;
  const loose = content.filter((c) => !c.campaign_id);

  $('#content').innerHTML = `
    ${campaignPicker(campaigns, selected)}
    ${selected ? campaignBoard(selected) : '<div class="empty">אין קמפיינים. פותחים אחד בטאב "קמפיינים".</div>'}
    ${looseSection(loose)}`;

  wireContent(selected);
}

function campaignPicker(campaigns, selected) {
  if (!campaigns.length) return '';
  const chip = (c) => {
    const on = selected && c.id === selected.id;
    const missing = c.missing_content;
    return `<button class="cpick${on ? ' on' : ''}" data-pick="${c.id}">
      <span class="nm">${c.urgent ? '⚡ ' : ''}${esc(c.name)}</span>
      <span class="sub">${esc(c.endpoint_name)}</span>
      <span class="chip ${missing ? 'bad' : 'on'}">${
        missing ? `חסרים ${missing}` : 'מלא'}</span>
    </button>`;
  };
  return `<div class="cpicker">${campaigns.map(chip).join('')}</div>`;
}

function campaignBoard(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';

  if (!c.slots.length) {
    return `<div class="panel"><div class="empty">
      לקמפיין הזה אין תאריכים, ולכן אין ציר זמן. מוסיפים תאריכים בטאב "קמפיינים".
    </div></div>`;
  }

  const filled = c.slots.filter((s) => s.content).length;

  return `
    <div class="cbhead">
      <div>
        <h2>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</h2>
        <p class="sub">${esc(c.endpoint_name)} · ${esc(range)} · פרסום כל ${c.cadence_days} ימים
          ${c.goal ? `· ${esc(c.goal)}` : ''}</p>
      </div>
      <div class="spacer"></div>
      <div class="fill">
        <b>${filled}</b> מתוך <b>${c.slots.length}</b> משבצות מלאות
        ${c.missing_content ? `<span class="off">— חסרים ${c.missing_content}</span>`
                            : '<span class="ok">✓</span>'}
      </div>
    </div>

    ${can('content') ? `<div class="bulk" id="bulkZone">
      <div>
        <b>העלאה מרוכזת</b>
        <span>בוחרים כמה קבצים בבת אחת, והמערכת מפזרת אותם למשבצות הריקות לפי הסדר.</span>
      </div>
      <div class="spacer"></div>
      <select id="bulkKind">
        <option value="value">ערך</option>
        <option value="hybrid">משולב</option>
        <option value="promo">מכירתי</option>
      </select>
      <button class="btn primary" id="bulkPick">בחר קבצים</button>
      <input type="file" id="bulkInput" multiple hidden>
    </div>` : ''}

    <div class="track">${c.slots.map((s) => slotCard(s, c)).join('')}</div>`;
}

function slotCard(s, c) {
  const st = SLOT_STATE[s.state];
  const item = s.content;

  if (!item) {
    return `<div class="slot empty${s.past ? ' past' : ''}" ${
      can('content') ? `data-fill="${s.index}"` : ''}>
      <div class="shead"><b>${s.index}</b><span>${fmtDate(s.date)}</span></div>
      <div class="sbody">
        <span class="plus">＋</span>
        <span class="lbl">${s.past ? 'משבצת שעברה וריקה' : 'ריקה — הוסף תוכן'}</span>
      </div>
    </div>`;
  }

  const img = item.assets.find((a) => isImage(a.mime));
  const files = item.assets.filter((a) => !isImage(a.mime));
  const where = item.posts.length
    ? item.posts.map((p) => esc(p.channel_name ?? '')).join(', ')
    : 'עוד לא שובץ ללוח';

  return `<div class="slot ${item.kind}" data-open="${item.id}">
    <div class="shead"><b>${s.index}</b><span>${fmtDate(s.date)}</span>
      <span class="chip ${TONE_CLASS[st.tone]}">${st.label}</span></div>
    <div class="sbody">
      ${img ? `<img class="thumb" src="/api/assets/${img.id}" alt="">`
            : `<div class="thumb none" style="background:${KIND_VAR[item.kind]}22;
                 border-color:${KIND_VAR[item.kind]}">${esc(KIND_HE[item.kind])}</div>`}
      <b class="ttl">${esc(item.title)}</b>
      <span class="lbl">${esc(where)}</span>
      ${item.evergreen ? '<span class="lbl ever">♻ evergreen</span>' : ''}
      ${files.length ? `<span class="lbl">📎 ${files.length} קבצים</span>` : ''}
    </div>
  </div>`;
}

function looseSection(loose) {
  if (!loose.length) return '';
  const row = (c) => `
    <div class="contentline" style="padding:9px 16px;border-bottom:1px solid var(--border)">
      <span class="sw" style="background:${KIND_VAR[c.kind]}"></span>
      <b>${esc(c.title)}</b>
      <span style="color:var(--muted)">${esc(c.endpoint_name)}</span>
      ${c.evergreen ? '<span class="chip ever">♻ evergreen</span>'
                    : '<span class="chip">חד-פעמי</span>'}
      <span class="chip ${c.placements ? 'on' : ''}">${
        c.placements ? `שובץ ${c.placements}×` : 'לא שובץ'}</span>
      ${can('content') ? `<span style="margin-inline-start:auto;display:flex;gap:6px">
        <button class="btn small" data-edit-loose="${c.id}">ערוך</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-loose="${c.id}">מחק</button>
      </span>` : ''}
    </div>`;

  return `<div class="setgroup" style="max-width:none;margin-top:24px">
    <h2>תוכן שוטף</h2>
    <p class="sub">לא משויך לאף קמפיין. אפשר לשייך מתוך העריכה.</p>
    <div class="panel">${loose.map(row).join('')}</div>
  </div>`;
}

function wireContent(selected) {
  const reload = run(async () => { await renderContent(); await refreshAlerts(); });

  $$('#content [data-pick]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      state.selectedCampaign = Number(b.dataset.pick);
      await renderContent();
    })));

  $$('#content [data-fill]').forEach((b) =>
    b.addEventListener('click', () =>
      openContentForm({ campaign: selected, slot: Number(b.dataset.fill) }, reload)));

  $$('#content [data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = selected.content.find((x) => x.id === Number(b.dataset.open));
      openContentForm({ item, campaign: selected }, reload);
    }));

  $$('#content [data-edit-loose]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const { content } = await api('/content');
      openContentForm({ item: content.find((x) => x.id === Number(b.dataset.editLoose)) }, reload);
    })));

  $$('#content [data-del-loose]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את התוכן?')) return;
      await api(`/content/${b.dataset.delLoose}`, { method: 'DELETE' });
      await reload();
    })));

  // העלאה מרוכזת
  const input = $('#bulkInput');
  $('#bulkPick')?.addEventListener('click', () => input.click());
  input?.addEventListener('change', run(async () => {
    if (!input.files?.length) return;
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f);
    fd.append('kind', $('#bulkKind').value);

    toast(`מעלה ${input.files.length} קבצים…`);
    const res = await fetch(`/api/campaigns/${selected.id}/bulk`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ההעלאה נכשלה');

    toast(`נוצרו ${data.created.length} פריטים${
      data.overflow ? ` · ${data.overflow} מעבר למשבצות הקמפיין` : ''}.`);
    input.value = '';
    await reload();
  }));
}

/**
 * טופס תוכן. משמש גם למילוי משבצת (slot נתון), גם לעריכה,
 * וגם ליצירה חופשית. הקבצים נשלחים בנפרד אחרי שהפריט נשמר.
 */
function openContentForm({ item, campaign, slot }, reload) {
  const campaignOptions = [['', 'ללא קמפיין — תוכן שוטף'],
    ...state.campaigns.map((c) => [c.id, c.name])];

  const existingFiles = (item?.assets ?? []).map((a) => `
    <div class="fileline">
      ${isImage(a.mime) ? `<img src="/api/assets/${a.id}" alt="">` : '<span class="ic">📄</span>'}
      <a href="/api/assets/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
      <span class="d">${kb(a.size_bytes)}</span>
      <button type="button" class="btn small" data-del-asset="${a.id}"
              style="color:var(--st-crit);margin-inline-start:auto">הסר</button>
    </div>`).join('');

  openGeneric({
    title: item ? 'עריכת תוכן' : (slot ? `מילוי משבצת ${slot}` : 'תוכן חדש'),
    fields: [
      { name: 'title', label: 'כותרת', type: 'text', value: item?.title },
      { name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]),
        value: item?.endpoint_id ?? campaign?.endpoint_id },
      { name: 'campaign_id', label: 'קמפיין', type: 'select', options: campaignOptions,
        value: item?.campaign_id ?? campaign?.id ?? '' },
      { name: 'kind', label: 'סוג', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']],
        value: item?.kind },
      { name: 'body', label: 'הטקסט לפרסום', type: 'textarea', value: item?.body },
      { name: 'ready_channel_ids', label: 'מוכן לערוצים', type: 'multicheck',
        options: state.channels.map((c) => [c.id, c.name]),
        value: item?.ready_channel_ids },
      { name: 'evergreen', label: 'Evergreen — אפשר לפרסם שוב ושוב', type: 'checkbox',
        value: item?.evergreen },
      { name: 'reuse_after_days', label: 'מרווח בין חזרות (ימים) — ריק = ברירת המחדל של המנוע',
        type: 'number', value: item?.reuse_after_days },
      { name: '__files', label: 'תמונות ומסמכים', type: 'files', existing: existingFiles },
    ],
    extraActions: item && can('content')
      ? `<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק תוכן</button>`
      : '',
    onSave: async (v) => {
      const body = { ...v };
      delete body.__files;
      if (slot) body.sort_order = slot;

      const saved = item
        ? (await api(`/content/${item.id}`, { method: 'PATCH', body })).content
        : (await api('/content', { method: 'POST', body })).content;

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        const fd = new FormData();
        for (const f of picked) fd.append('files', f);
        const res = await fetch(`/api/content/${saved.id}/assets`, { method: 'POST', body: fd });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || 'הקבצים לא נשמרו');
        }
      }
      await reload();
    },
    onOpen: () => {
      $$('#genBody [data-del-asset]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/assets/${b.dataset.delAsset}`, { method: 'DELETE' });
          b.closest('.fileline').remove();
          toast('הקובץ הוסר.');
        })));

      $('#genDelete')?.addEventListener('click', run(async () => {
        if (!confirm('למחוק את התוכן והקבצים שלו?')) return;
        await api(`/content/${item.id}`, { method: 'DELETE' });
        $('#genDlg').close();
        await reload();
      }));
    },
  });
}

const fmtDate = (d) => {
  const x = new Date(typeof d === 'string' && d.length === 10 ? d + 'T00:00:00' : d);
  return `${x.getDate()}.${x.getMonth() + 1}`;
};

/* ========================= דיאלוג כללי ========================= */

let genSpec = null;

function wireGenericDialog() {
  $('#genCancel').addEventListener('click', () => $('#genDlg').close());
  $('#genSave').addEventListener('click', run(async () => {
    const values = {};
    for (const f of genSpec.fields) {
      if (f.type === 'files') continue; // קבצים נשלחים בנפרד ב-onSave
      const el = $(`#gen_${f.name}`);
      if (f.type === 'checkbox') values[f.name] = el.checked;
      else if (f.type === 'multicheck') {
        values[f.name] = $$(`[data-multi="${f.name}"]:checked`).map((i) => Number(i.value));
      } else if (f.type === 'number') {
        values[f.name] = el.value === '' ? null : Number(el.value);
      } else if (f.type === 'select') {
        const v = el.value;
        // בחירה של ישות מחזירה מזהה מספרי, בחירה של סוג מחזירה מחרוזת
        values[f.name] = v === '' ? null : (/^\d+$/.test(v) ? Number(v) : v);
      } else {
        values[f.name] = el.value.trim() === '' ? null : el.value.trim();
      }
    }
    const btn = $('#genSave');
    btn.disabled = true;
    try {
      await genSpec.onSave(values);
      $('#genDlg').close();
      toast('נשמר.');
    } finally {
      btn.disabled = false;
    }
  }));
}

function openGeneric(spec) {
  genSpec = spec;
  $('#genTitle').textContent = spec.title;
  $('#genBody').innerHTML = spec.fields.map((f) => {
    const id = `gen_${f.name}`;
    if (f.type === 'checkbox') {
      return `<div class="frow"><div class="checks"><label>
        <input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}> ${esc(f.label)}
      </label></div></div>`;
    }
    if (f.type === 'multicheck') {
      const chosen = new Set((f.value ?? []).map(Number));
      return `<div class="frow"><label>${esc(f.label)}</label><div class="checks">
        ${f.options.map(([v, l]) =>
          `<label><input type="checkbox" data-multi="${f.name}" value="${v}"${
            chosen.has(Number(v)) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}
      </div></div>`;
    }
    if (f.type === 'select') {
      const cur = f.value ?? '';
      return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
        <select id="${id}">${f.options.map(([v, l]) =>
          `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`
        ).join('')}</select></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
        <textarea id="${id}">${esc(f.value ?? '')}</textarea></div>`;
    }
    if (f.type === 'files') {
      return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
        ${f.existing ?? ''}
        <input id="${id}" type="file" multiple>
        <span class="d" style="color:var(--muted);font-size:11.5px">עד 10MB לקובץ</span>
      </div>`;
    }
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      <input id="${id}" type="${f.type}" value="${esc(f.value ?? '')}"></div>`;
  }).join('');

  // כפתורים נוספים (למשל "מחק תוכן") נשתלים משמאל לביטול/שמירה
  $('#genExtra').innerHTML = spec.extraActions ?? '';
  spec.onOpen?.();

  $('#genDlg').showModal();
}

/* ========================= משימות ========================= */

async function renderTasks() {
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

  $$('#tasks [data-goto]').forEach((b) =>
    b.addEventListener('click', run(() => showTab(b.dataset.goto))));

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
      await Promise.all([renderTasks(), refreshTaskBadge(), renderBoard()]);
    })));

  $$('#tasks [data-publish]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/posts/${b.dataset.publish}/publish`, { method: 'POST' });
      toast('סומן כפורסם.');
      await Promise.all([renderTasks(), refreshTaskBadge(), renderBoard()]);
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
      <button class="btn small act" data-goto="${esc(a.tab)}">פתח</button>
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
  }

  return `<div class="task${t.urgent && !t.done ? ' urgent' : ''}"${t.done ? ' style="opacity:.5"' : ''}>
    <input type="checkbox" data-task-done="${t.id}" ${t.done ? 'checked' : ''}>
    <div class="tx"><b>${esc(t.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${action}</div>`;
}
