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

const state = {
  me: null,
  week: null,          // תאריך עוגן לשבוע המוצג
  channels: [],
  endpoints: [],
  users: [],
  strategyPeriod: 'half',
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

  await Promise.all([renderBoard(), refreshTaskBadge()]);
}

function wireChrome() {
  $$('.tab').forEach((t) => t.addEventListener('click', run(async () => {
    state.tab = t.dataset.t;
    $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    for (const key of ['board', 'strategy', 'manage', 'tasks']) {
      $(`#${key}`).hidden = key !== state.tab;
    }
    if (state.tab === 'board') await renderBoard();
    if (state.tab === 'strategy') await renderStrategy();
    if (state.tab === 'manage') await renderManage();
    if (state.tab === 'tasks') await renderTasks();
  })));

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

/* ========================= אסטרטגיה ========================= */

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
                   'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

async function renderStrategy() {
  const data = await api(`/strategy?period=${state.strategyPeriod}`);
  const periods = [['quarter', 'רבעון'], ['half', 'חצי שנה'], ['year', 'שנה']];

  const picker = periods.map(([k, label]) =>
    `<button data-period="${k}" class="${k === state.strategyPeriod ? 'on' : ''}">${label}</button>`
  ).join('');

  $('#strategy').innerHTML = `
    <div class="toolbar">
      <div class="periodpick">${picker}</div>
      <div class="spacer"></div>
      ${can('settings') ? '<button class="btn primary" id="addAlloc">＋ הגדר אסטרטגיה לתקופה</button>' : ''}
    </div>
    <div class="panel" style="margin-bottom:16px">${gantt(data)}</div>
    <div class="panel" style="max-width:640px">${allocPanel(data.current)}</div>`;

  $$('#strategy [data-period]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      state.strategyPeriod = b.dataset.period;
      await renderStrategy();
    })));

  $('#addAlloc')?.addEventListener('click', () => openAllocDialog());
}

function gantt(data) {
  const allocs = data.allocations;
  if (allocs.length === 0) {
    return '<div class="empty">עוד לא הוגדרה אסטרטגיה לתקופה הזו.</div>';
  }

  // חלון של 6 חודשים שמתחיל בחודש המוקדם ביותר שהוגדר
  const starts = allocs.map((a) => new Date(a.starts_on));
  const first = new Date(Math.min(...starts));
  const base = new Date(first.getFullYear(), first.getMonth(), 1);
  const monthOffset = (d) => {
    const x = new Date(d);
    return (x.getFullYear() - base.getFullYear()) * 12 + (x.getMonth() - base.getMonth());
  };

  const headCells = Array.from({ length: 6 }, (_, i) => {
    const m = new Date(base.getFullYear(), base.getMonth() + i, 1);
    return `<span>${HE_MONTHS[m.getMonth()]}</span>`;
  }).join('');

  // שורה לכל נקודת קצה שיש לה הקצאה
  const byEndpoint = new Map();
  for (const a of allocs) {
    if (!byEndpoint.has(a.endpoint_id)) byEndpoint.set(a.endpoint_id, []);
    byEndpoint.get(a.endpoint_id).push(a);
  }

  const rows = [...byEndpoint.entries()].map(([endpointId, items]) => {
    const ep = state.endpoints.find((e) => e.id === endpointId);
    const bars = items.map((a) => {
      const from = Math.max(0, monthOffset(a.starts_on));
      const to = Math.min(6, monthOffset(a.ends_on) + 1);
      if (to <= from) return '';
      const tip = `${a.label ?? a.period_label} · יעד: ${a.target_pct}% מהשטח`;
      const del = can('settings')
        ? ` <button class="btn small" data-del-alloc="${a.id}" style="padding:0 5px">×</button>` : '';
      return `<div class="gbar" style="grid-column: ${from + 2} / ${to + 2}" data-tt="${esc(tip)}">
        ${esc(a.label ?? a.period_label)} · <span class="pct">${a.target_pct}%</span>${del}</div>`;
    }).join('');

    const marks = data.milestones
      .filter((m) => m.endpoint_id === endpointId)
      .map((m) => {
        const off = monthOffset(m.on_date);
        if (off < 0 || off > 5) return '';
        const d = new Date(m.on_date);
        return `<div class="gmark" style="grid-column: ${off + 2} / ${off + 3}"
          data-tt="אבן דרך: ${esc(m.label)}">◆ ${esc(m.label)} ${d.getDate()}.${d.getMonth() + 1}</div>`;
      }).join('');

    return `<div class="grow">
      <div class="gname">${esc(ep?.name ?? items[0].endpoint_name)}
        <span class="d">חשיבות ${ep?.importance ?? '—'}</span></div>
      ${bars}${marks}</div>`;
  }).join('');

  return `<div class="gantt">
    <div class="grow head"><span class="gname"></span>${headCells}</div>
    ${rows}</div>`;
}

