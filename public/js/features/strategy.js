import { $, $$, esc, run, toast } from '../core/dom.js';
import { fmtDate, ymd } from '../core/format.js';
import { api } from '../core/api.js';
import { can, epColor, rebuildEpColors, state } from '../core/state.js';
import { goToTab, refreshBoard } from '../ui/refresh.js';
import { engineToast } from '../ui/engineDialog.js';
import { openGeneric } from '../ui/dialog.js';
import {
  addDays as addDaysP, inferPeriod, periodLabel, rerunPeriod, runName, spanDays,
} from '../core/period.js';

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

export async function renderStrategy() {
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
          חשיבות ונתח של קמפיין נקבעים בטופס הקמפיין, בטאב "קמפיינים ותוכן";
          חשיבות ותדירות של נקודת קצה — בטאב "ניהול".</p>
      </div>
    </div>

    <div class="panel" style="margin-bottom:18px">${gantt(data)}</div>

    ${recurringSection(data.recurring ?? [], hasTimeline(data))}

    <div class="panel" style="max-width:640px">${allocPanel(data.allocation)}</div>`;

  wireStrategy();
  wireRecurring(data.recurring ?? []);
}

/** יש על מה לצייר את הציר: קמפיין פעיל אחד לפחות עם תאריכים */
const hasTimeline = (data) =>
  data.endpoints.some((e) => e.campaigns.some((c) => c.active && c.starts_on && c.ends_on));

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
    <div class="gnote">קפסולה נגררת בקפיצות של חצי חודש. כמה פוסטים מגיעים לקמפיין
      בכל ערוץ נגזר מהקצב הרצוי של הערוץ, מאורך הקמפיין ומהנתח שלו — נתח שנקבע ידנית,
      או חלק יחסי לפי חשיבות הקמפיין מול כל הקמפיינים שרצים באותו זמן. מי תופס כל
      משבצת פנויה נקבע לפי חשיבות נקודת הקצה והזמן שעבר מהפוסט האחרון שלה.</div>
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

/* ---------- קמפיינים מחזוריים: תבניות ל"שבץ מחדש" ---------- */

/** 31.3, ובשנה אחרת מהנוכחית 31.3.27 */
function dateLabel(d) {
  if (!d) return '—';
  return d.slice(0, 4) === String(new Date().getFullYear())
    ? fmtDate(d) : `${fmtDate(d)}.${d.slice(2, 4)}`;
}

/** אורך התקופה של התבנית, כמו שההרצה החדשה תקבל אותה */
function templatePeriod(t) {
  const p = t.period ?? (t.starts_on && t.ends_on ? inferPeriod(t.starts_on, t.ends_on) : null);
  if (p === 'custom' && t.starts_on && t.ends_on) return `${spanDays(t.starts_on, t.ends_on)} ימים`;
  if (!p || p === 'open') return 'בלי תאריך סיום';
  return periodLabel(p);
}

/** ראשון הבא (לא היום) — ברירת המחדל כשאין הרצה שנגמרת בעתיד */
function nextSunday() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay() || 7));
  return ymd(d);
}

/** תאריך היעד המוצע: היום שאחרי סוף ההרצה האחרונה, או ראשון הבא */
function suggestedStart(t) {
  const after = t.last_run_ends_on ? addDaysP(t.last_run_ends_on, 1) : null;
  return after && after > ymd(new Date()) ? after : nextSunday();
}

function recurringSection(list, timeline) {
  const settings = can('settings');
  // גרירה אל הציר — רק כשיש ציר לגרור אליו
  const drag = settings && timeline;
  const rows = list.map((t) => {
    const unit = t.structure === 'general' ? 'פוסטים' : 'זוויות';
    const runs = t.runs
      ? `${t.runs === 1 ? 'הרצה אחת' : `${t.runs} הרצות`} מהתבנית`
      : 'התבנית עצמה — עוד לא שובץ מחדש';
    return `<div class="rrow"${drag ? ` draggable="true" data-tpl-drag="${t.id}"` : ''}>
      <button type="button" class="rname" data-open-tpl="${t.id}"
        data-tt="פתיחת התבנית בטאב &quot;קמפיינים ותוכן&quot;">
        <i class="dot" style="background:${epColor(t.endpoint_id)}"></i>
        <span>${esc(t.name)}</span></button>
      <span class="rcell">${esc(t.endpoint_name)}</span>
      <span class="rcell" data-label="תקופה">${esc(templatePeriod(t))}</span>
      <span class="rcell num">${t.content_count} ${unit}</span>
      <span class="rcell num" data-label="הרצה אחרונה" data-tt="${esc(runs)}">${dateLabel(t.last_run_on)}</span>
      ${settings
        ? `<button type="button" class="btn small" data-rerun="${t.id}">שבץ מחדש</button>`
        : '<span></span>'}
    </div>`;
  }).join('');

  return `<section class="recur">
    <div class="recurhead">
      <h2>קמפיינים מחזוריים</h2>
      ${list.length && settings ? `<p class="sub">כל שיבוץ יוצר קמפיין חדש עם אותו תוכן ומצבים
        בתאריכים חדשים.${drag ? ' אפשר גם לגרור שורה אל הציר.' : ''}</p>` : ''}
    </div>
    ${list.length ? `<div class="panel recurlist">
      <div class="rrow rhead" aria-hidden="true">
        <span>קמפיין</span><span>נקודת קצה</span><span>תקופה</span><span>תוכן</span>
        <span>הרצה אחרונה</span><span></span>
      </div>
      ${rows}
    </div>` : `<p class="recurempty">${settings
      ? `אין עדיין קמפיינים מחזוריים. מסמנים קמפיין כמחזורי מתפריט ⋮ שלו, בטאב
        "קמפיינים ותוכן" — ומכאן משבצים אותו מחדש כשצריך.`
      : 'אין עדיין קמפיינים מחזוריים.'}</p>`}
  </section>`;
}

/**
 * "שבץ מחדש": תאריך יעד, תקופה (מוצעת מהתבנית) ושם. השרת מעתיק את כל
 * השאר מהתבנית (POST /campaigns/:id/replace).
 */
function openRerun(t, start = suggestedStart(t)) {
  const rp = rerunPeriod(t, start);
  // תבנית בלי תאריך סיום: אין אורך להעתיק — מוצע חודש, ובוחרים
  const period = rp?.period ?? '1m';
  const customDays = rp?.period === 'custom' ? spanDays(start, rp.ends_on) : null;
  const unit = t.structure === 'general' ? 'פוסטים' : 'זוויות';
  let nameTouched = false;

  openGeneric({
    title: `שבץ מחדש: ${t.name}`,
    saveLabel: 'שבץ',
    fields: [
      { name: 'starts_on', label: 'תאריך יעד לפוסט הראשון', type: 'date', value: start },
      { name: 'period', label: 'תקופת הקמפיין', type: 'period', start: 'starts_on',
        value: period, ends_on: rp?.ends_on },
      { name: 'name', label: 'שם הקמפיין החדש', type: 'text', value: runName(t.name, start) },
      { name: 'info', type: 'html', html: `<p class="fhint">
        ${t.content_count} ${unit} מועתקים עם המצבים שלהם (מוכן נשאר מוכן), הקבצים והקישורים,
        ואותן מדיות והגדרות. ${t.content_complete_at
          ? 'התבנית מסומנת "מוכן", ולכן גם הקמפיין החדש: אותו תוכן נפרס על התקופה החדשה. ' : ''}
        התבנית וההרצות הקודמות לא משתנות.</p>` },
    ],
    onOpen: () => {
      const startEl = $('#gen_starts_on');
      $('#gen_name').addEventListener('input', () => { nameTouched = true; });
      startEl.addEventListener('input', () => {
        if (!startEl.value) return;
        if (!nameTouched) $('#gen_name').value = runName(t.name, startEl.value);
        // סיום ידני של התבנית: אותו מספר ימים זז עם תאריך היעד
        if (customDays && $('#gen_period').value === 'custom') {
          const end = $('#gen_period_end');
          end.value = addDaysP(startEl.value, customDays - 1);
          end.dispatchEvent(new Event('input'));
        }
      });
    },
    onSave: async (v) => {
      if (!v.starts_on) throw new Error('צריך תאריך יעד לפוסט הראשון');
      if (v.period !== 'custom') delete v.ends_on;
      v.week = v.starts_on;
      const res = await api(`/campaigns/${t.id}/replace`, { method: 'POST', body: v });
      const n = res.copied?.items ?? 0;
      engineToast(res, `נוצר "${res.campaign.name}" (${dateLabel(res.campaign.starts_on)}–` +
        `${dateLabel(res.campaign.ends_on)}) עם ${n} ${unit}.`);
      await Promise.all([renderStrategy(), refreshBoard()]);
      return false;
    },
  });
}

function wireRecurring(list) {
  const byId = (id) => list.find((t) => t.id === Number(id));

  $$('#strategy [data-open-tpl]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      state.planCampaign = Number(b.dataset.openTpl);
      state.planBackground = false;
      await goToTab('plan');
    })));

  if (!can('settings')) return;
  $$('#strategy [data-rerun]').forEach((b) =>
    b.addEventListener('click', () => openRerun(byId(b.dataset.rerun))));

  // גרירת שורה אל הציר: תאריך היעד = תחילת חצי החודש שהיא נחתה עליו
  $$('#strategy [data-tpl-drag]').forEach((row) =>
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-template', row.dataset.tplDrag);
      e.dataTransfer.effectAllowed = 'copy';
    }));
  const gantt = $('#strategy .gantt2');
  if (!gantt) return;
  gantt.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-template')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    gantt.classList.add('dropping');
  });
  gantt.addEventListener('dragleave', (e) => {
    if (!gantt.contains(e.relatedTarget)) gantt.classList.remove('dropping');
  });
  gantt.addEventListener('drop', (e) => {
    gantt.classList.remove('dropping');
    const t = byId(e.dataTransfer.getData('text/x-template'));
    const track = $('#strategy .gtrack');
    if (!t || !track) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const rtl = getComputedStyle(track).direction === 'rtl';
    const offset = rtl ? rect.right - e.clientX : e.clientX - rect.left;
    const half = Math.min(HALVES - 1, Math.max(0, Math.floor(offset / (rect.width / HALVES))));
    // נחיתה על עמודת השמות, על הכותרת או על חצי חודש שעבר — לא לפני היום
    // (השרת דוחה הרצה שמתחילה בעבר)
    const today = ymd(new Date());
    const date = offset < 0 ? today : halfToDate(half, ganttBase());
    openRerun(t, date < today ? today : date);
  });
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
        engineToast(res, (steps === 1 ? 'הקמפיין הוזז בחצי חודש.'
                                      : `הקמפיין הוזז ב-${steps} חצאי חודש.`) + moved);
        await Promise.all([renderStrategy(), refreshBoard()]);
      });

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });

    // לחיצה בלי גרירה פותחת את הקמפיין
    el.addEventListener('click', run(async () => {
      if (el.dataset.preview && Number(el.dataset.preview) !== 0) return;
      state.planCampaign = Number(el.dataset.campaign);
      state.planBackground = false;
      await goToTab('plan');
    }));
  });
}
