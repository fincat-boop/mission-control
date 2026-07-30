/* Mission Control — הלקוח. כל הנתונים מגיעים מ-/api. */

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
  if (!res.ok) {
    // גוף התשובה נשמר על השגיאה: יש נתיבים שמחזירים אזהרה שאפשר לאשר
    const err = new Error(data.error || 'הפעולה נכשלה');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
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

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/**
 * שיבוץ שהשרת מזהיר עליו כצמוד מדי. האזהרה אינה חסימה: מציגים מה
 * שהשרת יודע ושואלים, ומי שמאשר שולח שוב עם confirm_gap.
 */
async function postWithGapCheck(path, body, method = 'PATCH') {
  try {
    return await api(path, { method, body });
  } catch (e) {
    if (e.status !== 409 || !e.payload?.needs_confirm) throw e;
    const w = e.payload.warning;
    if (!confirm(`${w.message}\n\nלשבץ בכל זאת?`)) return null;
    return api(path, { method, body: { ...body, confirm_gap: true } });
  }
}

function fillSelect(sel, items, labelKey, emptyLabel) {
  sel.innerHTML =
    (emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : '') +
    items.map((i) => `<option value="${i.id}">${esc(i[labelKey])}</option>`).join('');
}

// זיהוי סוג קובץ ותצוגת גודל — בשימוש גם בלוח וגם במסך התוכן
const isImage = (mime) => typeof mime === 'string' && mime.startsWith('image/');
const isVideo = (mime) => typeof mime === 'string' && mime.startsWith('video/');
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const KIND_HE = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };
const KIND_VAR = { promo: 'var(--leg-promo)', value: 'var(--leg-value)', hybrid: 'var(--leg-hybrid)' };

// הקבועים שמשמשים יותר מסעיף אחד יושבים כאן ולא בתוך סעיף,
// כדי ששכתוב של סעיף שלם לא ימחק אותם ממי שעדיין צריך אותם.

/** מצב הקמפיין → מחלקת הצבע של השבב */
const TONE_CLASS = { good: 'on', warn: '', bad: 'bad', muted: '' };

/** מצב תא ברשת התוכן */
const CELL = {
  ready:        { label: 'מוכן',       cls: 'ok'    },
  draft:        { label: 'טיוטה',      cls: 'draft' },
  empty:        { label: 'חסר',        cls: 'gap'   },
  not_relevant: { label: 'לא רלוונטי', cls: 'na'    },
  not_needed:   { label: '',           cls: 'na'    },
};

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
function rebuildEpColors() {
  epColors = new Map();
  [...state.endpoints]
    .sort((a, b) => a.id - b.id)
    .forEach((e, i) => epColors.set(e.id, EP_COLORS[i % EP_COLORS.length]));
}
const epColor = (id) => epColors.get(Number(id)) ?? 'var(--muted)';

/** טקסט כהה או בהיר, לפי בהירות הרקע — צהוב ולבן לא נקראים יחד */
function inkOn(bg) {
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#14161a' : '#fff';
}

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);

/* ========================= מצב ========================= */

const TABS = ['board', 'strategy', 'plan', 'tasks', 'data', 'manage'];

