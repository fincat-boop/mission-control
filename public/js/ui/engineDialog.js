import { $, $$, esc, run, toast, toastAction } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { refreshAfterPostChange } from '../ui/refresh.js';
import { KIND_HE } from '../core/format.js';

/* ========================= מילוי אוטומטי: הודעה + ביטול ========================= */

/**
 * "בטל" על מילוי של המנוע: מוחק את הפוסטים שנוצרו ומחזיר שיוכים לפוסט
 * חסר תוכן. השרת מתעלם ממה שכבר השתנה (פורסם, אושר, עבר חצי שעה).
 */
const undoFill = run(async (fill) => {
  const r = await api('/engine/undo', {
    method: 'POST',
    body: { created: fill.created_items ?? [], attached: fill.attached_items ?? [] },
  });
  toast(r.removed || r.detached
    ? `המילוי בוטל — הלוח חזר למה שהיה, והמנוע לא יחזיר את התוכן הזה ${
      fill.weeks > 1 ? 'לשבועות האלה' : 'לשבוע הזה'}.`
    : 'אין מה לבטל — הפוסטים כבר השתנו או יצאו לאוויר.');
  await refreshAfterPostChange();
});

/**
 * מה המנוע עשה, במשפט אחד: כמה, ושתי דוגמאות עם ערוץ ויום. weeks — מילוי
 * של כל תקופת קמפיין (autoFillCampaign): בכמה שבועות נכתב משהו.
 */
function fillSummary(fill) {
  const parts = [];
  const across = fill.weeks > 1 ? ` ב-${fill.weeks} שבועות` : '';
  if (fill.placed) parts.push(`שיבץ ${fill.placed} פוסטים${across}`);
  if (fill.attached) parts.push(`מילא ${fill.attached} פוסטים חסרי תוכן`);
  if (fill.holes) parts.push(`הוסיף ${fill.holes} פוסטים חסרי תוכן עם משימת "לכתוב"`);
  const items = (fill.summary ?? []).slice(0, 2)
    .map((x) => `"${x.title}" (${x.channel_name}, ${x.day_label})`);
  const more = (fill.summary?.length ?? 0) > 2 ? ` ועוד ${fill.summary.length - 2}` : '';
  return `המנוע ${parts.join(', ')}${items.length ? `: ${items.join(', ')}${more}` : ''}.`;
}

/**
 * ההודעה האחידה אחרי כל שינוי שמפעיל מילוי אוטומטי. base — מה שהמשתמש
 * עשה ("נשמר."). אם המנוע שיבץ משהו — אומרים מה, ומציעים "בטל".
 * @param {{engine?:object}} res תשובת השרת לשינוי
 */
export function engineToast(res, base = '') {
  const fill = res?.engine;
  // מכירתיים שלא נכנסו — נאמר גם כשלא שובץ כלום, כדי שזה לא יקרה בשקט
  const blocked = fill?.promo_blocked > 0
    ? ` ${fill.promo_blocked} פוסטים מכירתיים לא שובצו — חסר תוכן ערך באותם שבועות.` : '';
  if (!fill || !(fill.placed || fill.attached)) return toast((base || 'נשמר.') + blocked);
  toastAction(`${base} ${fillSummary(fill)}${blocked}`.trim(), 'בטל', () => undoFill(fill));
}

/* ========================= חלון "מלא את השבוע" ========================= */

const checked = () => $$('#enginePlan [data-key]:checked').map((i) => i.dataset.key);

/** הכפתור אומר כמה ייכתבו בפועל, ונכבה כשאין מסומן אף פריט */
function syncApplyButton() {
  const n = checked().length;
  const btn = $('#eApply');
  btn.textContent = `שבץ את המסומנים (${n})`;
  btn.disabled = n === 0;
}

export function wireEngineDialog() {
  $('#eCancel').addEventListener('click', () => $('#engineDlg').close());
  $('#enginePlan').addEventListener('change', (e) => {
    if (e.target.matches('[data-key]')) syncApplyButton();
  });
  $('#eApply').addEventListener('click', run(async () => {
    const res = await api('/engine/apply', {
      method: 'POST', body: { week: state.week, selected: checked() },
    });
    $('#engineDlg').close();
    const dropped = res.dropped ?? [];
    const staleN = res.skipped - dropped.length;
    const stale = staleN > 0
      ? ` ${staleN} פריטים לא שובצו כי הלוח השתנה מאז שההצעה הוצגה.` : '';
    const ratio = dropped.length
      ? ` ${dropped.length} מכירתיים לא שובצו: ${dropped[0].reason}.` : '';
    toastAction(fillSummary(res) + stale + ratio, 'בטל', () => undoFill(res));
    await refreshAfterPostChange();
  }));
}