function allocPanel(current) {
  if (!current?.period) {
    return '<div class="alloc"><div class="empty">אין תקופת אסטרטגיה פעילה כרגע.</div></div>';
  }
  const rows = current.rows.map((r) => `
    <div class="arow">
      <span class="an">${esc(r.endpoint_name)}</span>
      <div class="abar">
        <div class="target" style="width:${r.target_pct}%"></div>
        <div class="actual" style="width:${r.actual_pct}%"></div>
      </div>
      <span class="at">יעד ${r.target_pct}% · בפועל ${r.actual_pct}%
        ${r.lagging ? '<span class="off">⚠ מפגרת</span>' : '<span class="ok">✓</span>'}</span>
    </div>`).join('');

  return `<div class="alloc">
    <h4>התקופה הנוכחית — ${esc(current.period.label)} · חלוקת השטח: יעד מול בפועל</h4>
    ${rows || '<div class="empty">אין עדיין פרסומים בתקופה הזו.</div>'}
    <p class="sumline" style="margin-top:10px">
      "בפועל" נמדד לפי הפרסומים שכבר יצאו בתקופה. פער של יותר מ-8 נקודות אחוז מסומן כפיגור.</p>
  </div>`;
}

/* ========================= ניהול ========================= */

async function renderManage() {
  const [{ endpoints }, { channels }, { settings }, { users }] = await Promise.all([
    api('/endpoints'), api('/channels'), api('/settings'), api('/users'),
  ]);
  state.endpoints = endpoints;
  state.channels = channels;
  state.users = users;

  const ro = !can('settings'); // read-only

  $('#manage').innerHTML = `
    <div class="setgroup">
      <h2>נקודות קצה</h2>
      <p class="sub">כל נקודה מרכזת אצלה הכול: הגדרות, קמפיינים, ותוכן.</p>
      <div class="panel">${endpoints.map((e) => endpointItem(e, channels, ro)).join('')
        || '<div class="empty">אין עדיין נקודות קצה.</div>'}</div>
      ${ro ? '' : '<div style="margin-top:10px"><button class="btn" id="addEndpoint">＋ הוסף נקודת קצה</button></div>'}
    </div>

    <div class="setgroup">
      <h2>ערוצי פרסום</h2>
      <p class="sub">כמה שטח יש בכל ערוץ ומה הכללים שלו.</p>
      <div class="panel">${channels.map((c) => channelItem(c, ro)).join('')
        || '<div class="empty">אין עדיין ערוצים.</div>'}</div>
      ${ro ? '' : '<div style="margin-top:10px"><button class="btn" id="addChannel">＋ הוסף ערוץ</button></div>'}
    </div>

    ${can('users') ? systemGroup(users, settings) : ''}`;

  wireManage(ro);
}

