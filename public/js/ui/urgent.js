import { $, $$, esc, fillSelect, run, toast } from '../core/dom.js';
import { can, state } from '../core/state.js';
import { numOrNull, ymd } from '../core/format.js';
import { api } from '../core/api.js';
import { refreshAfterPostChange } from '../ui/refresh.js';
import { channelHour, defaultUrgentTime } from '../core/postActions.js';
import { multiSelectHtml, wireMultiSelects } from './multiSelect.js';
import { activeEndpoints } from './addPost.js';

/* ========================= מבצע דחוף ========================= */

// מבצע דחוף לא נושא תוכן מלא (רק כותרת) — אין לו לחצן "אשר" בלי אישור
// מודע לכך, ולכן צריך גם את תוצאת הבדיקה האחרונה וגם את מצב התיבה
let urgentPlanOk = false;

export function wireUrgentDialog() {
  $('#uCancel').addEventListener('click', () => $('#urgentDlg').close());
  $('#uCheck').addEventListener('click', run(previewUrgent));
  $('#uAck').addEventListener('change', () => {
    $('#uOk').disabled = !(urgentPlanOk && $('#uAck').checked);
  });
  $('#uOk').addEventListener('click', run(commitUrgent));
  // שינוי בפרטים אחרי "בדוק" — התוצאה כבר לא נכונה: מאפסים ו"אשר" נכבה
  for (const id of ['#uTitle', '#uEndpoint', '#uUntil', '#uTime', '#uChannels']) {
    $(id).addEventListener('input', resetPlan);
    $(id).addEventListener('change', resetPlan);
  }
  // השעה עוקבת אחרי הערוצים שנבחרו עד שמישהו משנה אותה ביד (סעיף 12)
  $('#uTime').addEventListener('input', () => { timeTouched = true; });
  $('#uChannels').addEventListener('change', syncUrgentTime);
}

let timeTouched = false;

/**
 * השעה בחלון לפי שעת הפרסום הרגילה של הערוצים שנבחרו: כולם באותה שעה —
 * היא (או השעה העגולה הבאה כשכבר מאוחר היום); שעות שונות — ריק, והשרת
 * משבץ כל ערוץ בשעה שלו.
 */
function syncUrgentTime() {
  if (timeTouched) return;
  const ids = new Set($$('#uChannels input:checked').map((i) => Number(i.value)));
  const hours = new Set(state.channels.filter((c) => ids.has(c.id)).map(channelHour));
  $('#uTime').value = hours.size > 1 ? '' : defaultUrgentTime(new Date(), [...hours][0] ?? 10);
}

let planReq = 0; // תשובת "בדוק" ישנה לא נכנסת אחרי שהפרטים השתנו

function resetPlan() {
  planReq++;
  if (!['checked', 'checking'].includes($('#uWhatIf').dataset.state)) return;
  urgentPlanOk = false;
  $('#uOk').disabled = true;
  $('#uWhatIf').dataset.state = '';
  $('#uWhatIf').innerHTML = '<b>מה יקרה:</b> הפרטים השתנו — לוחצים שוב "בדוק".';
}

export function openUrgent() {
  if (!can('content')) return toast('אין לך הרשאה לשבץ תוכן', true);

  // אין פוסט בלי נקודת קצה (החלטת המשתמש 8.10.26)
  const endpoints = activeEndpoints();
  if (!endpoints.length) return toast('אין נקודת קצה פעילה — מוסיפים אחת בניהול, ואז משבצים', true);
  fillSelect($('#uEndpoint'), endpoints, 'name');
  if (endpoints.some((e) => e.id === state.planEndpoint)) $('#uEndpoint').value = state.planEndpoint;
  $('#uChannels').innerHTML = multiSelectHtml({
    options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
    placeholder: 'בחירת ערוצים…',
  });
  wireMultiSelects($('#uChannels'));

  const inTwoDays = new Date(Date.now() + 2 * 86400000);
  $('#uUntil').value = ymd(inTwoDays);
  $('#uTitle').value = '';
  timeTouched = false;
  $('#uTime').value = defaultUrgentTime();
  $('#uWhatIf').dataset.state = '';
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
  time: $('#uTime').value || null,
  channel_ids: $$('#uChannels input:checked').map((i) => Number(i.value)),
});

async function previewUrgent() {
  const req = ++planReq;
  $('#uWhatIf').dataset.state = 'checking';
  const plan = await api('/urgent/preview', { method: 'POST', body: urgentBody() });
  if (req !== planReq) return; // הפרטים השתנו בזמן הבדיקה
  $('#uWhatIf').dataset.state = 'checked';

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
  // הלוח, תגית המשימות והפעמון — מבצע שממתין לאישור יוצר משימה והתראה
  await refreshAfterPostChange();
}