const state = {
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
  rebuildEpColors();
  state.users = users;

  await Promise.all([renderBoard(), refreshTaskBadge(), refreshAlerts()]);
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
  wireAIWidget();
  wireImportDialog();
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

  // רשימה אחת שמשמשת גם כמקרא הצבעים וגם כמצב האוויר של כל נקודה.
  // קודם היו כאן שתי שורות שמציגות את אותן נקודות בשתי מערכות צבע שונות.
  const oxy = b.oxygen.map((o) => {
    const when = o.days_since === null
      ? 'עוד לא פורסם'
      : o.days_since === 0 ? 'פורסם היום'
      : o.days_since === 1 ? 'פורסם אתמול'
      : `${o.days_since} ימים בלי פרסום`;
    const onAir = !o.stale || o.scheduled_this_week > 0;
    const tip = `${o.name} · ${when}` +
                (o.scheduled_this_week ? ` · משובץ ${o.scheduled_this_week} פעמים השבוע`
                                       : ' · לא משובץ השבוע');
    return `<span class="oxychip${onAir ? '' : ' off'}" data-tt="${esc(tip)}">
      <i class="sw" style="background:${epColor(o.endpoint_id)}"></i>${esc(o.name)}
    </span>`;
  }).join('');

  const head = b.week.days.map((d) => `<th>${esc(d.label)}</th>`).join('');

  const body = b.channels.map((ch) => {
    const full = ch.used >= ch.max_per_week;
    const days = ch.days.map((day) => {
      const cards = day.posts.map((p) => postCard(p)).join('');
      // יום חסום לא מקבל גרירה, ומסומן ויזואלית כדי שלא ינסו
      const dow = new Date(`${day.date}T00:00:00`).getDay();
      const blocked = (ch.blocked_days ?? []).includes(dow);
      // אין כאן יצירה ואין עריכה — רק צפייה וגרירה. הפרמטרים נקבעים בתוכן.
      const drop = editable && !blocked
        ? `data-drop-channel="${ch.id}" data-drop-date="${day.date}"` : '';
      return `<td class="day${blocked ? ' blocked' : ''}" ${drop}
        ${blocked ? `data-tt="${esc(ch.name)} לא מקבל תוכן בימי ${HE_DAYS[dow]}"` : ''}
        >${cards}</td>`;
    }).join('');
    return `<tr>
      <td class="chan">
        <div class="cname">${esc(ch.name)}</div>
        <div class="cap${full ? ' full' : ''}">${ch.used} מתוך ${ch.max_per_week} השבוע</div>
      </td>${days}</tr>`;
  }).join('');

  const s = b.summary;
  // min_value_per_promo=0 פירושו שהמשתמש כיבה את הדרישה במפורש — לא
  // משווים כלפיה בכלל, כדי שלא יופיע ⚠ על יחס שהוא בחר לא לאכוף
  const ratio = s.value_per_promo === null
    ? 'אין עדיין פוסטים מכירתיים השבוע'
    : s.min_value_per_promo > 0
      ? `על כל מכירתי יש <b>${s.value_per_promo} פוסטי ערך</b> ${
          s.value_per_promo >= s.min_value_per_promo ? '✓' : '⚠'}`
      : `על כל מכירתי יש <b>${s.value_per_promo} פוסטי ערך</b>`;

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
        <span>הסוג מסומן בתג בכל פוסט · ⚡ דחוף · ✓ פורסם</span>
      </div>
    </div>

    <div class="board panel">
      <table class="grid">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body || `<tr><td class="empty" colspan="8">אין ערוצים פעילים — מוסיפים אותם במסך "ניהול"</td></tr>`}</tbody>
      </table>
    </div>
    <div class="sumline">השבוע: <b>${s.total} פרסומים</b> · מהם <b>${s.promo} מכירתיים</b> · ${ratio}</div>
    ${b.held?.length ? `<div class="sumline held">⏸ מוסתרים בגלל השהיה:
      ${b.held.map((h) => `<b>${esc(h.name)}</b> (${h.n})`).join(' · ')}
      — חוזרים ללוח כשמפעילים את הקמפיין</div>` : ''}`;

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

  // לחיצה מציגה את הפוסט כפי שהוא ייצא. גם למי שאין לו הרשאת עריכה.
  $$('#board [data-post-id]').forEach((el) =>
    el.addEventListener('click', run(() => openPostPreview(el.dataset.postId))));

  // כפתור פרסום ישיר על הכרטיס — לא פותח את התצוגה המקדימה
  $$('#board [data-mark-publish]').forEach((btn) =>
    btn.addEventListener('click', run(async (e) => {
      e.stopPropagation();
      await api(`/posts/${btn.dataset.markPublish}/publish`, { method: 'POST' });
      toast('סומן כפורסם.');
      await Promise.all([renderBoard(), refreshTaskBadge(), refreshAlerts()]);
    })));

  if (editable) wireBoardDrag();
}

/**
 * גרירת כרטיס ליום אחר על הלוח.
 * שינוי מדיה מותר רק אם לתוכן יש גרסה מוכנה למדיה היעד — אחרת היינו
 * מפרסמים שם ניסוח שנכתב למדיה אחרת.
 */
function wireBoardDrag() {
  let dragged = null;

  $$('#board [data-post-id]').forEach((el) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      dragged = JSON.parse(el.dataset.post);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      $$('#board .day.over').forEach((d) => d.classList.remove('over'));
      dragged = null;
    });
  });

  $$('#board [data-drop-channel]').forEach((cell) => {
    cell.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      cell.classList.add('over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));

    cell.addEventListener('drop', run(async (e) => {
      e.preventDefault();
      cell.classList.remove('over');
      if (!dragged) return;

      const channelId = Number(cell.dataset.dropChannel);
      const date = cell.dataset.dropDate;
      const sameSpot = channelId === dragged.channel_id &&
                       date === ymd(new Date(dragged.scheduled_at));
      if (sameSpot) return;

      // שומרים את שעת היום המקורית
      const at = new Date(dragged.scheduled_at);
      const [y, m, d] = date.split('-').map(Number);
      at.setFullYear(y, m - 1, d);

      const moved = await postWithGapCheck(`/posts/${dragged.id}`,
        { scheduled_at: at.toISOString(), channel_id: channelId });
      if (!moved) return;   // המשתמש ביטל אחרי האזהרה
      toast('השיבוץ הוזז.');
      await Promise.all([renderBoard(), refreshAlerts()]);
    }));
  });
}

function postCard(p) {
  const who = p.assignee_name ? ` · ${esc(p.assignee_name)}` : '';
  const payload = esc(JSON.stringify(p));
  // התצוגה פתוחה לכולם; הגרירה בלבד מוגבלת להרשאת תוכן
  const clickable = `data-post-id="${p.id}" data-post="${payload}"`;

  if (p.status === 'hole') {
    // ה"סיבה" שהמנוע כתב מבדילה בין שני מצבים: יש טיוטה שעוד לא אושרה
    // לאף ערוץ פנוי, או שאין בכלל תוכן לנקודה הזו — ראו findHoles ב-engine.js
    const hasDraft = (p.note ?? '').includes('יש תוכן');
    return `<div class="hole${hasDraft ? ' draft' : ''}" ${clickable}
      data-tt="הלוח מחכה לתוכן: ${esc(KIND_HE[p.kind])} — ${esc(p.endpoint_name ?? '')}${p.note ? ` · ${esc(p.note)}` : ''}">
      <span class="corner-tag ${hasDraft ? 'yellow' : 'red'}">${hasDraft ? 'יש טיוטה' : 'אין תוכן'}</span>
      מחכה לתוכן<br><small>${esc(KIND_HE[p.kind])} · ${esc(p.endpoint_name ?? '')}</small></div>`;
  }
  if (p.status === 'pending_approval') {
    return `<div class="pending" ${clickable}
      data-tt="ממתין לאישור — ${esc(p.title)}">
      ממתין לאישור<br><small>${esc(p.title)}</small></div>`;
  }

  const tip = `${p.endpoint_name ?? ''} · ${KIND_HE[p.kind]}${p.urgent ? ' · דחוף' : ''}` +
              `${p.assignee_name ? ` · אחראי: ${p.assignee_name}` : ''}`;
  const bg = epColor(p.endpoint_id);

  // פוסט שכבר יצא לאוויר: הכרטיס עצמו נשאר (צבע, כותרת, פרטים), רק
  // דהוי, וחותמת ירוקה גדולה למעלה אומרת שזה כבר קרה.
  if (p.status === 'published') {
    return `<div class="post published" ${clickable} data-tt="${esc(tip)}"
      style="background:${bg};color:${inkOn(bg)}">
      <span class="pub-stamp">✓ פורסם</span>
      <div class="published-inner">
        <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
        <div class="meta">
          <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
          ${esc(p.time)}${who}
        </div>
      </div>
    </div>`;
  }

  // הצבע הוא נקודת הקצה. סוג התוכן מסומן בתג קטן, כדי ששני הממדים
  // יהיו קריאים בלי שאחד יסתיר את השני.
  // "יש תוכן מוכן" הוא אוטומטי לגמרי — נגזר מהסטטוס האמיתי (hole/pending/published).
  // "פורסם" הוא הדבר היחיד שלא נגזר משום מקום: מישהו צריך לקבוע את זה בפועל.
  const canPublish = p.status === 'scheduled' && can('content');

  return `<div class="post" ${clickable} data-tt="${esc(tip)}"
    style="background:${bg};color:${inkOn(bg)}">
    <span class="corner-tag blue">יש תוכן</span>
    ${canPublish ? `<button type="button" class="mark-pub" data-mark-publish="${p.id}"
      draggable="false" title="סמן כפורסם">✓</button>` : ''}
    <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
    <div class="meta">
      <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
      ${esc(p.time)}${who}
    </div></div>`;
}

/* ========================= תצוגת פוסט מהלוח ========================= */

let previewPost = null;

function wirePostDialog() {
  $('#pClose').addEventListener('click', () => $('#postDlg').close());

  $('#pDelete').addEventListener('click', run(async () => {
    if (!previewPost) return;
    if (!confirm('להסיר את השיבוץ מהלוח? התוכן עצמו יישאר.')) return;
    const res = await api(`/posts/${previewPost.id}`, { method: 'DELETE', body: { week: state.week } });
    $('#postDlg').close();
    toast('השיבוץ הוסר.' + (res.engine?.placed ? ` המנוע מילא את המקום שהתפנה.` : ''));
    await Promise.all([renderBoard(), refreshTaskBadge(), refreshAlerts()]);
  }));

  // כפתור יחיד שמתנהג לפי מצב הפוסט: מתוכנן → מסמן פורסם, פורסם → מבטל
  $('#pPublish').addEventListener('click', run(async () => {
    if (!previewPost) return;
    const wasPublished = previewPost.status === 'published';
    const path = wasPublished ? 'unpublish' : 'publish';
    await api(`/posts/${previewPost.id}/${path}`, { method: 'POST' });
    $('#postDlg').close();
    toast(wasPublished ? 'הפרסום בוטל, השיבוץ חזר למתוכנן.' : 'סומן כפורסם.');
    await Promise.all([renderBoard(), refreshTaskBadge(), refreshAlerts()]);
  }));

  // מהלוח אל התוכן — שם עורכים את הטקסט, ולא בלוח
  $('#pOpenContent').addEventListener('click', run(async () => {
    if (!previewPost?.content_id) return toast('לשיבוץ הזה אין תוכן משויך.', true);
    $('#postDlg').close();
    const { content } = await api('/content');
    const item = content.find((c) => c.id === previewPost.content_id);
    state.planCampaign = item?.campaign_id ?? null;
    state.planEndpoint = item?.endpoint_id ?? null;
    state.planBackground = !item?.campaign_id;
    await showTab('plan');
  }));
}

/** מה שאמור לצאת: הטקסט של המדיה הזו והקבצים שלה */
async function openPostPreview(postId) {
  $('#postDlgTitle').textContent = 'טוען…';
  $('#postPreview').innerHTML = '';
  $('#pPublish').hidden = true;
  $('#postDlg').showModal();

  const { post, variant, assets } = await api(`/posts/${postId}/preview`);
  previewPost = post;

  const pubBtn = $('#pPublish');
  pubBtn.hidden = !(can('content') && ['scheduled', 'published'].includes(post.status));
  pubBtn.textContent = post.status === 'published' ? 'בטל פרסום' : 'סמן כפורסם';

  const when = new Date(post.scheduled_at)
    .toLocaleString('he-IL', { dateStyle: 'full', timeStyle: 'short' });

  const media = assets.map((a) => {
    if (isImage(a.mime)) {
      return `<img class="pv" src="/api/assets/${a.id}" alt="${esc(a.filename)}">`;
    }
    if (isVideo(a.mime)) {
      return `<video class="pv" src="/api/assets/${a.id}" controls></video>`;
    }
    return `<a class="pvfile" href="/api/assets/${a.id}" target="_blank" rel="noopener">
      📄 ${esc(a.filename)}</a>`;
  }).join('');

  const body = variant?.body?.trim();

  $('#postDlgTitle').textContent = post.title;
  $('#postPreview').innerHTML = `
    <div class="pvmeta">
      <span class="sw" style="background:${epColor(post.endpoint_id)}"></span>
      ${esc(post.endpoint_name ?? 'ללא נקודת קצה')} · ${esc(post.channel_name ?? '')}
      ${post.campaign_name ? ` · ${esc(post.campaign_name)}` : ''}
      ${post.evergreen ? ' · ♻' : ''}
    </div>
    <div class="pvwhen">${esc(when)}${
      post.assignee_name ? ` · אחראי: ${esc(post.assignee_name)}` : ''}</div>

    ${media ? `<div class="pvmedia">${media}</div>` : ''}

    ${body ? `<div class="pvbody">${esc(body)}</div>`
            : '<div class="pvempty">אין עדיין טקסט לגרסה של המדיה הזו.</div>'}

    ${variant && variant.status !== 'ready'
      ? `<div class="pvwarn">הגרסה הזו במצב "${variant.status === 'draft' ? 'טיוטה' : 'לא רלוונטי'}" —
         היא לא נחשבת מוכנה לפרסום.</div>` : ''}`;
}

/* ========================= מבצע דחוף ========================= */

// מבצע דחוף לא נושא תוכן מלא (רק כותרת) — אין לו לחצן "אשר" בלי אישור
// מודע לכך, ולכן צריך גם את תוצאת הבדיקה האחרונה וגם את מצב התיבה
let urgentPlanOk = false;

function wireUrgentDialog() {
  $('#uCancel').addEventListener('click', () => $('#urgentDlg').close());
  $('#uCheck').addEventListener('click', run(previewUrgent));
  $('#uAck').addEventListener('change', () => {
    $('#uOk').disabled = !(urgentPlanOk && $('#uAck').checked);
  });
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
  $('#uAck').checked = false;
  urgentPlanOk = false;
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
    urgentPlanOk = false;
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
  urgentPlanOk = plan.ok;
  $('#uOk').disabled = !(urgentPlanOk && $('#uAck').checked);
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

const MONTHS_SHOWN = 12;
// רזולוציית הציר היא חצי חודש: כל חודש נחלק ל-1 ול-16 בו
const HALVES = MONTHS_SHOWN * 2;
const MID_DAY = 16;

/** תחילת החלון: חודש אחד אחורה מהיום */
function ganttBase() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

const monthIndex = (dateStr, base) => {
  const d = new Date(`${dateStr}T00:00:00`);
  return (d.getFullYear() - base.getFullYear()) * 12 + (d.getMonth() - base.getMonth());
};

/** המשבצת של תאריך על ציר חצאי-החודשים */
function halfIndex(dateStr, base) {
  const d = new Date(`${dateStr}T00:00:00`);
  return monthIndex(dateStr, base) * 2 + (d.getDate() >= MID_DAY ? 1 : 0);
}

/** התאריך שבתחילת משבצת נתונה: ה-1 או ה-16 בחודש */
function halfToDate(half, base) {
  const month = Math.floor(half / 2);
  const d = new Date(base.getFullYear(), base.getMonth() + month, half % 2 ? MID_DAY : 1);
  return ymd(d);
}

// חשבון התאריכים לא עובר דרך מילישניות: המעבר לשעון חורף מוסיף או מוריד
// שעה, ו-60 ימים הופכים ל-59. setDate ו-Date.UTC חסינים לזה.
const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return ymd(d);
};
const daysBetweenDates = (a, b) => {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
};

async function renderStrategy() {
  const data = await api('/strategy');
  state.endpoints = data.endpoints;
  rebuildEpColors();

  $('#strategy').innerHTML = `
    <div class="toolbar">
      <div>
        <h2 style="font-size:15px;font-weight:650">ציר הקמפיינים</h2>
        <p class="sub" style="color:var(--muted);font-size:12.5px;margin-top:3px">
          כל קפסולה היא קמפיין לאורך חייו, בצבע נקודת הקצה שלו.
          ${can('settings') ? 'גוררים אותה כדי להזיז את הקמפיין בזמן.' : ''}
          המשקלים והתדירויות מוגדרים בטאב "ניהול".</p>
      </div>
    </div>

    <div class="panel" style="margin-bottom:18px">${gantt(data)}</div>

    <div class="panel" style="max-width:640px">${allocPanel(data.allocation)}</div>`;

  wireStrategy();
}

function gantt(data) {
  const base = ganttBase();
  const dated = data.endpoints
    .flatMap((e) => e.campaigns
      .filter((c) => c.active && c.starts_on && c.ends_on)
      .map((c) => ({ ...c, endpoint_name: e.name })));

  if (!dated.length) {
    return '<div class="empty">אין קמפיינים עם תאריכים.</div>';
  }

  const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const now = new Date();
    return {
      label: HE_MONTHS[d.getMonth()],
      year: d.getFullYear(),
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      is_now: d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(),
    };
  });

  const header = `<div class="gmonths">
    <span class="glabel"></span>
    ${months.map((m) => {
      const marks = data.milestones.filter((x) => x.on_date.slice(0, 7) === m.key);
      return `<span class="${m.is_now ? 'now' : ''}">${esc(m.label)}
        ${marks.map((x) => `<i data-tt="אבן דרך: ${esc(x.label)}">◆</i>`).join('')}</span>`;
    }).join('')}
  </div>`;

  // שורה לכל נקודת קצה. קמפיינים שחופפים בזמן יורדים לנתיב נוסף.
  const rows = data.endpoints.map((e) => {
    const mine = dated.filter((c) => c.endpoint_id === e.id)
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    if (!mine.length) return '';

    const lanes = [];
    for (const c of mine) {
      const from = Math.max(0, halfIndex(c.starts_on, base));
      const to = Math.min(HALVES, halfIndex(c.ends_on, base) + 1);
      if (to <= from) continue;
      let lane = lanes.find((l) => l.every((x) => x.to <= from || x.from >= to));
      if (!lane) { lane = []; lanes.push(lane); }
      lane.push({ ...c, from, to });
    }

    const laneHtml = lanes.map((lane) => `
      <div class="glane">
        ${lane.map((c) => capsule(c, e)).join('')}
      </div>`).join('');

    return `<div class="grow2">
      <span class="glabel">
        <i class="dot" style="background:${epColor(e.id)}"></i>${esc(e.name)}
      </span>
      <div class="gtrack">${laneHtml}</div>
    </div>`;
  }).join('');

  return `<div class="gantt2">${header}${rows}
    <div class="gnote">קפסולה נגררת בקפיצות של חודש. המנוע מפזר את הפוסטים
      על המדיות לפי המשקל של נקודת הקצה.</div>
  </div>`;
}

function capsule(c, endpoint) {
  const pct = (n) => (n / HALVES) * 100;
  const tip = `${c.name} · ${endpoint.name} · ${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` +
              (c.share_pct != null ? ` · נתח ${c.share_pct}%` : ' · נתח נגזר מהמשקל');

  return `<button class="caps${c.urgent ? ' urgent' : ''}${c.paused_at ? ' paused' : ''}"
    style="inset-inline-start:${pct(c.from)}%;width:${pct(c.to - c.from)}%;
           background:${epColor(endpoint.id)}"
    data-campaign="${c.id}" data-from="${c.starts_on}" data-to="${c.ends_on}"
    data-tt="${esc(tip)}">
    <span>${c.paused_at ? '⏸ ' : ''}${c.urgent ? '⚡ ' : ''}${esc(c.name)}</span>
  </button>`;
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
    <h4>יעד מול ביצוע — ${fmtDate(alloc.window.from)} עד היום</h4>
    ${rows}
    <p class="sumline" style="margin-top:10px">נמדד על ${alloc.window.total_published} פרסומים שיצאו בתקופה.</p>
  </div>`;
}

