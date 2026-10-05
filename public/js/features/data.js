import { can, epColor, state } from '../core/state.js';
import { KIND_HE, KIND_VAR, fmtDate, hhmm, ymd } from '../core/format.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { api } from '../core/api.js';
import { confirmDialog } from '../core/confirm.js';
import {
  DATA_PERIODS, DEFAULT_DATA_PERIOD, isPreset, localYmd, presetRange,
} from '../core/dataPeriod.js';
import { goToTab } from '../ui/refresh.js';
import { openPostPreview } from '../ui/postDialog.js';

/* ========================= נתונים וסטטיסטיקה ========================= */

const VIA_HE = { ui: 'ידני', assistant: 'העוזר', system: 'מערכת' };

/** התקופה הנוכחית כפרמטרים ל-API. החודשים — לפי שעון ישראל (dataPeriod.js). */
function dataRange() {
  if (state.dataPeriod === 'custom') {
    return { from: state.dataFrom, to: state.dataTo };
  }
  return presetRange(state.dataPeriod) ?? presetRange(DEFAULT_DATA_PERIOD);
}

/**
 * התקופה שנבחרה נזכרת לכל צופה בדפדפן שלו. localStorage יכול לזרוק
 * (גלישה פרטית, חסימה) — אז פשוט חוזרים לברירת המחדל.
 */
const PERIOD_KEY = 'mc.data.period';
let periodRestored = false;

function restorePeriod() {
  if (periodRestored) return;
  periodRestored = true;
  state.dataPeriod = DEFAULT_DATA_PERIOD;
  try {
    const saved = JSON.parse(localStorage.getItem(PERIOD_KEY) ?? 'null');
    if (saved && (isPreset(saved.p) || saved.p === 'custom')) {
      state.dataPeriod = saved.p;
      state.dataFrom = saved.from ?? null;
      state.dataTo = saved.to ?? null;
    }
  } catch { /* ברירת המחדל */ }
}

function savePeriod() {
  try {
    localStorage.setItem(PERIOD_KEY, JSON.stringify(
      { p: state.dataPeriod, from: state.dataFrom, to: state.dataTo }));
  } catch { /* לא נורא — בפעם הבאה ברירת המחדל */ }
}

export async function renderData() {
  restorePeriod();
  const { from, to } = dataRange();
  if (state.dataPeriod === 'custom' && (!from || !to)) {
    $('#data').innerHTML = dataToolbar() +
      '<div class="empty">בחרו תאריך התחלה ותאריך סיום.</div>';
    return wireData();
  }

  const qs = `?from=${from}&to=${to}`;
  const [stats, activity, perf, entry, summary] = await Promise.all([
    api(`/stats${qs}`),
    api(`/activity${qs}${state.dataVia ? `&via=${state.dataVia}` : ''}&limit=200`),
    api(`/performance${qs}`),
    api(`/results${qs}${resultsAll ? '&all=1' : ''}`),
    api(`/results/summary${qs}`),
  ]);

  // הסדר עונה על "מה עבד": מזינים, רואים סכומים, מפרקים, ורק אז הציון היחסי
  $('#data').innerHTML =
    dataToolbar(stats.period) + resultsPanel(entry)
    + `<div id="sumSec">${summaryPanel(summary)}</div>`
    + `<div id="perfSec">${performancePanel(perf)}</div>`
    + `<div class="subsec"><h2>שיבוץ ופעילות בתקופה</h2></div>`
    + statCards(stats) + statTables(stats) + activityPanel(activity);
  wireData();
  restoreDirty();
}

/* ---------- תוצאות לעדכון: הזנה מרוכזת ---------- */

/** השדות בכל שורה, לפי סדר העמודות (וסדר המעבר ב-Enter) */
const RES_FIELDS = ['reach', 'engagement', 'clicks', 'leads', 'note'];
const RES_LABELS = { reach: 'חשיפות', engagement: 'מעורבות', clicks: 'קליקים', leads: 'לידים', note: 'הערה' };