function endpointItem(e, channels, ro) {
  const campaigns = e.campaigns.map((c) => `
    <div class="camp"><div class="crow">
      <b>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</b>
      <span class="d">${esc(campaignRange(c))}${c.share_pct ? ` · ${c.share_pct}% מהשטח` : ''}</span>
      <span class="chip ${c.active ? 'on' : ''}">${c.active ? 'רץ' : 'לא פעיל'}</span>
      ${ro ? '' : `<button class="btn small" data-del-campaign="${c.id}" style="margin-inline-start:auto">מחק</button>`}
    </div></div>`).join('')
    || '<p style="font-size:12.5px;color:var(--muted);margin-bottom:8px">אין קמפיין — חשיפה שוטפת בלבד</p>';

  const content = e.content.map((c) => `
    <div class="contentline">
      <span class="sw" style="background:${KIND_VAR[c.kind]}"></span>
      ${esc(KIND_HE[c.kind])}: <b>${esc(c.title)}</b>
      <span class="d" style="color:var(--muted)">${esc(readyIn(c, channels))}</span>
      ${can('content') ? `<button class="btn small" data-del-content="${c.id}" style="margin-inline-start:auto">מחק</button>` : ''}
    </div>`).join('')
    || '<div class="contentline"><span class="missing">אין תוכן מוכן לנקודה הזו</span></div>';

  const hasContent = e.content.length > 0;

  return `<details class="item">
    <summary>
      <b>${esc(e.name)}</b>
      <span class="info">חשיבות ${e.importance} · ${e.campaigns.length} קמפיינים</span>
      <span class="chip ${hasContent ? 'on' : 'bad'}">${hasContent ? 'פעילה' : 'חסר תוכן'}</span>
    </summary>
    <div class="ibody">
      <div class="prow">
        <label>חשיבות (1–10) — כמה שטח מגיע לה</label>
        <input type="number" min="1" max="10" value="${e.importance}"
               data-ep-field="importance" data-id="${e.id}" ${ro ? 'disabled' : ''}>
      </div>
      <div class="prow">
        <label>לפרסם לפחות פעם ב־ (ימים)</label>
        <input type="number" min="1" value="${e.min_days_between}"
               data-ep-field="min_days_between" data-id="${e.id}" ${ro ? 'disabled' : ''}>
      </div>

      <div class="subsec">
        <h4>קמפיינים</h4>
        ${campaigns}
        ${ro ? '' : `<button class="btn small" data-add-campaign="${e.id}">＋ קמפיין</button>`}
      </div>

      <div class="subsec">
        <h4>תוכן מוכן לפרסום</h4>
        ${content}
        ${can('content') ? `<button class="btn small primary" data-add-content="${e.id}">＋ הוסף תוכן</button>` : ''}
      </div>

      ${ro ? '' : `<div style="margin-top:14px">
        <button class="btn small" style="color:var(--st-crit)" data-del-endpoint="${e.id}">מחק נקודת קצה</button>
      </div>`}
    </div>
  </details>`;
}

const campaignRange = (c) => {
  const f = (d) => (d ? `${new Date(d).getDate()}.${new Date(d).getMonth() + 1}` : '');
  if (c.starts_on && c.ends_on) return `${f(c.starts_on)}–${f(c.ends_on)}`;
  if (c.ends_on) return `עד ${f(c.ends_on)}`;
  return 'ללא תאריכים';
};

const readyIn = (c, channels) => {
  const names = (c.ready_channel_ids ?? [])
    .map((id) => channels.find((ch) => ch.id === id)?.name)
    .filter(Boolean);
  return names.length ? `— מוכן ל${names.join(', ')}` : '— עוד לא סומן לאף ערוץ';
};

