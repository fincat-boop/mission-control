import { $, fillSelect, run, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { fmtDate, numOrNull } from '../core/format.js';
import { postWithGapCheck } from '../core/api.js';
import { refreshAfterPostChange } from '../ui/refresh.js';
import { openEngine } from '../ui/engineDialog.js';

/* ========================= הוספת פוסט ידנית ========================= */

let addSlotCtx = null;

export function wireAddPostDialog() {
  $('#apCancel').addEventListener('click', () => $('#addPostDlg').close());
  $('#apAddOnly').addEventListener('click', run(() => submitManualPost(false)));
  $('#apAddAndCheck').addEventListener('click', run(() => submitManualPost(true)));
}

export function openAddPost(channelId, date, channelName) {
  addSlotCtx = { channelId, date };
  fillSelect($('#apEndpoint'), state.endpoints, 'name', 'ללא נקודת קצה');
  $('#apContext').textContent = `${channelName} · ${fmtDate(date)}`;
  $('#apTitle').value = '';
  $('#apKind').value = 'value';
  $('#apTime').value = '10:00';
  $('#addPostDlg').showModal();
  $('#apTitle').focus();
}

/**
 * "הוסף פוסט" לא נוגע בשום דבר אחר בלוח — בדיוק כמו גרירה ידנית של
 * כרטיס קיים. "הוסף ובדוק שיבוץ מחדש" מוסיף ואז פותח את אותה תצוגת
 * מנוע שמשמשת את "מלא את השבוע": מציגה מה ישתבץ בפועל, ולא נוגעת
 * בלוח עד שלוחצים "שבץ הכול" שם.
 */
async function submitManualPost(reorganizeAfter) {
  const title = $('#apTitle').value.trim();
  if (!title) return toast('צריך כותרת לפוסט', true);

  const [h, m] = $('#apTime').value.split(':').map(Number);
  const at = new Date(`${addSlotCtx.date}T00:00:00`);
  at.setHours(Number.isNaN(h) ? 10 : h, Number.isNaN(m) ? 0 : m, 0, 0);

  const created = await postWithGapCheck('/posts', {
    channel_id: addSlotCtx.channelId,
    endpoint_id: numOrNull($('#apEndpoint').value),
    title,
    kind: $('#apKind').value,
    scheduled_at: at.toISOString(),
  }, 'POST');
  if (!created) return; // המשתמש ביטל אחרי אזהרת המרווח

  $('#addPostDlg').close();
  toast('הפוסט נוסף ללוח.');
  await refreshAfterPostChange();

  if (reorganizeAfter) await openEngine();
}