/**
 * שורות ששונו ועוד לא נשמרו: post_id -> רק השדות שהשתנו (מחרוזות כמו
 * שהוקלדו). רק הם נשלחים, והשרת מעדכן רק אותם — כך ערך שמישהו הזין
 * בינתיים מחלון הפוסט לא נדרס בערך הישן שנטען לטבלה.
 * חי מחוץ ל-DOM, כדי שרינדור מחדש של הטאב (סגירת חלון פוסט, רענון)
 * לא ימחק מה שהוקלד — הערכים נשתלים בחזרה בשורות שעדיין מוצגות.
 */
const dirty = new Map();

/** "כולל פוסטים שכבר נמדדו" — ברירת מחדל: רק מה שעוד מחכה */
let resultsAll = false;

/**
 * כמה פוסטים בתקופה עוד בלי תוצאות — מהשרת, ולא ספירת השורות במסך:
 * הרשימה נחתכת ב-500, והמונה חייב לספור גם את מה שלא מוצג.
 */
let pendingCount = 0;

const isMeasuredRow = (r) => ['reach', 'engagement', 'clicks', 'leads'].some((m) => r[m] != null);

function resultRow(p, editable) {
  const dis = editable ? '' : ' disabled';
  // לקורא מסך: "שם הפוסט — חשיפות", כי כותרת העמודה רחוקה מהשדה
  const aria = (f) => `aria-label="${esc(`${p.title} — ${RES_LABELS[f]}`)}"`;
  const num = (f) => `<td class="resnum"><input type="number" min="0" step="1" inputmode="numeric"
      data-f="${f}" data-orig="${p[f] ?? ''}" value="${p[f] ?? ''}" ${aria(f)}${dis}></td>`;
  const cls = p.has_results && isMeasuredRow(p) ? ' class="measured"' : '';
  return `<tr data-res-row="${p.id}" data-had="${p.has_results ? 1 : 0}"${cls}>
    <td class="when">${esc(fmtDate(localYmd(new Date(p.published_at))))}</td>
    <td>${esc(p.channel_name ?? '—')}</td>
    <td>${esc(p.endpoint_name ?? '—')}</td>
    <td class="restitle"><button type="button" class="linkbtn" data-open-post="${p.id}">${esc(p.title)}</button>
      <div class="reserr" hidden></div></td>
    ${num('reach')}${num('engagement')}${num('clicks')}${num('leads')}
    <td class="resnote"><input type="text" data-f="note" data-orig="${esc(p.note ?? '')}"
      value="${esc(p.note ?? '')}" placeholder="הערה" ${aria('note')}${dis}></td>
  </tr>`;
}