function channelItem(c, ro) {
  const num = (label, field, value, note = '') => `
    <div class="prow">
      <label>${note}${label}</label>
      <input type="number" min="0" value="${value ?? ''}" placeholder="ללא"
             data-ch-field="${field}" data-id="${c.id}" ${ro ? 'disabled' : ''}>
    </div>`;
  const sw = (kind) =>
    `<span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:3px;` +
    `background:${KIND_VAR[kind]};margin-inline-end:6px;vertical-align:-1px"></span>`;

  return `<details class="item">
    <summary>
      <b>${esc(c.name)}</b>
      <span class="info">עד ${c.max_per_week} בשבוע</span>
      <span class="chip ${c.active ? 'on' : 'bad'}">${c.active ? 'פעיל' : 'מושבת'}</span>
    </summary>
    <div class="ibody">
      ${num('כמה פוסטים מקסימום בשבוע (סה"כ)', 'max_per_week', c.max_per_week)}
      ${num('מזה — מכירתיים מקסימום', 'max_promo_per_week', c.max_promo_per_week, sw('promo'))}
      ${num('מזה — משולבים מקסימום', 'max_hybrid_per_week', c.max_hybrid_per_week, sw('hybrid'))}
      ${num('מזה — ערך מקסימום', 'max_value_per_week', c.max_value_per_week, sw('value'))}
      ${num('שטח ששמור לדברים דחופים (%)', 'urgent_reserve_pct', c.urgent_reserve_pct)}
      ${ro ? '' : `<div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn small" data-toggle-channel="${c.id}" data-active="${c.active}">
          ${c.active ? 'השבת ערוץ' : 'הפעל ערוץ'}</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-channel="${c.id}">מחק ערוץ</button>
      </div>`}
    </div>
  </details>`;
}

function systemGroup(users, settings) {
  const rows = users.map((u) => {
    const cell = (perm) => u.is_owner
      ? '✓'
      : `<input type="checkbox" data-user="${u.id}" data-perm="${perm}" ${u[`perm_${perm}`] ? 'checked' : ''}>`;
    return `<tr>
      <td><b>${esc(u.name)}</b> ${u.is_owner ? '<span class="owner-tag">בעלים</span>' : ''}
        <div style="color:var(--muted);font-size:11.5px">${esc(u.email)}</div></td>
      <td>${cell('content')}</td><td>${cell('settings')}</td>
      <td>${cell('approve')}</td><td>${cell('users')}</td>
      <td>${u.is_owner ? '' : `<button class="btn small" data-del-user="${u.id}" style="color:var(--st-crit)">מחק</button>`}</td>
    </tr>`;
  }).join('');

  const s = settings;
  const eng = (label, field, value, step = '1') => `
    <div class="prow"><label>${label}</label>
      <input type="number" step="${step}" value="${value}" data-engine="${field}"></div>`;

  return `<div class="setgroup" id="ownerOnly">
    <h2>מערכת</h2>
    <div class="panel">
      <details class="item">
        <summary><b>משתמשים והרשאות</b>
          <span class="info">${users.length} משתמשים</span>
          <span class="owner-tag">בעלים בלבד</span></summary>
        <div class="ibody">
          <table class="utable">
            <thead><tr><th>משתמש</th><th>תוכן ושיבוץ</th><th>הגדרות</th>
              <th>אישור דחוף־דורס</th><th>ניהול משתמשים</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:10px"><button class="btn small primary" id="addUser">＋ הוסף משתמש</button></div>
        </div>
      </details>
      <details class="item">
        <summary><b>מתקדם — כללי המנוע</b><span class="info">נוגעים בזה לעיתים רחוקות</span></summary>
        <div class="ibody">
          ${eng('מרווח מינימלי לאותה נקודה באותו ערוץ (ימים)', 'min_gap_days', s.min_gap_days)}
          ${eng('מקסימום מכירתיים ביום, בכל הערוצים', 'max_promo_per_day', s.max_promo_per_day)}
          ${eng('כמה ערך נדרש על כל מכירתי', 'min_value_per_promo', s.min_value_per_promo, '0.5')}
          ${eng('"משולב" נספר כמכירתי', 'hybrid_weight', s.hybrid_weight, '0.1')}
          ${eng('התראת "מחכה לתוכן" — שעות מראש', 'content_alert_hours', s.content_alert_hours)}
        </div>
      </details>
    </div>
  </div>`;
}