/**
 * גרירת קפסולה על הציר, ברזולוציה של חצי חודש.
 *
 * ההתחלה נצמדת ל-1 או ל-16 בחודש, והסיום זז באותו מספר ימים בדיוק —
 * כך אורך הקמפיין נשמר ולא מתקצר או מתארך תוך כדי הזזה.
 */
function wireStrategy() {
  if (!can('settings')) return;

  const base = ganttBase();

  $$('#strategy .caps').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const track = el.closest('.gtrack');
      const halfWidth = track.getBoundingClientRect().width / HALVES;
      // ב-RTL תנועה שמאלה היא קדימה בזמן
      const dir = getComputedStyle(track).direction === 'rtl' ? -1 : 1;
      const startX = e.clientX;
      let deltaHalves = 0;

      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');

      const move = (ev) => {
        deltaHalves = Math.round(((ev.clientX - startX) / halfWidth) * dir);
        el.style.transform = `translateX(${ev.clientX - startX}px)`;
        el.dataset.preview = deltaHalves;
      };

      const up = run(async () => {
        el.releasePointerCapture(e.pointerId);
        el.classList.remove('dragging');
        el.style.transform = '';
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (!deltaHalves) return;

        const from = el.dataset.from;
        const to = el.dataset.to;
        const targetHalf = Math.max(0, halfIndex(from, base) + deltaHalves);
        const newFrom = halfToDate(targetHalf, base);
        const newTo = addDays(to, daysBetweenDates(from, newFrom));

        // week: הבקשה מציינת לאיזה שבוע לכוון את המילוי האוטומטי — השבוע
        // שהקמפיין נכנס אליו עכשיו, לא בהכרח מה שמוצג כרגע בלוח
        const res = await api(`/campaigns/${el.dataset.campaign}`, {
          method: 'PATCH', body: { starts_on: newFrom, ends_on: newTo, week: newFrom },
        });

        const steps = Math.abs(deltaHalves);
        const moved = res.moved_posts
          ? ` · ${res.moved_posts} שיבוצים זזו איתו` : '';
        const filled = res.engine?.placed
          ? ` · המנוע מילא ${res.engine.placed} משבצות פנויות` : '';
        toast((steps === 1 ? 'הקמפיין הוזז בחצי חודש.'
                           : `הקמפיין הוזז ב-${steps} חצאי חודש.`) + moved + filled);
        await Promise.all([renderStrategy(), renderBoard()]);
      });

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });

    // לחיצה בלי גרירה פותחת את הקמפיין
    el.addEventListener('click', run(async () => {
      if (el.dataset.preview && Number(el.dataset.preview) !== 0) return;
      state.planCampaign = Number(el.dataset.campaign);
      state.planBackground = false;
      await showTab('plan');
    }));
  });
}

/* ========================= קמפיינים ותוכן ========================= */

async function renderPlan() {
  const [{ campaigns }, { content }] = await Promise.all([
    api('/campaigns'), api('/content'),
  ]);
  state.campaigns = campaigns;

  // הקמפיין שנבחר מכתיב גם את נקודת הקצה, כדי שפירורי הלחם תמיד יהיו עקביים
  const campaign = campaigns.find((c) => c.id === state.planCampaign) ?? null;
  if (campaign) state.planEndpoint = campaign.endpoint_id;
  const endpointId = state.planEndpoint;
  const endpoint = state.endpoints.find((e) => e.id === endpointId) ?? null;

  const crumbs = `
    <div class="crumbs">
      <button data-crumb="root" class="${!endpointId ? 'on' : ''}">כל נקודות הקצה</button>
      ${endpoint ? `<span>›</span>
        <button data-crumb="endpoint" class="${!campaign && !state.planBackground ? 'on' : ''}">${esc(endpoint.name)}</button>` : ''}
      ${campaign ? `<span>›</span>
        <button data-crumb="campaign" class="on">${esc(campaign.name)}</button>` : ''}
      ${state.planBackground && !campaign ? '<span>›</span><button class="on">תוכן שוטף</button>' : ''}
    </div>`;

  let body;
  if (campaign) body = campaignGrid(campaign);
  else if (endpoint && state.planBackground) body = backgroundGrid(endpoint, content);
  else if (endpoint) body = campaignList(endpoint, campaigns, content);
  else body = endpointList(campaigns, content);

  $('#plan').innerHTML = crumbs + body;
  wirePlan(campaign, endpointId, content);
}

/** התוכן השוטף של נקודת קצה: לא שייך לקמפיין, רץ ברקע לאורך זמן */
const backgroundOf = (content, endpointId) =>
  content.filter((c) => !c.campaign_id && c.endpoint_id === endpointId);

/**
 * רשת התוכן השוטף. אין כאן תאריכים ואין מספר נדרש — זו ספרייה שהמנוע
 * שולף ממנה כשנשאר שטח, ולא תוכנית עם לוח זמנים.
 */
function backgroundGrid(endpoint, content) {
  const mine = backgroundOf(content, endpoint.id);
  const channels = state.channels.filter((c) => c.active);

  const head = channels.map((ch) => `<th>${esc(ch.name)}</th>`).join('');

  const rows = mine.map((item) => {
    const cells = channels.map((ch) => {
      const v = item.variants.find((x) => x.channel_id === ch.id) ?? null;
      const state_ = v ? v.status : 'empty';
      const st = CELL[state_];
      return `<td class="cell ${st.cls}" ${can('content')
        ? `data-bg-cell="${item.id}" data-ch="${ch.id}"` : ''}
        data-tt="${esc(ch.name)} · ${esc(st.label)}"><span>${st.label || '—'}</span></td>`;
    }).join('');

    const ready = item.variants.filter((v) => v.status === 'ready').length;
    return `<tr>
      <td class="angle" ${can('content') ? `data-bg-angle="${item.id}"` : ''}>
        <div class="aname">${esc(item.title)}</div>
        <div class="ameta">${esc(KIND_HE[item.kind])}
          ${item.evergreen ? `· ♻ כל ${item.reuse_after_days ?? '—'} ימים` : '· חד-פעמי'}
          ${item.placements ? `· שובץ ${item.placements}×` : ''}
          · מוכן ב-${ready} מדיות</div>
      </td>${cells}</tr>`;
  }).join('');

  return `
    <div class="cbhead">
      <div>
        <h2>תוכן ערך שוטף — ${esc(endpoint.name)}</h2>
        <p class="sub">רץ ברקע לאורך זמן, בלי קמפיין ובלי תאריכים.
          המנוע שולף ממנו כשנשאר שטח פנוי, ומכבד את המרווח בין חזרות.</p>
      </div>
      <div class="spacer"></div>
      ${can('content') ? '<button class="btn primary" id="addBackground">＋ זווית שוטפת</button>' : ''}
    </div>

    ${mine.length ? `<div class="board panel">
      <table class="grid cgrid">
        <thead><tr><th class="angle">זווית</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="sumline">כל שורה היא מסר קבוע, וכל עמודה הניסוח שלו למדיה.</div>`
    : '<div class="empty">אין עדיין תוכן שוטף לנקודה הזו.</div>'}`;
}

/** רמה 1: נקודות הקצה, עם סיכום הקמפיינים של כל אחת */
function endpointList(campaigns) {
  if (!state.endpoints.length) {
    return '<div class="empty">אין נקודות קצה. מוסיפים אותן בטאב "ניהול".</div>';
  }
  const cards = state.endpoints.map((e) => {
    const mine = campaigns.filter((c) => c.endpoint_id === e.id);
    const missing = mine.reduce((s, c) => s + c.missing_content, 0);
    return `<button class="epick" data-pick-endpoint="${e.id}">
      <span class="nm"><i class="dot" style="background:${epColor(e.id)}"></i>${esc(e.name)}</span>
      <span class="sub">${mine.length} קמפיינים · חשיבות ${e.importance}</span>
      <span class="chip ${missing ? 'bad' : 'on'}">${missing ? `חסרים ${missing}` : 'מלא'}</span>
    </button>`;
  }).join('');
  return `<div class="eplist">${cards}</div>`;
}

