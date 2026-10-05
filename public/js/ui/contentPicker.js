import { esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { KIND_HE } from '../core/format.js';

/* ========================= בחירת תוכן לפוסט ========================= */

/**
 * תוכן שאפשר לשייך לפוסט בערוץ הזה (GET /posts/candidates): ניסוח לערוץ,
 * קמפיין לא מושהה ותאריך בתוך החלון שלו. מוכן קודם, אחר כך טיוטות.
 * endpointId ריק = מכל הנקודות (פוסט שעוד אין לו נקודת קצה).
 */
export async function loadCandidates({ endpointId, channelId, date }) {
  const q = new URLSearchParams({ channel_id: String(channelId) });
  if (endpointId) q.set('endpoint_id', String(endpointId));
  if (date) q.set('date', date);
  const { candidates } = await api(`/posts/candidates?${q}`);
  return candidates;
}

/** "מוכן" / "טיוטה" — מצב הניסוח לערוץ הזה */
export const variantLabel = (c) => (c.variant_status === 'ready' ? 'מוכן' : 'טיוטה');

/** פרטי המשנה של מועמד: קמפיין או תוכן שוטף, סוג, נקודה (כשמציגים מכמה נקודות) */
export function candidateMeta(c, withEndpoint = false) {
  return [
    withEndpoint ? c.endpoint_name : null,
    c.campaign_name ?? 'תוכן שוטף',
    KIND_HE[c.kind],
    c.used_on_channel ? 'כבר שובץ בערוץ הזה' : null,
  ].filter(Boolean).join(' · ');
}

/** רשימת כפתורים — אחד לכל מועמד, data-content-id על כל אחד */
export function candidateButtons(list, withEndpoint = false) {
  return `<div class="pick-list">${list.map((c) => `
    <button type="button" class="pick-item" data-content-id="${c.id}">
      <span class="pick-title">${esc(c.title)}
        <span class="pick-meta">${esc(candidateMeta(c, withEndpoint))}</span></span>
      <span class="pick-st ${c.variant_status === 'ready' ? 'ready' : 'draft'}">${variantLabel(c)}</span>
    </button>`).join('')}</div>`;
}
