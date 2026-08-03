import { $, $$, esc, run, toast } from '../core/dom.js';
import { fmtDate, ymd } from '../core/format.js';
import { api } from '../core/api.js';
import { can, epColor, rebuildEpColors, state } from '../core/state.js';
import { goToTab, refreshBoard } from '../ui/refresh.js';

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