/** רמה 2: הקמפיינים של נקודת הקצה */
function campaignList(endpoint, campaigns, content) {
  const mine = campaigns.filter((c) => c.endpoint_id === endpoint.id);
  const bg = backgroundOf(content, endpoint.id);
  const bgReady = bg.filter((c) => c.variants.some((v) => v.status === 'ready')).length;
  const group = (title, list) => list.length ? `
    <div class="setgroup" style="max-width:none">
      <h2>${esc(title)}</h2>
      <div class="panel">${list.map(campaignItem).join('')}</div>
    </div>` : '';

  return `
    <div class="toolbar">
      <div class="legend">
        <span><b>${mine.filter((c) => c.phase === 'running').length}</b> רצים</span>
        <span>·</span>
        <span><b>${mine.filter((c) => c.phase === 'upcoming').length}</b> מתוכננים</span>
      </div>
      <div class="spacer"></div>
      ${can('settings') ? '<button class="btn primary" id="addCampaign">＋ קמפיין חדש</button>' : ''}
    </div>
    <div class="setgroup" style="max-width:none">
      <h2>תוכן שוטף</h2>
      <p class="sub">רץ ברקע כל הזמן, בלי תאריכים. המנוע שולף ממנו כשנשאר שטח.</p>
      <div class="panel">
        <div class="crow2" data-open-background>
          <div class="cinfo">
            <b>תוכן ערך שוטף</b>
            <span class="d">${bg.length} זוויות · ${bgReady} מהן מוכנות לפחות במדיה אחת</span>
          </div>
          <span class="chip ${bg.length ? 'on' : 'bad'}">${
            bg.length ? 'פעיל' : 'ריק'}</span>
        </div>
      </div>
    </div>

    ${mine.length ? '' : '<div class="empty">אין קמפיינים לנקודה הזו עדיין.</div>'}
    ${group('רצים עכשיו', mine.filter((c) => c.phase === 'running'))}
    ${group('מתוכננים', mine.filter((c) => c.phase === 'upcoming'))}
    ${group('מושהים', mine.filter((c) => c.phase === 'paused'))}
    ${group('הסתיימו', mine.filter((c) => c.phase === 'ended' || c.phase === 'inactive'))}`;
}

function campaignItem(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';
  const pct = c.required ? Math.min(100, Math.round((c.ready / c.required) * 100)) : 0;

  return `<div class="crow2${c.paused_at ? ' paused' : ''}" data-open-campaign="${c.id}">
    <div class="cinfo">
      <b>${c.paused_at ? '⏸ ' : c.urgent ? '⚡ ' : ''}${esc(c.name)}</b>
      <span class="d">${esc(range)}</span>
    </div>
    <button class="chanpick" data-pick-channels="${c.id}"
      data-tt="לחיצה לבחירת המדיות של הקמפיין">
      ${c.channels.length
        ? c.channels.map((x) => `<i>${esc(x.name)}</i>`).join('')
        : '<i class="none">בחר מדיות</i>'}
    </button>
    <div class="abar" style="max-width:150px" data-tt="${c.ready} מתוך ${c.required} מוכנים">
      <div class="actual" style="width:${pct}%"></div>
    </div>
    <span class="chip ${TONE_CLASS[c.status.tone]}">${esc(c.status.label)}</span>
    ${can('settings') ? `
      <button class="btn small${c.paused_at ? ' primary' : ''}"
        data-toggle-pause="${c.id}" data-paused="${!!c.paused_at}">
        ${c.paused_at ? '▶ חזרה לחיים' : '⏸ השהה'}</button>
      <button class="btn small" data-edit-campaign="${c.id}">ערוך</button>` : ''}
  </div>`;
}

function wirePlan(campaign, endpointId, content) {
  const reload = run(async () => {
    await Promise.all([renderPlan(), renderBoard(), refreshAlerts()]);
  });

  $$('#plan [data-crumb]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (b.dataset.crumb === 'root') { state.planEndpoint = null; state.planCampaign = null; }
      state.planCampaign = b.dataset.crumb === 'campaign' ? state.planCampaign : null;
      state.planBackground = false;
      await renderPlan();
    })));

  $('#plan [data-open-background]')?.addEventListener('click', run(async () => {
    state.planBackground = true;
    state.planCampaign = null;
    await renderPlan();
  }));

  $('#addBackground')?.addEventListener('click', () =>
    openAngleForm({ background: { endpoint_id: endpointId } }, reload));

  $$('#plan [data-bg-angle]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = content.find((x) => x.id === Number(b.dataset.bgAngle));
      openAngleForm({ item, background: { endpoint_id: endpointId } }, reload);
    }));

  $$('#plan [data-bg-cell]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = content.find((x) => x.id === Number(b.dataset.bgCell));
      openVariantForm({ item, channelId: Number(b.dataset.ch) }, reload);
    }));

  $$('#plan [data-pick-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      state.planEndpoint = Number(b.dataset.pickEndpoint);
      state.planCampaign = null;
      await renderPlan();
    })));

  $$('#plan [data-open-campaign]').forEach((el) =>
    el.addEventListener('click', run(async (e) => {
      if (e.target.closest('[data-edit-campaign]')) return;
      state.planCampaign = Number(el.dataset.openCampaign);
      await renderPlan();
    })));

  $$('#plan [data-edit-campaign]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.editCampaign));
      openCampaignForm(c, reload);
    }));

  // בחירת מדיות ישירות מהשורה. קודם היא הייתה שדה אחד מתוך 14 בטופס העריכה.
  $$('#plan [data-pick-channels]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.pickChannels));
      openChannelPicker(c, reload);
    }));

  $$('#plan [data-toggle-pause]').forEach((b) =>
    b.addEventListener('click', run(async (e) => {
      e.stopPropagation();
      const paused = b.dataset.paused === 'true';
      const res = await api(`/campaigns/${b.dataset.togglePause}/${paused ? 'resume' : 'pause'}`,
        { method: 'POST', body: { week: state.week } });
      toast(paused
        ? 'הקמפיין חזר לפעול.' +
          (res.cleared ? ` ${res.cleared} שיבוצים ישנים נוקו —` : '') +
          (res.engine?.placed ? ` המנוע שיבץ ${res.engine.placed} מחדש.` : ' המנוע ימקם אותו מחדש בפעם הבאה שיש מקום.')
        : `הקמפיין הושהה${res.held ? ` · ${res.held} שיבוצים ירדו מהלוח` : ''}.`);
      await reload();
    })));

  $('#addCampaign')?.addEventListener('click', () =>
    openCampaignForm(null, reload, endpointId));

  if (campaign) wireCampaignGrid(campaign, reload);
}

/** בחירת המדיות של קמפיין, בטופס אחד קצר במקום בתוך טופס העריכה המלא */
function openChannelPicker(campaign, reload) {
  if (!can('settings')) return toast('אין לך הרשאה לשנות את המדיות', true);

  openGeneric({
    title: `מדיות — ${campaign.name}`,
    fields: [
      { name: 'channel_ids', label: 'על אילו מדיות הקמפיין יושב', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: campaign.channels?.map((c) => c.id) },
    ],
    onSave: async (v) => {
      if (!v.channel_ids?.length) throw new Error('צריך לבחור לפחות מדיה אחת');
      v.week = state.week;
      await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
      await reload();
    },
  });
}

function openCampaignForm(campaign, reload, defaultEndpoint) {
  openGeneric({
    title: campaign ? 'עריכת קמפיין' : 'קמפיין חדש',
    fields: [
      { name: 'name', label: 'שם הקמפיין', type: 'text', value: campaign?.name },
      { name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]),
        value: campaign?.endpoint_id ?? defaultEndpoint },
      { name: 'goal', label: 'מה המטרה', type: 'text', value: campaign?.goal },
      { name: 'starts_on', label: 'מתאריך', type: 'date', value: campaign?.starts_on },
      { name: 'ends_on', label: 'עד תאריך', type: 'date', value: campaign?.ends_on },
      { name: 'channel_ids', label: 'על אילו מדיות הקמפיין יושב', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: campaign?.channels?.map((c) => c.id) },
      { name: 'importance', label: 'חשיבות (1–10)', type: 'number',
        value: campaign?.importance ?? 5,
        hint: 'זה מה שקובע כמה שטח מגיע לקמפיין. השאר את שני השדות הבאים על "אוטומטי".' },
      { name: 'share_pct', label: 'נתח מהשטח', type: 'auto',
        value: campaign?.share_pct,
        auto: campaign?.share_auto != null ? `${campaign.share_auto}%` : 'לפי החשיבות',
        placeholder: '%',
        hint: 'אוטומטי מחלק את השטח לפי החשיבות מול הקמפיינים שרצים במקביל. ' +
              'קבוע נועד למקרה שהובטח לקמפיין נתח מסוים בלי קשר לשאר.' },
      { name: 'target_posts', label: 'מספר זוויות', type: 'auto',
        value: campaign?.target_posts,
        auto: campaign?.angles_auto != null ? String(campaign.angles_auto) : 'לפי המדיות',
        hint: 'אוטומטי נגזר מהקצב של המדיות שנבחרו ומאורך הקמפיין.' },
      { name: 'urgent', label: 'קמפיין דחוף', type: 'checkbox', value: campaign?.urgent },
    ],
    extraActions: campaign && can('settings')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק קמפיין</button>'
      : '',
    onSave: async (v) => {
      v.week = state.week;
      if (campaign) await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
      else await api('/campaigns', { method: 'POST', body: v });
      await reload();
    },
    onOpen: () => {
      $('#genDelete')?.addEventListener('click', run(async () => {
        if (!confirm('למחוק את הקמפיין? התוכן שלו יישאר, רק ינותק ממנו.')) return;
        await api(`/campaigns/${campaign.id}`, { method: 'DELETE', body: { week: state.week } });
        $('#genDlg').close();
        state.planCampaign = null;
        await reload();
      }));
    },
  });
}

/* ========================= תוכן ========================= */