function resultsPanel(entry) {
  const editable = can('content');
  const list = entry.posts;
  pendingCount = entry.pending;
  const head = `<h2>תוצאות לעדכון (<span id="resPending">${entry.pending}</span>)
      <label class="restoggle"><input type="checkbox" id="resAll"${resultsAll ? ' checked' : ''}>
        כולל פוסטים שכבר נמדדו</label></h2>`;

  if (!list.length) {
    const none = entry.published === 0;
    const msg = none
      ? 'אין פוסטים שפורסמו בתקופה הזו. פוסט מגיע לכאן אחרי שמסמנים אותו "פורסם" בלוח.'
      : 'כל הפוסטים שפורסמו בתקופה הזו כבר נמדדו.';
    const btn = none
      ? '<button class="btn small" data-goto="board">ללוח</button>'
      : '<button class="btn small" data-res-all="1">הצג גם את מה שנמדד</button>';
    return `<div class="subsec" id="resultsSec">${head}
      <div class="panel"><div class="empty">${msg} ${btn}</div></div></div>`;
  }

  // הרשימה מוגבלת בשרת — אומרים כמה לא מוצגים, ולא מעמידים פנים שזה הכול
  const total = resultsAll ? entry.published : entry.pending;
  const trunc = list.length < total
    ? `<p class="sechint">מוצגים ${list.length} מתוך ${total} — לצמצם את התקופה כדי לראות את השאר.</p>`
    : '';

  return `<div class="subsec" id="resultsSec">${head}
    <p class="sechint">שדה ריק = לא נמדד (לא נספר בחישוב). 0 = נמדד ויצא אפס.
      Enter עובר לאותו שדה בשורה הבאה.</p>${trunc}
    <div class="panel restable-wrap"><table class="stattable restable">
      <thead><tr><th>פורסם</th><th>ערוץ</th><th>נקודת קצה</th><th>פוסט</th>
        <th>חשיפות</th><th>מעורבות</th><th>קליקים</th><th>לידים</th><th>הערה</th></tr></thead>
      <tbody>${list.map((p) => resultRow(p, editable)).join('')}</tbody>
    </table></div>
    ${editable
      ? `<div class="resbar"><button class="btn primary" id="resSave" disabled>שמור הכול (0)</button>
          <span class="resmsg" id="resMsg"></span></div>`
      : '<p class="sechint">אין לך הרשאה להזין תוצאות (נדרשת הרשאת "תוכן ושיבוץ").</p>'}
  </div>`;
}

/** השדות בשורה ששונו ממה שנטען (רק הם), והאם יש קלט שאינו מספר */
function readRow(tr) {
  const changed = {};
  let bad = false;
  for (const f of RES_FIELDS) {
    const inp = tr.querySelector(`[data-f="${f}"]`);
    if (inp.value !== inp.dataset.orig) changed[f] = inp.value;
    if (inp.validity?.badInput) bad = true;          // "abc" בשדה מספר — הערך נקרא כריק
  }
  return { changed, bad };
}

function paintSaveButton() {
  const btn = $('#resSave');
  if (!btn) return;
  btn.disabled = dirty.size === 0;
  btn.textContent = `שמור הכול (${dirty.size})`;
}

function markRow(tr) {
  const id = Number(tr.dataset.resRow);
  const { changed } = readRow(tr);
  const isDirty = Object.keys(changed).length > 0;
  if (isDirty) dirty.set(id, changed); else dirty.delete(id);
  tr.classList.toggle('dirty', isDirty);
  tr.classList.remove('err', 'saved');
  tr.querySelector('.reserr').hidden = true;
  paintSaveButton();
}

/** אחרי רינדור מחדש: הערכים שהוקלדו חוזרים לשורות שעדיין מוצגות */
function restoreDirty() {
  for (const [id, vals] of [...dirty]) {
    const tr = $(`#data [data-res-row="${id}"]`);
    if (!tr) { dirty.delete(id); continue; }
    for (const [f, v] of Object.entries(vals)) tr.querySelector(`[data-f="${f}"]`).value = v;
    markRow(tr);
  }
  paintSaveButton();
}

function showRowError(id, msg) {
  const tr = $(`#data [data-res-row="${id}"]`);
  if (!tr) return;
  tr.classList.add('err');
  const box = tr.querySelector('.reserr');
  box.textContent = msg;
  box.hidden = false;
}