/** שורה בהצעה: תיבת סימון (מסומנת כברירת מחדל) + מה, איפה, ולמה */
function planRow(x, { title, where, reason, tone = '' }) {
  return `
    <label class="camp eng-item${tone ? ` ${tone}` : ''}">
      <input type="checkbox" data-key="${esc(x.key)}" checked>
      <span class="eng-body">
        <span class="crow">${title}<span class="d">${where}</span></span>
        <span class="d eng-reason">${reason}</span>
      </span>
    </label>`;
}

let planReq = 0; // רק התשובה לפתיחה האחרונה מצוירת — תשובה ישנה לא דורסת חדשה

export async function openEngine() {
  $('#enginePlan').innerHTML = '<div class="empty">מחשב…</div>';
  $('#eApply').disabled = true;
  $('#eApply').textContent = 'שבץ את המסומנים';
  $('#engineDlg').showModal();

  const req = ++planReq;
  const plan = await api('/engine/plan', { method: 'POST', body: { week: state.week } });
  if (req !== planReq || !$('#engineDlg').open) return;
  const attachments = plan.attachments ?? [];

  const placed = plan.placements.map((p) => planRow(p, {
    title: `<span class="eng-kind ${esc(p.kind)}"></span><b>${esc(p.title)}</b>`,
    where: `${esc(p.channel_name)} · ${esc(p.day_label)} ${esc(p.time)}`,
    reason: esc(p.reason),
  })).join('');

  const filled = attachments.map((a) => planRow(a, {
    title: `<span class="eng-kind ${esc(a.kind)}"></span><b>${esc(a.title)}</b>`,
    where: `${esc(a.channel_name)} · ${esc(a.day_label)} ${esc(a.time)}`,
    reason: `${esc(a.reason)} · ${esc(a.endpoint_name)}`,
  })).join('');

  const holes = plan.holes.map((h) => planRow(h, {
    title: `<b class="eng-missing">חסר תוכן — ${esc(h.endpoint_name)}</b>`,
    where: `${esc(h.channel_name)} · ${esc(h.day_label)} · ${esc(KIND_HE[h.kind] ?? '')}`,
    reason: `${esc(h.reason)}${h.days_since === null ? '' : ` · ${h.days_since} ימים בלי פרסום`}` +
            ' · תיווצר משימת "לכתוב"',
    tone: 'missing',
  })).join('');

  const notes = (plan.notes ?? []).map((n) => `<div class="d">${esc(n)}</div>`).join('');
  const r = plan.ratio;
  const ratioLine = r
    ? `<div class="sumline eng-ratio">אחרי השיבוץ: <b>${r.counts.promo} מכירתיים</b> ·
       <b>${r.counts.value} ערך</b> · <b>${r.counts.hybrid} משולב</b>${
         r.value_per_promo === null ? ''
           : ` — יחס ${r.value_per_promo} ערך למכירתי (מינימום ${r.minRatio})`}</div>`
    : '';
  const total = plan.placements.length + attachments.length + plan.holes.length;

  $('#enginePlan').innerHTML = `
    <p class="sub eng-intro">
      ${esc(plan.week.label)} — המנוע ממלא רק שטח פנוי. שום דבר שכבר על הלוח לא יזוז.
      ${total ? 'מורידים סימון ממה שלא רוצים.' : ''}</p>

    ${plan.placements.length ? `<div class="subsec"><h4>ישובצו (${plan.placements.length})</h4>${placed}</div>` : ''}
    ${attachments.length ? `<div class="subsec"><h4>ימולאו פוסטים חסרי תוכן (${attachments.length})</h4>${filled}</div>` : ''}
    ${plan.holes.length ? `<div class="subsec"><h4>ייווספו פוסטים חסרי תוכן (${plan.holes.length})</h4>${holes}</div>` : ''}
    ${ratioLine}
    ${notes ? `<div class="whatif">${notes}</div>` : ''}
    ${!total
      ? '<div class="empty">אין מה לשבץ — הלוח מלא, או שאין תוכן מוכן שמתאים לשטח שנשאר.</div>' : ''}`;

  syncApplyButton();
}