function campaignGrid(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';

  if (!c.channels.length) {
    return `<div class="panel"><div class="empty">
      לקמפיין הזה לא נבחרו מדיות. בוחרים אותן בעריכת הקמפיין בטאב "אסטרטגיה".
    </div></div>`;
  }
  if (!c.grid.length) {
    return `<div class="panel"><div class="empty">
      לקמפיין אין תאריכים, ולכן אין ממה לגזור כמה תוכן הוא צריך.
    </div></div>`;
  }

  const head = c.channels.map((ch) =>
    `<th>${esc(ch.name)}<div class="need">${c.needs[ch.id] ?? 0} פוסטים</div></th>`).join('');

  const rows = c.grid.map((row) => {
    const item = row.content;
    const angle = item
      ? `<div class="aname">${esc(item.title)}</div>
         <div class="ameta">${esc(KIND_HE[item.kind])}${
           item.evergreen ? ' · ♻' : ''}${
           item.assets.length ? ` · 📎${item.assets.length}` : ''}</div>`
      : `<div class="aname muted">${row.past ? 'זווית שלא נכתבה' : 'זווית חדשה'}</div>`;

    const cells = c.channels.map((ch) => {
      const cell = row.cells.find((x) => x.channel_id === ch.id);
      const st = CELL[cell.state];
      const clickable = can('content') && cell.state !== 'not_needed';
      return `<td class="cell ${st.cls}"
        ${clickable ? `data-cell="${row.index}" data-ch="${ch.id}"` : ''}
        ${clickable ? `data-tt="${esc(ch.name)} · ${esc(st.label)}"` : ''}>
        <span>${st.label || '—'}</span></td>`;
    }).join('');

    return `<tr class="${row.past ? 'past' : ''}">
      <td class="angle" ${can('content') ? `data-angle="${row.index}"` : ''}>
        <div class="anum">${row.index}<span>${fmtDate(row.date)}</span></div>
        ${angle}
      </td>${cells}</tr>`;
  }).join('');

  return `
    <div class="cbhead">
      <div>
        <h2>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</h2>
        <p class="sub">${esc(c.endpoint_name)} · ${esc(range)}
          · נתח ${c.share_pct != null ? c.share_pct + '%' : 'נגזר מהמשקל'}
          ${c.goal ? `· ${esc(c.goal)}` : ''}</p>
      </div>
      <div class="spacer"></div>
      ${can('settings') ? `<button class="btn small" data-edit-campaign="${c.id}">✎ ערוך קמפיין</button>` : ''}
      <div class="fill">
        <b>${c.ready}</b> מתוך <b>${c.required}</b> פוסטים מוכנים
        ${c.missing_content ? `<span class="off">— חסרים ${c.missing_content}</span>`
                            : '<span class="ok">✓</span>'}
      </div>
    </div>

    ${can('content') ? `<div class="bulk" id="bulkZone">
      <div>
        <b>העלאה מרוכזת</b>
        <span>כל קובץ הופך לזווית חדשה, ונפתחות לה טיוטות לכל מדיה של הקמפיין.</span>
      </div>
      <div class="spacer"></div>
      <select id="bulkKind">
        <option value="value">ערך</option>
        <option value="hybrid">משולב</option>
        <option value="promo">מכירתי</option>
      </select>
      <button class="btn primary" id="bulkPick">בחר קבצים</button>
      <input type="file" id="bulkInput" multiple hidden>
      <button class="btn" id="importSheet">ייבוא מטבלה</button>
    </div>` : ''}

    <div class="board panel">
      <table class="grid cgrid">
        <thead><tr><th class="angle">זווית</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="sumline">
      כל שורה היא מסר אחד, וכל עמודה היא הניסוח שלו למדיה. לחיצה על תא פותחת את הטקסט לאותה מדיה.
    </div>`;
}


function wireCampaignGrid(selected, reload) {
  // לחיצה על הזווית עצמה — עריכת המסר, הסוג והקבצים
  $$('#plan [data-angle]').forEach((b) =>
    b.addEventListener('click', () => {
      const idx = Number(b.dataset.angle);
      const item = selected.content.find((x) => x.sort_order === idx) ?? null;
      openAngleForm({ item, campaign: selected, slot: idx }, reload);
    }));

  // לחיצה על תא — הניסוח של הזווית הזו למדיה הזו
  $$('#plan [data-cell]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(b.dataset.cell);
      const channelId = Number(b.dataset.ch);
      const item = selected.content.find((x) => x.sort_order === idx) ?? null;
      if (!item) {
        toast('צריך קודם לכתוב את הזווית — לוחצים על העמודה הראשונה.', true);
        return;
      }
      openVariantForm({ item, channelId, campaign: selected }, reload);
    }));

  $('#importSheet')?.addEventListener('click', () => openImport(selected, reload));

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
    toast(`נוצרו ${data.created.length} זוויות.`);
    input.value = '';
    await reload();
  }));
}

/** הזווית: המסר עצמו, הסוג, הקבצים המשותפים */
function openAngleForm({ item, campaign, slot, background }, reload) {
  const campaignOptions = [['', 'ללא קמפיין — תוכן שוטף'],
    ...state.campaigns.map((c) => [c.id, c.name])];
  const inCampaign = !!(campaign?.id ?? item?.campaign_id);
  const owner = state.campaigns.find((c) => c.id === (campaign?.id ?? item?.campaign_id));
  // תוכן שוטף: אין קמפיין לרשת ממנו נקודת קצה, אז היא נלקחת מההקשר
  const bgEndpoint = background?.endpoint_id;

  const existingFiles = (item?.assets ?? []).map((a) => `
    <div class="fileline">
      ${isImage(a.mime) ? `<img src="/api/assets/${a.id}" alt="">` : '<span class="ic">📄</span>'}
      <a href="/api/assets/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
      <span class="d">${kb(a.size_bytes)}</span>
      <button type="button" class="btn small" data-del-asset="${a.id}"
              style="color:var(--st-crit);margin-inline-start:auto">הסר</button>
    </div>`).join('');

  openGeneric({
    title: (item ? `זווית ${item.sort_order}` : `זווית חדשה${slot ? ` — מקום ${slot}` : ''}`)
      + (owner ? ` · ${owner.endpoint_name}` : ''),
    fields: [
      { name: 'title', label: 'המסר בקצרה', type: 'text', value: item?.title },
      { name: 'campaign_id', label: 'קמפיין', type: 'select', options: campaignOptions,
        value: item?.campaign_id ?? campaign?.id ?? '' },
      // נקודת הקצה מגיעה מהקמפיין. נשאלת רק לתוכן שוטף שאין לו קמפיין.
      ...(inCampaign ? [] : [{
        name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]),
        value: item?.endpoint_id ?? bgEndpoint,
      }]),
      ...(background && !item ? [{
        name: 'channel_ids', label: 'לאילו מדיות לפתוח טיוטה', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: state.channels.filter((c) => c.active).map((c) => c.id),
      }] : []),
      { name: 'kind', label: 'סוג', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']],
        value: item?.kind },
      { name: 'evergreen', label: 'Evergreen — אפשר לפרסם שוב ושוב', type: 'checkbox',
        value: item ? item.evergreen : !!background },
      { name: 'reuse_after_days', label: 'מרווח בין חזרות (ימים) — ריק = ברירת המחדל',
        type: 'number', value: item ? item.reuse_after_days : (background ? 30 : null) },
      { name: '__files', label: 'תמונות ומסמכים (משותפים לכל המדיות)',
        type: 'files', existing: existingFiles },
    ],
    extraActions: item && can('content')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק זווית</button>'
      : '',
    onSave: async (v) => {
      const body = { ...v };
      delete body.__files;
      body.week = state.week;
      if (slot && !item) {
        body.sort_order = slot;
        // זווית חדשה נפתחת עם טיוטה לכל מדיה של הקמפיין
        body.channel_ids = campaign?.channels?.map((c) => c.id) ?? [];
      }

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
        if (!confirm('למחוק את הזווית וכל הגרסאות שלה?')) return;
        await api(`/content/${item.id}`, { method: 'DELETE', body: { week: state.week } });
        $('#genDlg').close();
        await reload();
      }));
    },
  });
}

/** הגרסה: הניסוח של זווית מסוימת למדיה מסוימת */
function openVariantForm({ item, channelId, campaign }, reload) {
  const channel = state.channels.find((c) => c.id === channelId);
  const v = item.variants.find((x) => x.channel_id === channelId) ?? null;

  // הקבצים של המדיה הזו בלבד, ולצידם מה שמשותף לכל המדיות של הזווית
  const mine = (item.variant_assets ?? []).filter((a) => a.variant_id === v?.id);
  const shared = item.assets ?? [];

  const files = [
    ...mine.map((a) => assetLine(a, true)),
    ...shared.map((a) => assetLine(a, false)),
  ].join('') || '';

  openGeneric({
    title: `${item.title} — ${channel?.name ?? ''}`,
    fields: [
      { name: 'body', label: 'הטקסט כפי שהוא ייצא במדיה הזו', type: 'textarea',
        value: v?.body },
      { name: 'status', label: 'מצב', type: 'select', value: v?.status ?? 'draft',
        options: [['draft', 'טיוטה'], ['ready', 'מוכן לפרסום'],
                  ['not_relevant', 'לא רלוונטי למדיה הזו']] },
      { name: '__files', label: `תמונות וסרטונים ל${channel?.name ?? 'מדיה הזו'}`,
        type: 'files', existing: files },
    ],
    onSave: async (val) => {
      const body = { ...val };
      delete body.__files;
      body.week = state.week;
      await api(`/content/${item.id}/variants/${channelId}`, { method: 'PUT', body });

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        const fd = new FormData();
        for (const f of picked) fd.append('files', f);
        const res = await fetch(`/api/content/${item.id}/variants/${channelId}/assets`,
          { method: 'POST', body: fd });
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
    },
  });
}


/** שורת קובץ בטופס. ownOnly מבדיל בין קובץ של המדיה לקובץ משותף לזווית. */
function assetLine(a, ownOnly) {
  const thumb = isImage(a.mime) ? `<img src="/api/assets/${a.id}" alt="">`
              : isVideo(a.mime) ? '<span class="ic">🎬</span>'
              : '<span class="ic">📄</span>';
  return `<div class="fileline">
    ${thumb}
    <a href="/api/assets/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
    <span class="d">${kb(a.size_bytes)}${ownOnly ? '' : ' · משותף לזווית'}</span>
    ${ownOnly ? `<button type="button" class="btn small" data-del-asset="${a.id}"
       style="color:var(--st-crit);margin-inline-start:auto">הסר</button>` : ''}
  </div>`;
}

const fmtDate = (d) => {
  const x = new Date(typeof d === 'string' && d.length === 10 ? d + 'T00:00:00' : d);
  return `${x.getDate()}.${x.getMonth() + 1}`;
};

/* ========================= ניהול ========================= */