async function saveResults() {
  if (!dirty.size) return;
  // קלט שהדפדפן לא הצליח לקרוא כמספר — עוצרים כאן, אחרת הוא נשלח כריק
  const unreadable = [...dirty.keys()].filter((id) =>
    readRow($(`#data [data-res-row="${id}"]`)).bad);
  if (unreadable.length) {
    unreadable.forEach((id) => showRowError(id, 'יש כאן ערך שאינו מספר'));
    toast('יש ערכים שאינם מספרים — שום דבר לא נשמר', true);
    return;
  }

  // רק השדות שהשתנו — השרת לא נוגע בשאר (עדכון חלקי)
  const items = [...dirty].map(([post_id, v]) => ({ post_id, ...v }));
  const btn = $('#resSave');
  btn.disabled = true;
  btn.textContent = 'שומר…';
  let out;
  try {
    out = await api('/results', { method: 'PUT', body: { items } });
  } catch (e) {
    // הכול או כלום: השרת מחזיר שגיאה לכל שורה, ושום שורה לא נשמרה
    for (const er of e.payload?.errors ?? []) {
      if (er.index >= 0) showRowError(items[er.index].post_id, er.error);
    }
    paintSaveButton();
    throw e;
  }

  // עדכון במקום — בלי רינדור של הטאב, כדי שהגלילה והמיקום יישארו. השרת
  // מחזיר את המצב המלא אחרי המיזוג, כולל שדות שמישהו אחר מילא בינתיים.
  for (const r of out.results) {
    const tr = $(`#data [data-res-row="${r.post_id}"]`);
    if (!tr) continue;
    for (const f of RES_FIELDS) {
      const inp = tr.querySelector(`[data-f="${f}"]`);
      const v = r.cleared ? '' : String(r[f] ?? '');
      inp.value = v;
      inp.dataset.orig = v;
    }
    // המונה זז מהערך של השרת: פוסט שקיבל תוצאה ראשונה יורד, פוסט שנוקה חוזר
    const had = tr.dataset.had === '1';
    if (!had && !r.cleared) pendingCount -= 1;
    if (had && r.cleared) pendingCount += 1;
    tr.dataset.had = r.cleared ? '0' : '1';
    tr.classList.remove('dirty', 'err');
    tr.classList.add('saved');
    tr.classList.toggle('measured', !r.cleared && isMeasuredRow(r));
    dirty.delete(r.post_id);
  }
  $('#resPending').textContent = pendingCount;
  paintSaveButton();
  $('#resMsg').textContent = out.cleared
    ? `נשמרו ${out.saved} · נוקו ${out.cleared}` : `נשמרו ${out.saved}`;
  toast(`התוצאות נשמרו (${out.saved + out.cleared})`);
  await refreshBelow();
}

/** מה שמחושב מהתוצאות — מתעדכן אחרי שמירה בלי לגעת בטבלת ההזנה */
async function refreshBelow() {
  const { from, to } = dataRange();
  const qs = `?from=${from}&to=${to}`;
  const [summary, perf] = await Promise.all([
    api(`/results/summary${qs}`), api(`/performance${qs}`),
  ]);
  $('#sumSec').innerHTML = summaryPanel(summary);
  $('#perfSec').innerHTML = performancePanel(perf);
}

/* ---------- סיכום גולמי ופילוחים ---------- */

const METRIC_COLS = [['reach', 'חשיפות'], ['engagement', 'מעורבות'],
                     ['clicks', 'קליקים'], ['leads', 'לידים']];

/** לפי מה נבחר "הכי טוב" — לכותרת המשנה של הטבלה */
const TOP_BY_HE = {
  leads: 'לידים לפוסט נמדד',
  clicks: 'קליקים לפוסט נמדד (אין עדיין לידים להשוואה)',
  engagement: 'מעורבות לפוסט נמדד (אין עדיין לידים או קליקים להשוואה)',
};

const num = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL'));

/** סכום גולמי, ומתחתיו הממוצע לפוסט שבו המדד נמדד. ריק = "—", לא 0. */
const metricCell = (r, m) => (r[m] == null
  ? '<td class="metric"><span class="nm">—</span></td>'
  : `<td class="metric">${num(r[m])}<span class="avg">${num(r[`avg_${m}`])} לפוסט</span></td>`);