function wireManage(ro) {
  const reload = run(async () => { await renderManage(); await renderBoard(); });

  // עריכת שדה בשדה — נשמר ביציאה מהשדה
  $$('#manage [data-ep-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { [inp.dataset.epField]: Number(inp.value) } });
      toast('נשמר.');
    })));

  $$('#manage [data-ch-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const raw = inp.value.trim();
      await api(`/channels/${inp.dataset.id}`,
        { method: 'PATCH', body: { [inp.dataset.chField]: raw === '' ? null : Number(raw) } });
      toast('נשמר.');
    })));

  $$('#manage [data-engine]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      await api('/settings', { method: 'PATCH', body: { [inp.dataset.engine]: Number(inp.value) } });
      toast('נשמר. הלוח יחושב מחדש.');
    })));

  $$('#manage [data-user][data-perm]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      await api(`/users/${cb.dataset.user}`,
        { method: 'PATCH', body: { [`perm_${cb.dataset.perm}`]: cb.checked } });
      toast('ההרשאה עודכנה.');
    })));

  $$('#manage [data-del-user]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את המשתמש?')) return;
      await api(`/users/${b.dataset.delUser}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#manage [data-del-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את נקודת הקצה? כל הקמפיינים והתוכן שלה יימחקו איתה.')) return;
      await api(`/endpoints/${b.dataset.delEndpoint}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#manage [data-del-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את הערוץ? כל השיבוצים בו יימחקו.')) return;
      await api(`/channels/${b.dataset.delChannel}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#manage [data-toggle-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/channels/${b.dataset.toggleChannel}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true' } });
      await reload();
    })));

  $$('#manage [data-del-campaign]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/campaigns/${b.dataset.delCampaign}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#manage [data-del-content]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/content/${b.dataset.delContent}`, { method: 'DELETE' });
      await reload();
    })));

  $$('#manage [data-add-campaign]').forEach((b) =>
    b.addEventListener('click', () => openCampaignDialog(Number(b.dataset.addCampaign), reload)));

  $$('#manage [data-add-content]').forEach((b) =>
    b.addEventListener('click', () => openContentDialog(Number(b.dataset.addContent), reload)));

  if (!ro) {
    $('#addEndpoint')?.addEventListener('click', () => openGeneric({
      title: 'נקודת קצה חדשה',
      fields: [
        { name: 'name', label: 'שם', type: 'text' },
        { name: 'importance', label: 'חשיבות (1–10)', type: 'number', value: 5 },
        { name: 'min_days_between', label: 'לפרסם לפחות פעם ב־ (ימים)', type: 'number', value: 7 },
      ],
      onSave: async (v) => { await api('/endpoints', { method: 'POST', body: v }); await reload(); },
    }));

    $('#addChannel')?.addEventListener('click', () => openGeneric({
      title: 'ערוץ חדש',
      fields: [
        { name: 'name', label: 'שם הערוץ', type: 'text' },
        { name: 'max_per_week', label: 'מקסימום פרסומים בשבוע', type: 'number', value: 5 },
      ],
      onSave: async (v) => { await api('/channels', { method: 'POST', body: v }); await reload(); },
    }));
  }

  $('#addUser')?.addEventListener('click', () => openGeneric({
    title: 'משתמש חדש',
    fields: [
      { name: 'name', label: 'שם', type: 'text' },
      { name: 'email', label: 'אימייל', type: 'email' },
      { name: 'password', label: 'סיסמה (8 תווים לפחות)', type: 'password' },
      { name: 'perm_content', label: 'תוכן ושיבוץ', type: 'checkbox', value: true },
      { name: 'perm_settings', label: 'הגדרות', type: 'checkbox' },
      { name: 'perm_approve', label: 'אישור דחוף־דורס', type: 'checkbox' },
      { name: 'perm_users', label: 'ניהול משתמשים', type: 'checkbox' },
    ],
    onSave: async (v) => { await api('/users', { method: 'POST', body: v }); await reload(); },
  }));
}

function openCampaignDialog(endpointId, reload) {
  openGeneric({
    title: 'קמפיין חדש',
    fields: [
      { name: 'name', label: 'שם הקמפיין', type: 'text' },
      { name: 'starts_on', label: 'מתאריך', type: 'date' },
      { name: 'ends_on', label: 'עד תאריך', type: 'date' },
      { name: 'share_pct', label: 'אחוז מהשטח (אופציונלי)', type: 'number' },
      { name: 'urgent', label: 'קמפיין דחוף', type: 'checkbox' },
    ],
    onSave: async (v) => {
      await api('/campaigns', { method: 'POST', body: { ...v, endpoint_id: endpointId } });
      await reload();
    },
  });
}