async function renderManage() {
  const [{ endpoints }, { channels }, { settings }, { users }, backupsRes] = await Promise.all([
    api('/endpoints'), api('/channels'), api('/settings'), api('/users'),
    can('settings') ? api('/backups') : Promise.resolve(null),
  ]);
  state.endpoints = endpoints;
  rebuildEpColors();
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

    ${can('users') ? systemGroup(users, settings, backupsRes?.backups ?? null) : ''}`;

  wireManage(ro);
}

function endpointItem(e, channels, ro) {
  // הקמפיינים והתוכן עברו לטאבים משלהם. כאן נשארו רק ההגדרות של הנקודה עצמה.
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
        <div class="autofield">
          <label class="opt"><input type="radio" name="cadence-${e.id}" value="auto"
                 data-ep-cadence-mode="${e.id}" ${e.min_days_between == null ? 'checked' : ''}
                 ${ro ? 'disabled' : ''}>
            אוטומטי<b>${e.effective_min_days}</b></label>
          <label class="opt"><input type="radio" name="cadence-${e.id}" value="manual"
                 data-ep-cadence-mode="${e.id}" ${e.min_days_between != null ? 'checked' : ''}
                 ${ro ? 'disabled' : ''}>
            קבוע</label>
          <input type="number" min="1" value="${e.min_days_between ?? ''}"
                 data-ep-cadence-input="${e.id}" data-id="${e.id}"
                 ${e.min_days_between == null ? 'disabled' : ''} ${ro ? 'disabled' : ''}>
        </div>
        <div class="fhint">אוטומטי מחשב קצב לפי החשיבות — חשיבות גבוהה יותר, קצב תכוף יותר.
          קבוע נועד למקרה שיש צורך ספציפי בקצב מסוים, בלי קשר לחשיבות.</div>
      </div>

      <div class="subsec">
        <h4>סיכום</h4>
        <div class="contentline">${e.campaigns.length} קמפיינים · ${e.content.length} פריטי תוכן
          <span style="color:var(--muted)">— לניהול שלהם: הטאבים "קמפיינים" ו"תוכן"</span></div>
      </div>

      ${ro ? '' : `<div style="margin-top:14px">
        <button class="btn small" style="color:var(--st-crit)" data-del-endpoint="${e.id}">מחק נקודת קצה</button>
      </div>`}
    </div>
  </details>`;
}


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
      <span class="info">קצב ${c.target_per_week ?? c.max_per_week} · תקרה ${c.max_per_week} בשבוע</span>
      <span class="chip ${c.active ? 'on' : 'bad'}">${c.active ? 'פעיל' : 'מושבת'}</span>
    </summary>
    <div class="ibody">
      ${num('קצב רצוי בשבוע — ממנו נגזר כמה מגיע לכל קמפיין', 'target_per_week', c.target_per_week)}
      ${num('תקרה — מקסימום פוסטים בשבוע', 'max_per_week', c.max_per_week)}
      ${num('מזה — מכירתיים מקסימום', 'max_promo_per_week', c.max_promo_per_week, sw('promo'))}
      ${num('מזה — משולבים מקסימום', 'max_hybrid_per_week', c.max_hybrid_per_week, sw('hybrid'))}
      ${num('מזה — ערך מקסימום', 'max_value_per_week', c.max_value_per_week, sw('value'))}
      ${num('שטח ששמור לדברים דחופים (%)', 'urgent_reserve_pct', c.urgent_reserve_pct)}

      <div class="prow" style="align-items:flex-start">
        <label>ימים שבהם המדיה לא מקבלת תוכן</label>
        <div class="checks" style="justify-content:flex-end">
          ${HE_DAYS.map((d, i) => `<label>
            <input type="checkbox" data-blocked="${c.id}" value="${i}"
                   ${(c.blocked_days ?? []).includes(i) ? 'checked' : ''} ${ro ? 'disabled' : ''}>
            ${d}</label>`).join('')}
        </div>
      </div>
      ${ro ? '' : `<div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn small" data-toggle-channel="${c.id}" data-active="${c.active}">
          ${c.active ? 'השבת ערוץ' : 'הפעל ערוץ'}</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-channel="${c.id}">מחק ערוץ</button>
      </div>`}
    </div>
  </details>`;
}

function systemGroup(users, settings, backups) {
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
      ${backups ? `<details class="item">
        <summary><b>גיבויים אוטומטיים</b>
          <span class="info">${backups.length
            ? `${backups.length} שמורים · אחרון ${fmtDate(ymd(new Date(backups[0].created_at)))}`
            : 'עוד לא רץ גיבוי'}</span></summary>
        <div class="ibody">
          <p class="sub">רץ אוטומטית כל 24 שעות, שומר עותק של כל הטבלאות בתוך ה-DB עצמו
            (בלי קבצים מצורפים — הם כבר בטוחים ב-content_assets). מגן מפני טעות אפליקטיבית,
            לא מפני אובדן הדיסק עצמו — לזה יש את הגיבוי המובנה של Railway ל-Postgres.</p>
          ${backups.length ? `<table class="utable"><thead><tr><th>מתי</th><th>שורות</th></tr></thead>
            <tbody>${backups.slice(0, 10).map((b) => `<tr>
              <td>${esc(new Date(b.created_at).toLocaleString('he-IL'))}</td>
              <td>${b.row_count}</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
      </details>` : ''}
    </div>
  </div>`;
}