function breakdownTable(title, block) {
  const rows = block.rows.map((r) => `<tr${r.top ? ' class="top"' : ''}>
    <td>${esc(r.name)}${r.top ? '<span class="topmark"><i></i>הכי טוב</span>' : ''}</td>
    <td>${r.posts}</td>
    <td>${r.measured}<span class="avg">${r.measured_pct}%</span></td>
    ${METRIC_COLS.map(([m]) => metricCell(r, m)).join('')}
  </tr>`).join('');
  const note = block.top_metric ? `<p class="sechint">"הכי טוב" לפי ${TOP_BY_HE[block.top_metric]}.</p>` : '';
  return `<div class="subsec"><h3 class="bdtitle">${esc(title)}</h3>${note}
    <div class="panel restable-wrap"><table class="stattable bdtable">
      <thead><tr><th>${esc(title.replace('לפי ', ''))}</th><th>פוסטים</th><th>נמדדו</th>
        ${METRIC_COLS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}

function summaryPanel(s) {
  const t = s.totals;
  if (!t.posts) {
    return `<div class="subsec"><h2>סיכום</h2><div class="panel">
      <div class="empty">אין פוסטים שפורסמו בתקופה הזו — אין מה לסכם.
        ${state.dataPeriod === '365' ? '' : '<button class="btn small" data-period="365">הצג שנה אחרונה</button>'}</div>
    </div></div>`;
  }

  const card = (label, value, note = '') => `<div class="statcard">
      <div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>
      ${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
  const metricCard = (m, label) => card(label, num(t[m]),
    t[m] == null ? 'לא נמדד' : `${num(t[`avg_${m}`])} לפוסט נמדד`);

  const cards = `<div class="statgrid">
    ${card('פוסטים שפורסמו', num(t.posts))}
    ${METRIC_COLS.map(([m, l]) => metricCard(m, l)).join('')}
    ${card('% פוסטים שנמדדו', `${t.measured_pct}%`, `${t.measured} מתוך ${t.posts}`)}
  </div>`;

  const hint = t.measured
    ? ''
    : '<p class="sechint">עוד לא הוזנו תוצאות בתקופה הזו — ממלאים בטבלה למעלה, והסכומים יופיעו כאן.</p>';

  return `<div class="subsec"><h2>סיכום</h2>${hint}${cards}</div>
    <div class="subsec"><h2>פילוחים</h2>
      <p class="sechint">סכומים כמו שהוזנו; מתחת לכל סכום — הממוצע לפוסט שבו המדד נמדד.</p></div>
    ${breakdownTable('לפי ערוץ', s.by_channel)}
    ${breakdownTable('לפי נקודת קצה', s.by_endpoint)}
    ${breakdownTable('לפי סוג', s.by_kind)}
    ${breakdownTable('לפי קמפיין', s.by_campaign)}`;
}

/** יציאה מהטאב / שינוי תקופה כשיש שורות שלא נשמרו */
async function confirmDiscard() {
  if (!dirty.size) return true;
  const ok = await confirmDialog(
    dirty.size === 1
      ? 'יש שורה אחת עם תוצאות שלא נשמרו. להמשיך בלי לשמור?'
      : `יש ${dirty.size} שורות עם תוצאות שלא נשמרו. להמשיך בלי לשמור?`,
    { okLabel: 'להמשיך בלי לשמור', danger: true });
  if (ok) dirty.clear();
  return ok;
}

/**
 * הגנה על עבודה: מעבר לטאב אחר (או לפעמון) בזמן שיש שורות שלא נשמרו
 * שואל קודם. מאזין capture על המסמך — נתפס לפני הניווט של app.js — ונרשם
 * פעם אחת בלבד. סגירת הדף/רענון: beforeunload של הדפדפן.
 */
let guardWired = false;
function wireLeaveGuard() {
  if (guardWired) return;
  guardWired = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('.tab, #btnAlerts');
    if (!el || !dirty.size || state.tab !== 'data') return;
    const target = el.matches('.tab') ? el.dataset.t : 'tasks';
    if (target === 'data') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    run(async () => { if (await confirmDiscard()) await goToTab(target); })();
  }, true);
  window.addEventListener('beforeunload', (e) => {
    if (!dirty.size) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function wireResults() {
  wireLeaveGuard();
  const table = $('#data .restable');
  table?.addEventListener('input', (e) => {
    const tr = e.target.closest('[data-res-row]');
    if (tr && e.target.dataset.f) markRow(tr);
  });
  // Enter: לאותו שדה בשורה הבאה (Shift+Enter — בקודמת), כמו בגיליון
  table?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.dataset?.f) return;
    e.preventDefault();
    const tr = e.target.closest('[data-res-row]');
    const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
    const inp = next?.querySelector(`[data-f="${e.target.dataset.f}"]`);
    if (inp) { inp.focus(); inp.select?.(); }
  });
  $('#resSave')?.addEventListener('click', run(saveResults));
  $('#resAll')?.addEventListener('change', run(async (e) => {
    if (!e.target.checked && !(await confirmDiscard())) { e.target.checked = true; return; }
    resultsAll = e.target.checked;
    await renderData();
  }));
  $$('#data [data-res-all]').forEach((b) => b.addEventListener('click', run(async () => {
    resultsAll = true;
    await renderData();
  })));
  // חלון הפוסט יכול לשנות את התוצאות של אותו פוסט — בסגירה מרנדרים מחדש
  // (השורות שלא נשמרו נשתלות בחזרה), כדי שהטבלה לא תציג ערכים ישנים
  $$('#data [data-open-post]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await openPostPreview(b.dataset.openPost);
      $('#postDlg').addEventListener('close', run(renderData), { once: true });
    })));
  $$('#data [data-goto]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (await confirmDiscard()) await goToTab(b.dataset.goto);
    })));
}

