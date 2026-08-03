import { epColor, state } from '../core/state.js';
import { KIND_HE, KIND_VAR, hhmm, ymd } from '../core/format.js';
import { $, $$, esc, run } from '../core/dom.js';
import { api } from '../core/api.js';
import { openPostPreview } from '../ui/postDialog.js';

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

export async function renderData() {
  const { from, to } = dataRange();
  if (state.dataPeriod === 'custom' && (!from || !to)) {
    $('#data').innerHTML = dataToolbar() +
      '<div class="empty">בחרו תאריך התחלה ותאריך סיום.</div>';
    return wireData();
  }

  const qs = `?from=${from}&to=${to}`;
  const [stats, activity, perf] = await Promise.all([
    api(`/stats${qs}`),
    api(`/activity${qs}${state.dataVia ? `&via=${state.dataVia}` : ''}&limit=200`),
    api(`/performance${qs}`),
  ]);

  $('#data').innerHTML =
    dataToolbar(stats.period) + statCards(stats) + statTables(stats)
    + performancePanel(perf) + activityPanel(activity);
  wireData();
}

/* ---------- יעילות נמדדת ---------- */

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

function performancePanel(p) {
  const head = `<tr><th>שם</th><th></th><th>ציון</th><th>מדגם</th></tr>`;
  const table = (title, list, labelKey) => `
    <div class="subsec"><h2>${esc(title)}</h2><div class="panel">
      <table class="stattable"><thead>${head}</thead>
      <tbody>${effRows(list, labelKey)}</tbody></table>
    </div></div>`;

  if (!p.measured) {
    return `<div class="subsec"><h2>יעילות נמדדת</h2><div class="panel">
      <div class="empty">עוד אין תוצאות מוזנות בתקופה הזו.
      פותחים פוסט שפורסם בלוח וממלאים כמה מספרים — אחרי כמה פוסטים יופיע כאן מדד יעילות.</div>
    </div></div>`;
  }

  const combos = p.combos.length
    ? `<div class="subsec"><h2>שילובים שנמדדו בפועל</h2><div class="panel">
        <table class="stattable">
          <thead><tr><th>מדיה</th><th>מתי</th><th></th><th>ציון</th><th>מדגם</th></tr></thead>
          <tbody>${p.combos.map((c) => `<tr>
            <td>${esc(c.channel_name)}</td>
            <td>${esc(c.dow_label)} · ${esc(c.bucket_label)}</td>
            <td>${effBar(c.score)}</td>
            <td class="effscore">${c.score.toFixed(2)}</td>
            <td class="effn">${c.n} פוסטים</td>
          </tr>`).join('')}</tbody>
        </table></div></div>`
    : `<div class="subsec"><h2>שילובים שנמדדו בפועל</h2><div class="panel">
        <div class="empty">עוד אין שילוב אחד עם מספיק מדידות (צריך 3 לפחות לאותו מדיה·יום·שעה).</div>
      </div></div>`;

  const pending = p.pending.length
    ? `<div class="subsec"><h2>ממתינים להזנת תוצאות</h2><div class="panel">
        <table class="stattable">
          <thead><tr><th>פוסט</th><th>מדיה</th><th>נקודת קצה</th><th>פורסם</th><th></th></tr></thead>
          <tbody>${p.pending.map((x) => `<tr>
            <td>${esc(x.title)}</td>
            <td>${esc(x.channel_name ?? '—')}</td>
            <td>${esc(x.endpoint_name ?? '—')}</td>
            <td>${esc(ymd(new Date(x.published_at)))}</td>
            <td><button class="btn small" data-fill-post="${x.id}">הזן</button></td>
          </tr>`).join('')}</tbody>
        </table></div></div>`
    : '';

  return `<div class="subsec"><h2>יעילות נמדדת</h2>
      <p class="sub" style="color:var(--muted);font-size:12px;margin-bottom:10px">
        1.00 = ממוצע. הציון מנורמל בתוך כל מדיה ומכווץ לפי גודל המדגם,
        כך שפוסט בודד מוצלח לא קובע. ${p.measured} פוסטים נמדדו בתקופה.
      </p></div>
    ${table('לפי נקודת קצה', p.endpoints, 'name')}
    ${table('לפי מדיה', p.channels, 'name')}
    ${table('לפי יום בשבוע', p.days, 'label')}
    ${table('לפי שעה ביום', p.buckets, 'label')}
    ${combos}
    ${pending}`;
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

  // "הזן" מרשימת הממתינים — פותח את אותו דיאלוג פוסט, ומרענן בסגירה
  $$('#data [data-fill-post]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await openPostPreview(b.dataset.fillPost);
      $('#postDlg').addEventListener('close', run(renderData), { once: true });
    })));
}