function wireManage(ro) {
  const reload = run(async () => { await renderManage(); await renderBoard(); });

  const engineToast = (base, res) =>
    base + (res.engine?.placed ? ` המנוע מילא ${res.engine.placed} משבצות פנויות.` : '');

  // עריכת שדה בשדה — נשמר ביציאה מהשדה
  $$('#manage [data-ep-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { [inp.dataset.epField]: Number(inp.value), week: state.week } });
      toast(engineToast('נשמר.', res));
      await renderBoard();
    })));

  // אוטומטי/קבוע לקצב הפרסום — לא שני שדות שיכולים לסתור זה את זה
  $$('#manage [data-ep-cadence-mode]').forEach((r) =>
    r.addEventListener('change', run(async () => {
      const id = r.dataset.epCadenceMode;
      const input = $(`[data-ep-cadence-input="${id}"]`);
      if (r.value === 'auto') {
        input.disabled = true;
        const res = await api(`/endpoints/${id}`,
          { method: 'PATCH', body: { min_days_between: null, week: state.week } });
        toast(engineToast('נשמר — הקצב יחושב אוטומטית לפי החשיבות.', res));
        await renderBoard();
      } else {
        input.disabled = false;
        input.focus();
      }
    })));

  $$('#manage [data-ep-cadence-input]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const val = inp.value.trim() === '' ? null : Number(inp.value);
      const res = await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { min_days_between: val, week: state.week } });
      toast(engineToast('נשמר.', res));
      await renderBoard();
    })));

  $$('#manage [data-ch-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const raw = inp.value.trim();
      const res = await api(`/channels/${inp.dataset.id}`,
        { method: 'PATCH',
          body: { [inp.dataset.chField]: raw === '' ? null : Number(raw), week: state.week } });
      toast(engineToast('נשמר.', res));
      await renderBoard();
    })));

  // הימים החסומים נשמרים כקבוצה, כי הם מערך אחד ולא שדה בודד
  $$('#manage [data-blocked]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      const id = cb.dataset.blocked;
      const days = $$(`[data-blocked="${id}"]:checked`).map((i) => Number(i.value));
      const res = await api(`/channels/${id}`,
        { method: 'PATCH', body: { blocked_days: days, week: state.week } });
      toast(engineToast(days.length ? `נחסמו ימי ${days.map((d) => HE_DAYS[d]).join(', ')}.`
                        : 'כל הימים פתוחים.', res));
      await renderBoard();
    })));

  $$('#manage [data-engine]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api('/settings',
        { method: 'PATCH', body: { [inp.dataset.engine]: Number(inp.value), week: state.week } });
      toast(engineToast('נשמר.', res));
      await renderBoard();
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
      await api(`/endpoints/${b.dataset.delEndpoint}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!confirm('למחוק את הערוץ? כל השיבוצים בו יימחקו.')) return;
      await api(`/channels/${b.dataset.delChannel}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-toggle-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/channels/${b.dataset.toggleChannel}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true', week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-campaign]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/campaigns/${b.dataset.delCampaign}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-content]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/content/${b.dataset.delContent}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  if (!ro) {
    $('#addEndpoint')?.addEventListener('click', () => openGeneric({
      title: 'נקודת קצה חדשה',
      fields: [
        { name: 'name', label: 'שם', type: 'text' },
        { name: 'importance', label: 'חשיבות (1–10)', type: 'number', value: 5 },
        { name: 'min_days_between', label: 'לפרסם לפחות פעם ב־ (ימים)', type: 'auto',
          value: null, auto: 'נגזר מהחשיבות',
          hint: 'אוטומטי מחשב קצב לפי החשיבות. קבוע נועד למקרה שיש צורך ספציפי בקצב מסוים, ' +
                'בלי קשר לחשיבות.' },
      ],
      onSave: async (v) => {
        v.week = state.week;
        await api('/endpoints', { method: 'POST', body: v });
        await reload();
      },
    }));

    $('#addChannel')?.addEventListener('click', () => openGeneric({
      title: 'ערוץ חדש',
      fields: [
        { name: 'name', label: 'שם הערוץ', type: 'text' },
        { name: 'max_per_week', label: 'מקסימום פרסומים בשבוע', type: 'number', value: 5 },
      ],
      onSave: async (v) => {
        v.week = state.week;
        await api('/channels', { method: 'POST', body: v });
        await reload();
      },
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

/* ========================= נתונים וסטטיסטיקה ========================= */

/** התקופות המוכנות מראש. 'custom' פותח שני שדות תאריך. */
const PERIODS = [['7', '7 ימים'], ['30', '30 יום'], ['90', '90 יום'],
                 ['365', 'שנה'], ['custom', 'טווח מותאם']];

const VIA_HE = { ui: 'ידני', assistant: 'העוזר', system: 'מערכת' };

/** התקופה הנוכחית כפרמטרים ל-API */
function dataRange() {
  if (state.dataPeriod === 'custom') {
    return { from: state.dataFrom, to: state.dataTo };
  }
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (Number(state.dataPeriod) - 1));
  return { from: ymd(from), to: ymd(to) };
}

async function renderData() {
  const { from, to } = dataRange();
  if (state.dataPeriod === 'custom' && (!from || !to)) {
    $('#data').innerHTML = dataToolbar() +
      '<div class="empty">בחרו תאריך התחלה ותאריך סיום.</div>';
    return wireData();
  }

  const qs = `?from=${from}&to=${to}`;
  const [stats, activity] = await Promise.all([
    api(`/stats${qs}`),
    api(`/activity${qs}${state.dataVia ? `&via=${state.dataVia}` : ''}&limit=200`),
  ]);

  $('#data').innerHTML =
    dataToolbar(stats.period) + statCards(stats) + statTables(stats) + activityPanel(activity);
  wireData();
}

function dataToolbar(period) {
  const custom = state.dataPeriod === 'custom';
  return `<div class="toolbar">
    <div class="periodpick">
      ${PERIODS.map(([v, l]) =>
        `<button data-period="${v}"${state.dataPeriod === v ? ' class="on"' : ''}>${esc(l)}</button>`
      ).join('')}
    </div>
    ${custom ? `<span class="daterange">
      <input type="date" id="dFrom" value="${esc(state.dataFrom ?? '')}">
      <span>עד</span>
      <input type="date" id="dTo" value="${esc(state.dataTo ?? '')}">
    </span>` : ''}
    <div class="spacer"></div>
    ${period ? `<span class="periodnote">${esc(period.from)} – ${esc(period.to)} · ${period.days} ימים</span>` : ''}
  </div>`;
}

/** מספר גדול עם כותרת קטנה — התמונה הראשונה שרואים */
function statCards(s) {
  const card = (label, value, note = '', tone = '') =>
    `<div class="statcard${tone ? ` ${tone}` : ''}">
      <div class="v">${esc(value)}</div>
      <div class="l">${esc(label)}</div>
      ${note ? `<div class="n">${esc(note)}</div>` : ''}
    </div>`;

  const perWeek = s.period.days >= 7
    ? `${(s.totals.published / (s.period.days / 7)).toFixed(1)} בשבוע` : '';

  return `<div class="statgrid">
    ${card('פורסם בפועל', s.totals.published, perWeek)}
    ${card('מתוכנן קדימה', s.totals.scheduled)}
    ${card('ממתין לאישור', s.totals.pending, '', s.totals.pending ? 'warn' : '')}
    ${card('חורים', s.totals.holes, 'שיבוץ בלי תוכן', s.totals.holes ? 'bad' : '')}
    ${card('ערך לכל מכירתי', s.value_per_promo ?? '—',
           s.value_per_promo === null ? 'לא פורסם מכירתי' : '')}
    ${card('תכנים חדשים', s.totals.content_created)}
    ${card('משימות שנסגרו', s.tasks.closed,
           s.tasks.avg_hours != null ? `בממוצע ${s.tasks.avg_hours} שעות` : '')}
    ${card('מבצעים דחופים', s.totals.urgent)}
  </div>`;
}

function statTables(s) {
  const bar = (pct, color) =>
    `<span class="minibar"><i style="width:${Math.min(100, Math.max(0, pct))}%;background:${color}"></i></span>`;

  const endpoints = s.endpoints.map((e) => {
    const gap = e.share_actual - e.share_by_weight;
    const tone = Math.abs(gap) <= 5 ? '' : gap < 0 ? 'bad' : 'warn';
    return `<tr>
      <td><span class="dot" style="background:${epColor(e.id)}"></span>${esc(e.name)}</td>
      <td>${e.published}</td>
      <td>${e.placed}</td>
      <td>${bar(e.share_actual, epColor(e.id))} ${e.share_actual}%</td>
      <td class="${tone}">${e.share_by_weight}%</td>
      <td>${e.last_published ? esc(ymd(new Date(e.last_published))) : '—'}</td>
    </tr>`;
  }).join('');

  const channels = s.channels.map((c) => {
    const target = c.target_per_week ?? 0;
    const ratio = target ? Math.round((c.per_week_actual / target) * 100) : 0;
    const tone = !target ? '' : ratio < 70 ? 'bad' : ratio > 115 ? 'warn' : '';
    return `<tr>
      <td>${esc(c.name)}</td>
      <td>${c.published}</td>
      <td>${c.placed}</td>
      <td class="${tone}">${c.per_week_actual}</td>
      <td>${target || '—'}</td>
      <td>${target ? bar(ratio, 'var(--accent)') : ''} ${target ? `${ratio}%` : ''}</td>
    </tr>`;
  }).join('');

  const kinds = ['promo', 'value', 'hybrid'].map((k) =>
    `<span class="kindstat"><i style="background:${KIND_VAR[k]}"></i>${KIND_HE[k]}: <b>${s.kinds[k]}</b></span>`
  ).join('');

  return `<div class="subsec"><h2>מי קיבל שטח</h2>
    <div class="panel"><table class="stattable">
      <thead><tr><th>נקודת קצה</th><th>פורסם</th><th>שובץ</th><th>נתח בפועל</th>
                 <th>לפי משקל</th><th>פרסום אחרון</th></tr></thead>
      <tbody>${endpoints}</tbody></table></div></div>

  <div class="subsec"><h2>קצב לפי ערוץ</h2>
    <div class="panel"><table class="stattable">
      <thead><tr><th>ערוץ</th><th>פורסם</th><th>שובץ</th><th>בשבוע בפועל</th>
                 <th>יעד</th><th>עמידה</th></tr></thead>
      <tbody>${channels}</tbody></table></div>
    <div class="kindrow">תמהיל מה שפורסם: ${kinds}</div></div>`;
}

function activityPanel(a) {
  const rows = a.entries.map((e) => `<tr>
    <td class="when">${esc(hhmm(e.created_at))} · ${esc(ymd(new Date(e.created_at)))}</td>
    <td>${esc(e.user_name)}</td>
    <td><span class="viatag ${esc(e.via)}">${esc(VIA_HE[e.via] ?? e.via)}</span></td>
    <td>${esc(e.summary)}</td>
  </tr>`).join('');

  const filters = [['', 'הכול'], ['ui', 'ידני'], ['assistant', 'העוזר']].map(([v, l]) =>
    `<button data-via="${v}"${state.dataVia === v ? ' class="on"' : ''}>${esc(l)}</button>`
  ).join('');

  return `<div class="subsec"><h2>יומן פעולות
      <span class="periodpick small">${filters}</span></h2>
    <div class="panel">${rows
      ? `<table class="stattable log"><tbody>${rows}</tbody></table>`
      : '<div class="empty">אין פעולות בתקופה הזו.</div>'}</div></div>`;
}

function wireData() {
  $$('#data [data-period]').forEach((b) => b.addEventListener('click', run(async () => {
    state.dataPeriod = b.dataset.period;
    await renderData();
  })));
  $$('#data [data-via]').forEach((b) => b.addEventListener('click', run(async () => {
    state.dataVia = b.dataset.via;
    await renderData();
  })));
  for (const [id, key] of [['#dFrom', 'dataFrom'], ['#dTo', 'dataTo']]) {
    $(id)?.addEventListener('change', run(async (e) => {
      state[key] = e.target.value || null;
      await renderData();
    }));
  }
}

/* ========================= ייבוא תוכן מטבלה ========================= */

let impCampaign = null;

function wireImportDialog() {
  $('#impCancel').addEventListener('click', () => $('#importDlg').close());
  $('#impPick').addEventListener('click', () => $('#impFile').click());

  $('#impFile').addEventListener('change', run(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    // CSV כבר בפורמט שהמערכת מבינה, ואין טעם לשלם על ניתוח.
    // כל השאר — אקסל, וורד, PDF — עובר דרך המודל.
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      $('#impText').value = await file.text();
      return void await checkImport();
    }
    await analyzeFile(file);
  }));

  $('#impCheck').addEventListener('click', run(checkImport));
  // הדבקה היא הדרך הצפויה להגיע לכאן, ולכן היא בודקת מיד
  $('#impText').addEventListener('paste', () => setTimeout(run(checkImport), 60));
}

/**
 * @param {object} campaign
 * @param {Function} reload
 */
function openImport(campaign, reload) {
  impCampaign = { campaign, reload };
  $('#impCampaign').textContent = `— ${campaign.name}`;
  $('#impText').value = '';
  $('#impResult').innerHTML = '';
  $('#impRun').disabled = true;

  const names = (campaign.channels ?? []).map((c) => c.name);
  $('#impHelp').innerHTML = `
    <b>המבנה שהמערכת מצפה לו</b>
    שורה לכל זווית, עמודה לכל מדיה. התא הוא הניסוח של אותה זווית באותה מדיה.
    <table class="imptable">
      <tr><th>כותרת</th><th>סוג</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>
      <tr><td>המסר הראשון</td><td>ערך</td>${names.map(() => '<td>הניסוח למדיה הזו…</td>').join('')}</tr>
    </table>
    <span>עמודת "סוג" מקבלת ערך / מכירתי / משולב, ואם היא חסרה הכול נחשב ערך.
    תא ריק פירושו שאין גרסה למדיה הזו. שורה שהכותרת שלה כבר קיימת בקמפיין מדולגת,
    כך שאפשר לייבא שוב אחרי תיקון בלי ליצור כפילויות.</span>
    <span><b style="display:inline">אין לך את המבנה הזה?</b>
    העלו את המסמך כמו שהוא — Excel, Word או PDF — והמערכת תפרק אותו לטבלה הזו.
    התוצאה תופיע כאן לעריכה, ורק אחרי שתאשרו היא תיכנס.</span>`;

  $('#impRun').onclick = run(async () => {
    const btn = $('#impRun');
    btn.disabled = true;
    try {
      const res = await api(`/campaigns/${campaign.id}/import`, {
        method: 'POST', body: { text: $('#impText').value },
      });
      $('#importDlg').close();
      toast(`יובאו ${res.created} זוויות · ${res.variants} ניסוחים.`);
      await reload();
    } finally {
      btn.disabled = false;
    }
  });

  $('#importDlg').showModal();
  $('#impText').focus();
}

/** מעלה מסמך לניתוח. התוצאה נוחתת בתיבה, ניתנת לעריכה, ואז נבדקת כרגיל. */
async function analyzeFile(file) {
  const out = $('#impResult');
  const btns = [$('#impPick'), $('#impCheck'), $('#impRun')];
  btns.forEach((b) => { b.disabled = true; });
  out.innerHTML = `<div class="impbox loading">
      <span class="spinner"></span>
      <span>קורא את "${esc(file.name)}" ומפרק אותו… מסמך ארוך יכול לקחת דקה.</span>
    </div>`;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/campaigns/${impCampaign.campaign.id}/import/analyze`,
      { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'הניתוח נכשל');

    $('#impText').value = data.tsv;
    const cost = data.usage?.usd
      ? ` · עלות הניתוח ${data.usage.usd < 0.01 ? '<$0.01' : `$${data.usage.usd.toFixed(2)}`}`
      : '';
    out.innerHTML = `<div class="impbox ok"><b>זוהו ${data.count} זוויות</b>
        ${esc(data.layout)}${esc(cost)}</div>` +
      (data.notes?.length
        ? `<div class="impbox warn"><b>מה שכדאי לבדוק</b>${
            data.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`
        : '');
  } catch (e) {
    out.innerHTML = `<div class="impbox bad">${esc(e.message)}</div>`;
    return;
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    $('#impRun').disabled = true;
  }
  // הטבלה בתיבה — עכשיו היא עוברת את אותה בדיקה כמו טבלה שהודבקה ביד
  const notes = $('#impResult').innerHTML;
  await checkImport();
  $('#impResult').innerHTML = notes + $('#impResult').innerHTML;
}

async function checkImport() {
  const text = $('#impText').value.trim();
  const out = $('#impResult');
  $('#impRun').disabled = true;
  if (!text) { out.innerHTML = ''; return; }

  let plan;
  try {
    plan = await api(`/campaigns/${impCampaign.campaign.id}/import/preview`,
      { method: 'POST', body: { text } });
  } catch (e) {
    out.innerHTML = `<div class="impbox bad">${esc(e.message)}</div>`;
    return;
  }

  const t = plan.totals;
  const list = (title, items, cls) => items.length
    ? `<div class="impbox ${cls}"><b>${esc(title)}</b>${
        items.slice(0, 6).map((x) => `<div>${esc(x)}</div>`).join('')}${
        items.length > 6 ? `<div>ועוד ${items.length - 6}…</div>` : ''}</div>`
    : '';

  const sample = plan.items.slice(0, 3).map((i) =>
    `<tr><td>${esc(i.title)}</td><td>${esc(KIND_HE[i.kind])}</td>
         <td>${i.variants.length ? esc(i.variants.map((v) => v.channel_name).join(', ')) : '—'}</td></tr>`
  ).join('');

  out.innerHTML = `
    <div class="impbox ${t.errors ? 'bad' : 'ok'}">
      <b>${t.errors ? 'יש שגיאות — שום דבר לא ייובא' : `ייווצרו ${t.to_create} זוויות ו-${t.variants} ניסוחים`}</b>
      זוהו ${t.rows} שורות · מדיות שזוהו: ${plan.columns.channels.join(', ') || 'אין'}
    </div>
    ${list('שגיאות', plan.errors, 'bad')}
    ${list('שורות שידולגו', plan.skipped, '')}
    ${list('שים לב', plan.warnings, 'warn')}
    ${sample ? `<table class="imptable"><tr><th>כותרת</th><th>סוג</th><th>ניסוחים</th></tr>${sample}</table>` : ''}`;

  $('#impRun').disabled = t.errors > 0 || t.to_create === 0;
}

/* ========================= העוזר ========================= */

/**
 * השיחה נשמרת כאן בלקוח ונשלחת בכל פנייה — השרת חסר מצב.
 * `log` הוא מה שרואים על המסך; `history` הוא מה שהמודל רואה.
 */
const ai = { history: [], log: [], busy: false, ready: null, usd: 0 };

const AI_INTRO = `<div class="aihint"><b>מה אני יכול</b>
להסביר למה הלוח נראה כמו שהוא נראה, לאתר חורים ולהציע מה לעשות איתם.
אני גם יודע לייצר קמפיינים, להזיז שיבוצים ולכתוב ניסוחים למדיות —
אבל כל פעולה עוברת אצלך לאישור לפני שהיא קורית.
במנוע השיבוץ אני לא נוגע: אני יכול להראות מה הוא היה מציע ולמה, לא לשנות אותו.</div>`;

const AI_OPEN_KEY = 'mb_ai_open';

function wireAIWidget() {
  $('#aiFab').addEventListener('click', () => openAI(true));
  $('#aiClose').addEventListener('click', () => openAI(false));
  $('#aiSend').addEventListener('click', run(sendAI));
  $('#aiClear').addEventListener('click', () => {
    ai.history = [];
    ai.log = [];
    ai.usd = 0;
    renderAI();
    $('#aiInput').focus();
  });

  const input = $('#aiInput');
  input.addEventListener('keydown', (e) => {
    // Enter שולח, Shift+Enter יורד שורה
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run(sendAI)();
    }
  });
  // תיבת הכתיבה גדלה עם הטקסט עד לתקרה שנקבעת ב-CSS
  input.addEventListener('input', autosizeAI);

  // Esc סוגר את הווידג'ט כשהמיקוד בתוכו — בלי לפגוע בדיאלוגים
  $('#aiWidget').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openAI(false);
  });

  // נשאר פתוח בין רענונים אם ככה השארת אותו
  if (localStorage.getItem(AI_OPEN_KEY) === '1') openAI(true);
}

function autosizeAI() {
  const el = $('#aiInput');
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const openAI = run(async (open) => {
  localStorage.setItem(AI_OPEN_KEY, open ? '1' : '0');
  $('#aiPanel').hidden = !open;
  $('#aiFab').hidden = open;
  if (!open) return;

  if (ai.ready === null) {
    const { ready } = await api('/assistant/status');
    ai.ready = ready;
  }
  renderAI();
  $('#aiInput').focus();
});

function renderAI() {
  const log = $('#aiLog');
  if (!ai.ready) {
    log.innerHTML = `<div class="aihint"><b>העוזר לא מחובר</b>
      צריך להוסיף משתנה סביבה בשם <code>ANTHROPIC_API_KEY</code> בשירות ב-Railway
      ולהפעיל מחדש. אחרי זה הוא זמין כאן.</div>`;
    return;
  }
  log.innerHTML = (ai.log.length ? '' : AI_INTRO) + ai.log.map(aiEntry).join('');
  log.scrollTop = log.scrollHeight;
  // העלות המצטברת של השיחה — כדי שלא תהיה הפתעה בחשבון
  $('#aiCost').textContent = ai.usd
    ? `${ai.usd < 0.01 ? '<$0.01' : `$${ai.usd.toFixed(2)}`} בשיחה הזו`
    : 'מבצע רק אחרי אישור';
}

function aiEntry(entry, i) {
  if (entry.type === 'proposal') {
    const p = entry.proposal;
    const args = Object.entries(p.args)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    return `<div class="aiprop${entry.state ? ' done' : ''}">
      <div class="t">${esc(p.summary)}</div>
      ${p.warnings?.length
        ? `<div class="w">${p.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
      <div class="args">${esc(args)}</div>
      ${entry.state
        ? `<div class="w" style="color:${entry.state === 'done' ? 'var(--st-ok)' : 'var(--ink-2)'}">${
            entry.state === 'done' ? '✓ בוצע' : 'בוטל'}</div>`
        : `<div class="acts">
             <button class="btn small" data-ai-skip="${i}">לא עכשיו</button>
             <button class="btn small primary" data-ai-ok="${i}">אשר ובצע</button>
           </div>`}
    </div>`;
  }
  const html = entry.role === 'bot' ? aiText(entry.text) : esc(entry.text);
  return `<div class="aimsg ${entry.role}">${html}</div>`;
}

/**
 * העוזר מתבקש לכתוב טקסט רגיל, בלי markdown. מה שכן מותר לו זה שורת
 * רשימה שמתחילה ב-"- ", ולכן רק היא מקבלת טיפול. ההימלטות קודמת להכול,
 * כך שגם אם בכל זאת יגיע תו מסוכן הוא לא ייכנס כ-HTML.
 */
function aiText(text) {
  return esc(text)
    .split('\n')
    .map((line) => {
      if (/^\s*-\s+/.test(line)) {
        return `<span class="li">${line.replace(/^\s*-\s+/, '')}</span>`;
      }
      // רשת ביטחון: אם בכל זאת חוזרת כותרת markdown, מציגים אותה ככותרת
      // ולא כשורה שמתחילה בסולמיות
      if (/^\s*#{1,6}\s+/.test(line)) {
        return `<span class="h">${line.replace(/^\s*#{1,6}\s+/, '')}</span>`;
      }
      return line;
    })
    .join('\n');
}

// לחיצות על כפתורי ההצעות — האזנה אחת על המכל, כי התוכן מצויר מחדש
document.addEventListener('click', (e) => {
  const ok = e.target.closest('[data-ai-ok]');
  const skip = e.target.closest('[data-ai-skip]');
  if (ok) return void run(confirmProposal)(Number(ok.dataset.aiOk));
  if (skip) {
    const entry = ai.log[Number(skip.dataset.aiSkip)];
    if (entry) {
      entry.state = 'skipped';
      ai.history.push({ role: 'user', content: `[המשתמש דחה את ההצעה: ${entry.proposal.summary}]` });
      renderAI();
    }
  }
});

async function sendAI() {
  if (ai.busy) return;
  const input = $('#aiInput');
  const text = input.value.trim();
  if (!text) return;

  ai.busy = true;
  input.value = '';
  autosizeAI();
  ai.log.push({ type: 'msg', role: 'me', text });
  ai.log.push({ type: 'msg', role: 'sys', text: 'חושב…' });
  renderAI();
  $('#aiSend').disabled = true;

  try {
    const res = await api('/assistant/chat', {
      method: 'POST',
      body: { message: text, messages: ai.history },
    });
    ai.history = res.messages;
    ai.usd += res.usage?.usd ?? 0;
    ai.log.pop(); // "חושב…"
    ai.log.push({ type: 'msg', role: 'bot', text: res.reply });
    for (const proposal of res.proposals ?? []) ai.log.push({ type: 'proposal', proposal });
  } catch (e) {
    ai.log.pop();
    ai.log.push({ type: 'msg', role: 'sys', text: `לא הצלחתי: ${e.message}` });
  } finally {
    ai.busy = false;
    $('#aiSend').disabled = false;
    renderAI();
    input.focus();
  }
}

async function confirmProposal(i) {
  const entry = ai.log[i];
  if (!entry || entry.state) return;

  entry.state = 'running';
  renderAI();
  try {
    const res = await api('/assistant/confirm', {
      method: 'POST', body: { proposal_id: entry.proposal.id },
    });
    entry.state = 'done';
    // המודל צריך לדעת שזה קרה — בלי לשלם על סבב נוסף עכשיו
    ai.history.push({
      role: 'user',
      content: `[המשתמש אישר וההצעה בוצעה: ${res.summary}]`,
    });
    toast('בוצע.');
    await refreshAfterAI();
  } catch (e) {
    entry.state = null;
    ai.log.push({ type: 'msg', role: 'sys', text: `הביצוע נכשל: ${e.message}` });
    ai.history.push({
      role: 'user',
      content: `[הביצוע נכשל: ${e.message}. הסבר למשתמש ואל תנסה שוב בלי לתקן.]`,
    });
    throw e;
  } finally {
    renderAI();
  }
}

/** אחרי פעולה שאושרה — לרענן את מה שמוצג מתחת לדיאלוג */
async function refreshAfterAI() {
  const [{ endpoints }, { channels }] = await Promise.all([
    api('/endpoints'), api('/channels'),
  ]);
  state.endpoints = endpoints;
  state.channels = channels;
  rebuildEpColors();
  await Promise.all([renderTab(state.tab), refreshTaskBadge(), refreshAlerts()]);
}

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
      } else if (f.type === 'auto') {
        // מצב "אוטומטי" נשמר כ-null, וזה מה שגורם לשרת לגזור את הערך בעצמו
        const manual = $(`#gen_${f.name}_mode`).checked;
        values[f.name] = manual && el.value !== '' ? Number(el.value) : null;
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
    if (f.type === 'auto') {
      const manual = f.value != null;
      return `<div class="frow"><label>${esc(f.label)}</label>
        <div class="autofield">
          <label class="opt"><input type="radio" name="${id}_r" ${manual ? '' : 'checked'}
                 data-auto-off="${f.name}">
            אוטומטי<b>${esc(f.auto ?? '—')}</b></label>
          <label class="opt"><input type="radio" name="${id}_r" ${manual ? 'checked' : ''}
                 id="${id}_mode" data-auto-on="${f.name}">
            קבוע</label>
          <input id="${id}" type="number" value="${esc(f.value ?? '')}"
                 placeholder="${esc(f.placeholder ?? '')}" ${manual ? '' : 'disabled'}>
        </div>
        ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}
      </div>`;
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
      <input id="${id}" type="${f.type}" value="${esc(f.value ?? '')}">
      ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}</div>`;
  }).join('');

  $$('#genBody [data-auto-on]').forEach((r) => r.addEventListener('change', () => {
    const input = $(`#gen_${r.dataset.autoOn}`);
    input.disabled = false;
    input.focus();
  }));
  $$('#genBody [data-auto-off]').forEach((r) => r.addEventListener('change', () => {
    $(`#gen_${r.dataset.autoOff}`).disabled = true;
  }));

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
      await showTab(b.dataset.goto);
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
  }

  return `<div class="task${t.urgent && !t.done ? ' urgent' : ''}"${t.done ? ' style="opacity:.5"' : ''}>
    <input type="checkbox" data-task-done="${t.id}" ${t.done ? 'checked' : ''}>
    <div class="tx"><b>${esc(t.title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${action}</div>`;
}