/* ---------- ביצועים מנורמלים ---------- */

/**
 * הציון מרוכז סביב 1.0: מעל = עבד טוב יותר מהממוצע, מתחת = פחות.
 * הפס מציג את הסטייה משני צדי אמצע, ולא מילוי מ-0 — כי 0 חסר משמעות כאן.
 */
function effBar(score) {
  const dev = Math.max(-1, Math.min(1, score - 1));   // -1..+1
  const half = Math.abs(dev) * 50;
  const color = dev >= 0 ? 'var(--st-good)' : 'var(--st-warn)';
  const style = dev >= 0
    ? `inset-inline-start:50%;width:${half}%`
    : `inset-inline-start:${50 - half}%;width:${half}%`;
  return `<span class="effbar"><i style="${style};background:${color}"></i><span class="mid"></span></span>`;
}

function effRows(list, labelKey) {
  return list.map((x) => `<tr>
    <td>${esc(x[labelKey])}</td>
    <td>${effBar(x.score)}</td>
    <td class="effscore">${x.n ? x.score.toFixed(2) : '—'}</td>
    <td class="effn">${x.n ? `${x.n} פוסטים` : 'אין מדידות'}</td>
  </tr>`).join('');
}

/**
 * האם הציונים האלה מזיזים את הלוח — המתג use_performance בניהול. בלי
 * השורה הזו אין דרך לדעת מכאן אם המספרים רק מוצגים או גם משבצים.
 */
function engineLine(p) {
  const on = p.use_performance;
  return `<div class="engline">
    <span class="engstate ${on ? 'on' : 'off'}"><i></i>השפעה על השיבוץ: ${on ? 'פעילה' : 'כבויה'}</span>
    <span class="enghint">${on
      ? 'המנוע מעדיף נקודות, ערוצים, ימים ושעות עם ציון גבוה.'
      : 'הציונים רק מוצגים כאן ולא משנים את הלוח.'}</span>
    <button class="btn small" data-goto-perf>לשינוי בניהול</button>
  </div>`;
}

