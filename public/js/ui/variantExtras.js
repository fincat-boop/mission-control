import { $$, esc } from '../core/dom.js';
import { isImage, isVideo } from '../core/format.js';
import {
  IG_LIMITS, badFeedRatio, captionCounts, extraSummary, extrasFor,
} from '../core/socialRules.js';

/**
 * האזורים המקופלים בעורך הגרסאות — מה שאפשר להוסיף לפוסט מעבר לטקסט
 * ולקבצים, לפי הפלטפורמה של הערוץ (core/socialRules.js). כל אזור סגור,
 * ובשורה שלו סיכום של מה שהוגדר; ערוץ בלי פלטפורמה — אין אזורים.
 *
 * שכבה 2: תלוי רק ב-core. העורך (features/plan.js) מחזיק את המצב ושומר.
 */

const LABELS = {
  format: 'סוג פרסום', cover: 'שער לריל', first_comment: 'תגובה ראשונה',
  alt_text: 'תיאור תמונה', link: 'קישור',
};

const COMMENT_HINT = {
  instagram: 'נכתבת מיד אחרי הפרסום. מתאים להאשטגים, כדי שהכיתוב יישאר נקי.',
  facebook: 'נכתבת בשם העמוד מיד אחרי הפרסום. מתאים לקישור — פוסט שהקישור בגוף שלו מקבל פחות חשיפה.',
};

function sectionBody(key, platform, meta, files) {
  if (key === 'format') {
    const story = meta.format === 'story';
    return `<div class="checks vx-radios" role="radiogroup" aria-label="סוג פרסום">
        <label><input type="radio" name="vx_format" value="" ${story ? '' : 'checked'}>
          <span>פוסט רגיל<span class="d">תמונה — פוסט · סרטון — ריל · כמה קבצים — קרוסלה</span></span></label>
        <label><input type="radio" name="vx_format" value="story" ${story ? 'checked' : ''}>
          <span>סטורי<span class="d">קובץ אחד, בלי כיתוב, נעלם אחרי 24 שעות</span></span></label>
      </div>`;
  }
  if (key === 'cover') {
    if (!files.some((a) => isVideo(a.mime))) {
      return '<div class="fhint">מוסיפים סרטון כדי לבחור לו שער.</div>';
    }
    const images = files.filter((a) => isImage(a.mime));
    const cur = String(meta.cover_asset_id ?? '');
    return `<select id="vx_cover" aria-label="שער לריל">
        <option value="">פריים מתוך הסרטון</option>
        ${images.map((a) => `<option value="${a.id}"${String(a.id) === cur ? ' selected' : ''}>
          תמונה: ${esc(a.filename)}</option>`).join('')}
      </select>
      <div class="subfield" id="vx_offset_row"${cur ? ' hidden' : ''}>
        <label for="vx_offset">משנייה</label>
        <input id="vx_offset" type="number" min="0" step="0.5" value="${esc(meta.cover_offset_sec ?? '')}"
               placeholder="0">
      </div>
      <div class="fhint">תמונה שנבחרה כשער לא יוצאת כחלק מהפוסט.${images.length ? ''
        : ' כדי לבחור תמונה — מוסיפים אותה לקבצים ושומרים.'}</div>`;
  }
  if (key === 'first_comment') {
    return `<textarea id="vx_comment" aria-label="תגובה ראשונה">${esc(meta.first_comment ?? '')}</textarea>
      <div class="fhint">${COMMENT_HINT[platform] ?? ''} אם החיבור בלי הרשאה לתגובות — הפוסט
        יוצא בכל זאת, ונפתחת משימה להוסיף את התגובה ידנית.</div>`;
  }
  if (key === 'alt_text') {
    return `<textarea id="vx_alt" maxlength="${IG_LIMITS.alt}" aria-label="תיאור תמונה"
        placeholder="למשל: אישה מחייכת מול מחשב נייד, על השולחן כוס קפה">${esc(meta.alt_text ?? '')}</textarea>
      <div class="fhint">מה רואים בתמונה, למי שמשתמש בקורא מסך. נשלח רק בפוסט עם תמונה אחת.</div>`;
  }
  if (key === 'link') {
    return `<input id="vx_link" type="url" dir="ltr" value="${esc(meta.link ?? '')}"
        placeholder="https://" aria-label="קישור">
      <div class="fhint">בפוסט בלי תמונה — פייסבוק מציג כרטיס עם תצוגה מקדימה של הקישור.
        עם תמונה או סרטון — הקישור נוסף לסוף הטקסט.</div>`;
  }
  return '';
}