function openContentDialog(endpointId, reload) {
  openGeneric({
    title: 'תוכן חדש',
    fields: [
      { name: 'title', label: 'כותרת', type: 'text' },
      { name: 'kind', label: 'סוג', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']] },
      { name: 'body', label: 'הטקסט לפרסום', type: 'textarea' },
      { name: 'ready_channel_ids', label: 'מוכן לערוצים', type: 'multicheck',
        options: state.channels.map((c) => [c.id, c.name]) },
    ],
    onSave: async (v) => {
      await api('/content', { method: 'POST', body: { ...v, endpoint_id: endpointId } });
      await reload();
    },
  });
}

function openAllocDialog() {
  openGeneric({
    title: 'הגדרת אסטרטגיה לתקופה',
    fields: [
      { name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]) },
      { name: 'period_kind', label: 'סוג תקופה', type: 'select',
        options: [['quarter', 'רבעון'], ['half', 'חצי שנה'], ['year', 'שנה']] },
      { name: 'period_label', label: 'שם התקופה', type: 'text' },
      { name: 'label', label: 'שם הפס בציר (אופציונלי)', type: 'text' },
      { name: 'starts_on', label: 'מתאריך', type: 'date' },
      { name: 'ends_on', label: 'עד תאריך', type: 'date' },
      { name: 'target_pct', label: 'יעד — אחוז מהשטח', type: 'number', value: 30 },
    ],
    onSave: async (v) => {
      await api('/strategy/allocations', { method: 'POST', body: v });
      await renderStrategy();
    },
  });
}

/* ========================= דיאלוג כללי ========================= */

let genSpec = null;

function wireGenericDialog() {
  $('#genCancel').addEventListener('click', () => $('#genDlg').close());
  $('#genSave').addEventListener('click', run(async () => {
    const values = {};
    for (const f of genSpec.fields) {
      const el = $(`#gen_${f.name}`);
      if (f.type === 'checkbox') values[f.name] = el.checked;
      else if (f.type === 'multicheck') {
        values[f.name] = $$(`[data-multi="${f.name}"]:checked`).map((i) => Number(i.value));
      } else if (f.type === 'number') {
        values[f.name] = el.value === '' ? null : Number(el.value);
      } else {
        values[f.name] = el.value.trim() === '' ? null : el.value.trim();
      }
    }
    await genSpec.onSave(values);
    $('#genDlg').close();
    toast('נשמר.');
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
      return `<div class="frow"><label>${esc(f.label)}</label><div class="checks">
        ${f.options.map(([v, l]) =>
          `<label><input type="checkbox" data-multi="${f.name}" value="${v}"> ${esc(l)}</label>`).join('')}
      </div></div>`;
    }
    if (f.type === 'select') {
      return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
        <select id="${id}">${f.options.map(([v, l]) =>
          `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
        <textarea id="${id}"></textarea></div>`;
    }
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      <input id="${id}" type="${f.type}" value="${esc(f.value ?? '')}"></div>`;
  }).join('');
  $('#genDlg').showModal();
}

/* ========================= משימות ========================= */

async function renderTasks() {
  const t = await api('/tasks');

  const group = (title, items, emptyText) => `
    <div class="tgroup">
      <h2>${esc(title)}</h2>
      <div class="panel">${items.map(taskRow).join('') || `<div class="empty">${esc(emptyText)}</div>`}</div>
    </div>`;

  $('#tasks').innerHTML = `<div class="tasks">
    ${group('היום', t.today, 'אין משימות להיום.')}
    ${group('דורש טיפול', t.attention, 'הכול מטופל.')}
    ${group('הושלם השבוע', t.done_this_week, 'עוד לא הושלמו משימות השבוע.')}
  </div>`;

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