/** מעבר להגדרה עצמה: טאב ניהול, פתיחת "מתקדם — כללי המנוע" וגלילה אל המתג */
async function goToPerfSetting() {
  if (!(await confirmDiscard())) return;
  await goToTab('manage');
  const box = $('#engUsePerf');
  if (!box) return toast('ההגדרה נמצאת בניהול ← מערכת ← "מתקדם — כללי המנוע"');
  const details = box.closest('details');
  if (details) details.open = true;
  box.scrollIntoView({ block: 'center' });
  box.focus();
}

function performancePanel(p) {
  const head = `<tr><th>שם</th><th></th><th>ציון</th><th>מדגם</th></tr>`;
  const table = (title, list, labelKey) => `
    <div class="subsec"><h3 class="bdtitle">${esc(title)}</h3><div class="panel restable-wrap">
      <table class="stattable"><thead>${head}</thead>
      <tbody>${effRows(list, labelKey)}</tbody></table>
    </div></div>`;

  if (!p.measured) {
    return `<div class="subsec"><h2>ביצועים מנורמלים</h2>${engineLine(p)}<div class="panel">
      <div class="empty">עוד אין תוצאות מוזנות בתקופה הזו.
      ממלאים כמה מספרים בטבלה למעלה — אחרי כמה פוסטים יופיע כאן ציון ביצועים.</div>
    </div></div>`;
  }

  const combos = p.combos.length
    ? `<div class="subsec"><h3 class="bdtitle">שילובים שנמדדו בפועל</h3><div class="panel restable-wrap">
        <table class="stattable">
          <thead><tr><th>ערוץ</th><th>מתי</th><th></th><th>ציון</th><th>מדגם</th></tr></thead>
          <tbody>${p.combos.map((c) => `<tr>
            <td>${esc(c.channel_name)}</td>
            <td>${esc(c.dow_label)} · ${esc(c.bucket_label)}</td>
            <td>${effBar(c.score)}</td>
            <td class="effscore">${c.score.toFixed(2)}</td>
            <td class="effn">${c.n} פוסטים</td>
          </tr>`).join('')}</tbody>
        </table></div></div>`
    : `<div class="subsec"><h3 class="bdtitle">שילובים שנמדדו בפועל</h3><div class="panel">
        <div class="empty">עוד אין שילוב אחד עם מספיק מדידות (צריך 3 לפחות לאותו ערוץ·יום·שעה).</div>
      </div></div>`;

  // רשימת "ממתינים להזנת תוצאות" שהייתה כאן עברה לטבלת ההזנה בראש הטאב
  return `<div class="subsec"><h2>ביצועים מנורמלים</h2>${engineLine(p)}
      <p class="sechint">
        1.00 = ממוצע. הציון מנורמל בתוך כל ערוץ ומכווץ לפי גודל המדגם,
        כך שפוסט בודד מוצלח לא קובע. ${p.measured} פוסטים נמדדו בתקופה.
      </p></div>
    ${table('לפי נקודת קצה', p.endpoints, 'name')}
    ${table('לפי ערוץ', p.channels, 'name')}
    ${table('לפי יום בשבוע', p.days, 'label')}
    ${table('לפי שעה ביום', p.buckets, 'label')}
    ${combos}`;
}

function dataToolbar(period) {
  const custom = state.dataPeriod === 'custom';
  return `<div class="toolbar">
    <div class="periodpick">
      ${DATA_PERIODS.map(([v, l]) =>
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

/** מספר גדול עם כותרת קטנה — מצב השיבוץ בתקופה (התוצאות עצמן בסיכום למעלה) */
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
    ${card('חסר תוכן', s.totals.holes, 'פוסטים בלי תוכן', s.totals.holes ? 'bad' : '')}
    ${card('ערך לכל מכירתי', s.value_per_promo ?? '—',
           s.value_per_promo === null ? 'לא פורסם מכירתי' : '')}
    ${card('תכנים חדשים', s.totals.content_created)}
    ${card('משימות שנסגרו', s.tasks.closed,
           s.tasks.avg_hours != null ? `בממוצע ${s.tasks.avg_hours} שעות` : '')}
    ${card('מבצעים דחופים', s.totals.urgent)}
  </div>`;
}