/** ה-HTML של כל האזורים לערוץ. files — הקבצים של הגרסה ({id, filename, mime}) */
export function extrasHtml({ platform, meta = {}, files = [] }) {
  return extrasFor(platform).map((key) => {
    const s = extraSummary(key, meta, files);
    return `<details class="vx" data-vx="${key}"${hiddenFor(key, meta) ? ' hidden' : ''}>
      <summary><span class="vx-l">${LABELS[key]}</span>
        <span class="vx-sum${s.set ? ' set' : ''}">${esc(s.text)}</span></summary>
      <div class="vx-b">${sectionBody(key, platform, meta, files)}</div>
    </details>`;
  }).join('');
}

/** בסטורי אין שער, אין תיאור תמונה ואין תגובות — האזורים יורדים */
const hiddenFor = (key, meta) => meta.format === 'story' && key !== 'format';

/** הערכים מהאזורים (רק מה שמוצג בערוץ הזה) */
export function readExtras(root) {
  const out = {};
  const val = (sel) => root.querySelector(sel)?.value?.trim() ?? '';
  const fmt = root.querySelector('[name="vx_format"]:checked');
  if (fmt) out.format = fmt.value || null;
  if (root.querySelector('#vx_cover')) {
    const cover = val('#vx_cover');
    out.cover_asset_id = cover ? Number(cover) : null;
    const sec = val('#vx_offset');
    out.cover_offset_sec = !cover && sec !== '' && Number(sec) > 0 ? Number(sec) : null;
  }
  if (root.querySelector('#vx_comment')) out.first_comment = val('#vx_comment') || null;
  if (root.querySelector('#vx_alt')) out.alt_text = val('#vx_alt') || null;
  if (root.querySelector('#vx_link')) out.link = val('#vx_link') || null;
  return out;
}

/**
 * חיווט — פעם אחת על המעטפת, גם כשהאזורים מצוירים מחדש בכל מעבר ערוץ:
 * כל שינוי מעדכן את שורות הסיכום ואת מה שמוצג (סטורי מוריד שער ותיאור),
 * ואז onChange. files/keep — פונקציות, כי הערוץ שבעריכה מתחלף. keep — מה
 * שנשמר ואין לו שדה כרגע (שער שנבחר כשאין סרטון), לשורת הסיכום.
 */
export function wireExtras(root, { files = () => [], keep = () => ({}), onChange }) {
  const paint = () => {
    const meta = { ...keep(), ...readExtras(root) };
    for (const d of $$('details.vx', root)) {
      const key = d.dataset.vx;
      d.hidden = hiddenFor(key, meta);
      const s = extraSummary(key, meta, files());
      const sum = d.querySelector('.vx-sum');
      sum.textContent = s.text;
      sum.classList.toggle('set', s.set);
    }
    const row = root.querySelector('#vx_offset_row');
    if (row) row.hidden = !!root.querySelector('#vx_cover')?.value;
    onChange?.();
  };
  root.addEventListener('input', paint);
  root.addEventListener('change', paint);
}

/* ---------- מונה הכיתוב ואזהרות יחס תמונה (אינסטגרם) ---------- */

const dims = new Map(); // url → {w, h} | null — נטען פעם אחת לכל קובץ

function imageDims(url, onLoad) {
  if (dims.has(url)) return dims.get(url);
  dims.set(url, undefined);
  const img = new Image();
  img.onload = () => { dims.set(url, { w: img.naturalWidth, h: img.naturalHeight }); onLoad(); };
  img.onerror = () => dims.set(url, null);
  img.src = url;
  return undefined;
}

/**
 * השורה מתחת לטקסט: באינסטגרם — מונה תווים/האשטגים/תיוגים, בסטורי — שהטקסט
 * לא יוצא, ואזהרה על תמונה ביחס שהפיד דוחה. בערוץ אחר — ריקה.
 */
export function paintCaptionNote(el, { platform, text, meta = {}, files = [] }) {
  if (!el) return;
  if (platform !== 'instagram') {
    el.innerHTML = '';
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (meta.format === 'story') {
    el.innerHTML = '<span>בסטורי אין כיתוב — הטקסט לא יוצא לאינסטגרם.</span>';
    return;
  }
  const parts = captionCounts(text).map((c) =>
    `<span class="${c.over ? 'over' : ''}">${esc(c.text)}</span>`);
  const repaint = () => paintCaptionNote(el, { platform, text, meta, files });
  const coverId = Number(meta.cover_asset_id) || null;
  const bad = files
    .filter((a) => isImage(a.mime) && a.id !== coverId)
    .filter((a) => {
      const d = imageDims(a.url ?? `/api/assets/${a.id}`, repaint);
      return d && badFeedRatio(d.w, d.h);
    });
  el.innerHTML = parts.join('<span class="vsep">·</span>') + bad.map((a) =>
    `<div class="over">"${esc(a.filename)}" גבוהה או רחבה מדי לפיד של אינסטגרם — הפרסום יידחה.
      חותכים ליחס שבין <bdi dir="ltr">4:5</bdi> (לאורך) ל־<bdi dir="ltr">1.91:1</bdi> (לרוחב), או מפרסמים כסטורי.</div>`).join('');
}
