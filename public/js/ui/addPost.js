import { $, esc, fillSelect, run, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { fmtDate, numOrNull } from '../core/format.js';
import { api, postWithGapCheck } from '../core/api.js';
import { refreshAfterPostChange } from '../ui/refresh.js';
import { openEngine } from '../ui/engineDialog.js';
import { candidateMeta, loadCandidates, variantLabel } from '../ui/contentPicker.js';

/* ========================= הוספת פוסט ידנית ========================= */

let addSlotCtx = null;
let candidates = []; // התוכן שאפשר לשייך במשבצת הזו, לפי הנקודה שנבחרה

export function wireAddPostDialog() {
  $('#apCancel').addEventListener('click', () => $('#addPostDlg').close());
  $('#apAddOnly').addEventListener('click', run(() => submitManualPost(false)));
  $('#apAddAndCheck').addEventListener('click', run(() => submitManualPost(true)));
  $('#apEndpoint').addEventListener('change', run(refreshContentOptions));
  $('#apContent').addEventListener('change', syncContentHint);
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
  run(refreshContentOptions)();
}

/**
 * בחירת תוכן לפוסט — כדי שפוסט ידני לא ייוולד "חסר תוכן" כשכבר יש מה לשים
 * בו. אותה רשימה כמו "שייך תוכן" בחלון הפוסט: ניסוח לערוץ הזה, מוכן קודם.
 */
async function refreshContentOptions() {
  const sel = $('#apContent');
  sel.innerHTML = '<option value="">טוען…</option>';
  const endpointId = numOrNull($('#apEndpoint').value);
  candidates = await loadCandidates({
    endpointId, channelId: addSlotCtx.channelId, date: addSlotCtx.date,
  });
  const group = (label, list) => list.length
    ? `<optgroup label="${label}">${list.map((c) =>
        `<option value="${c.id}">${esc(c.title)} — ${esc(candidateMeta(c, !endpointId))}</option>`).join('')}</optgroup>`
    : '';
  sel.innerHTML = `<option value="">בלי תוכן — הפוסט יסומן "חסר תוכן"</option>` +
    group('מוכן', candidates.filter((c) => c.variant_status === 'ready')) +
    group('טיוטה', candidates.filter((c) => c.variant_status !== 'ready'));
  syncContentHint();
}

/** כשנבחר תוכן — הכותרת והסוג נלקחים ממנו; אומרים את זה במקום לנחש בשקט */
function syncContentHint() {
  const c = candidates.find((x) => x.id === Number($('#apContent').value));
  $('#apKind').disabled = !!c;
  $('#apContentHint').textContent = c
    ? `הכותרת והסוג נלקחים מהתוכן. הניסוח לערוץ הזה: ${variantLabel(c)}.`
    : candidates.length ? '' : 'אין עדיין תוכן עם ניסוח לערוץ הזה.';
}

/**
 * "הוסף פוסט" לא נוגע בשום דבר אחר בלוח — בדיוק כמו גרירה ידנית של
 * כרטיס קיים. "הוסף ופתח את מילוי השבוע" מוסיף ואז פותח את חלון המנוע:
 * מציג מה ישתבץ בשאר המקום הפנוי, ולא נוגע בלוח עד שלוחצים "שבץ" שם.
 *
 * תוכן שנבחר משויך בבקשה נפרדת (attach-content), כדי שיעבור את אותם
 * כללים כמו כל שיוך: ניסוח לערוץ, אותה נקודה, חלון הקמפיין.
 */
async function submitManualPost(reorganizeAfter) {
  const content = candidates.find((x) => x.id === Number($('#apContent').value)) ?? null;
  const title = $('#apTitle').value.trim() || content?.title || '';
  if (!title) return toast('צריך כותרת לפוסט, או לבחור תוכן', true);

  const [h, m] = $('#apTime').value.split(':').map(Number);
  const at = new Date(`${addSlotCtx.date}T00:00:00`);
  at.setHours(Number.isNaN(h) ? 10 : h, Number.isNaN(m) ? 0 : m, 0, 0);

  const created = await postWithGapCheck('/posts', {
    channel_id: addSlotCtx.channelId,
    endpoint_id: numOrNull($('#apEndpoint').value),
    title,
    kind: content?.kind ?? $('#apKind').value,
    scheduled_at: at.toISOString(),
  }, 'POST');
  if (!created) return; // המשתמש ביטל אחרי אזהרת המרווח

  $('#addPostDlg').close();
  if (content) {
    try {
      await api(`/posts/${created.post.id}/attach-content`, {
        method: 'POST', body: { content_id: content.id },
      });
      toast('הפוסט נוסף ללוח עם התוכן.');
    } catch (e) {
      toast(`הפוסט נוסף, אבל התוכן לא שויך: ${e.message}`, true);
    }
  } else {
    toast('הפוסט נוסף ללוח — מסומן "חסר תוכן" עד שישויך לו תוכן.');
  }
  await refreshAfterPostChange();

  if (reorganizeAfter) await openEngine();
}