/** שורת מצב ריק בתוך טבלה — אותה שורה אחת שאומרת מה לעשות */
const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${esc(msg)}</td></tr>`;

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

  return `<div class="subsec"><h3 class="bdtitle">מי קיבל שטח</h3>
    <div class="panel restable-wrap"><table class="stattable">
      <thead><tr><th>נקודת קצה</th><th>פורסם</th><th>שובץ</th><th>נתח בפועל</th>
                 <th>לפי חשיבות</th><th>פרסום אחרון</th></tr></thead>
      <tbody>${endpoints || emptyRow(6, 'אין נקודות קצה — מוסיפים בניהול.')}</tbody></table></div></div>

  <div class="subsec"><h3 class="bdtitle">פוסטים בשבוע לפי ערוץ</h3>
    <div class="panel restable-wrap"><table class="stattable">
      <thead><tr><th>ערוץ</th><th>פורסם</th><th>שובץ</th><th>בשבוע בפועל</th>
                 <th>יעד</th><th>עמידה</th></tr></thead>
      <tbody>${channels || emptyRow(6, 'אין ערוצים — מוסיפים בניהול.')}</tbody></table></div>
    <div class="kindrow">תמהיל מה שפורסם: ${kinds}</div></div>`;
}

function activityPanel(a) {
  const rows = a.entries.map((e) => `<tr>
    <td class="when">${esc(hhmm(e.created_at))} · ${esc(ymd(new Date(e.created_at)))}</td>
    <td>${esc(e.user_name)}</td>
    <td><span class="viatag ${esc(e.via)}">${esc(VIA_HE[e.via] ?? e.via)}</span></td>
    <td>${esc(e.summary)}</td>
  </tr>`).join('');

  // "מערכת" = מה שקרה בלי שאדם לחץ: תחזוקה ופרסום אוטומטי (via='system', בלי משתמש)
  const filters = [['', 'הכול'], ['ui', 'ידני'], ['assistant', 'העוזר'], ['system', 'מערכת']].map(([v, l]) =>
    `<button data-via="${v}"${state.dataVia === v ? ' class="on"' : ''}>${esc(l)}</button>`
  ).join('');

  return `<div class="subsec"><h2>יומן פעולות
      <span class="periodpick small">${filters}</span></h2>
    <div class="panel">${rows
      ? `<table class="stattable log"><tbody>${rows}</tbody></table>`
      : `<div class="empty">${state.dataVia
        ? 'אין פעולות מהסוג הזה בתקופה. "הכול" מציג את כל היומן.'
        : 'אין פעולות בתקופה הזו.'}</div>`}</div></div>`;
}

function wireData() {
  wireResults();
  // מואצל: #perfSec מצויר מחדש אחרי שמירת תוצאות, והכפתור נוצר מחדש איתו
  $('#perfSec')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-perf]')) run(goToPerfSetting)();
  });
  $$('#data [data-period]').forEach((b) => b.addEventListener('click', run(async () => {
    if (!(await confirmDiscard())) return;
    state.dataPeriod = b.dataset.period;
    savePeriod();
    await renderData();
  })));
  $$('#data [data-via]').forEach((b) => b.addEventListener('click', run(async () => {
    state.dataVia = b.dataset.via;
    await renderData();
  })));
  for (const [id, key] of [['#dFrom', 'dataFrom'], ['#dTo', 'dataTo']]) {
    $(id)?.addEventListener('change', run(async (e) => {
      if (!(await confirmDiscard())) { e.target.value = state[key] ?? ''; return; }
      state[key] = e.target.value || null;
      savePeriod();
      await renderData();
    }));
  }
}
