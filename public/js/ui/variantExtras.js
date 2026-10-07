import { $$, esc } from '../core/dom.js';
import { isImage, isVideo } from '../core/format.js';
import {
  IG_LIMITS, badFeedRatio, captionCounts, extraSummary, extrasFor,
} from '../core/socialRules.js';

/**
 * האזורים המקופלים בעורך הגרסאות — מה שאפשר להוסיף לפוסט מעבר לטקסט
 * ולקבצים (core/socialRules.js) — כולם בכל ערוץ. כל אזור סגור, ובשורה שלו
 * סיכום של מה שהוגדר ("לא בשימוש" = לא מולא). ההסברים לפי הפלטפורמה.
 *
 * שכבה 2: תלוי רק ב-core. העורך (features/plan.js) מחזיק את המצב ושומר.
 */

const LABELS = {
  format: 'סוג פרסום', cover: 'שער לסרטון', first_comment: 'תגובה ראשונה',
  alt_text: 'תיאור תמונה', link: 'קישור',
};

// מה קורה עם כל שדה בפרסום — לפי הפלטפורמה; ערוץ ידני: מוצג למי שמפרסם
const MANUAL_HINT = 'בערוץ הזה מפרסמים ידנית — מופיע בתצוגת הפוסט בלוח, להעתקה.';
const AUTO_COMMENT = ' אם החיבור בלי הרשאה לתגובות — הפוסט יוצא בכל זאת, ונפתחת משימה להוסיף את התגובה ידנית.';
const HINTS = {
  format: {
    instagram: 'סטורי נשלח לאינסטגרם אוטומטית.',
    facebook: 'סטורי בפייסבוק לא נשלח אוטומטית — מסומן לפרסום ידני.',
  },
  cover: { instagram: 'תמונה שנבחרה כשער לא יוצאת כחלק מהפוסט.' },
  link: {
    facebook: 'בפוסט בלי תמונה — פייסבוק מציג כרטיס עם תצוגה מקדימה של הקישור. עם תמונה או סרטון — הקישור נוסף לסוף הטקסט.',
    instagram: 'באינסטגרם קישור בכיתוב לא לחיץ ולא נשלח — מופיע בתצוגת הפוסט בלוח.',
  },
  first_comment: {
    instagram: `נכתבת מיד אחרי הפרסום. מתאים להאשטגים, כדי שהכיתוב יישאר נקי.${AUTO_COMMENT}`,
    facebook: `נכתבת בשם העמוד מיד אחרי הפרסום. מתאים לקישור — פוסט שהקישור בגוף שלו מקבל פחות חשיפה.${AUTO_COMMENT}`,
  },
  alt_text: {
    instagram: 'מה רואים בתמונה, למי שמשתמש בקורא מסך. נשלח בפוסט עם תמונה אחת.',
    facebook: 'מה רואים בתמונה, למי שמשתמש בקורא מסך. נשלח בפוסט עם תמונה אחת.',
  },
};
const hint = (key, platform) => HINTS[key]?.[platform] ??
  (key === 'cover' ? 'תמונה שנבחרה כשער לא יוצאת כחלק מהפוסט.' : MANUAL_HINT);

function sectionBody(key, platform, meta, files) {
  if (key === 'format') {
    const story = meta.format === 'story';
    return `<div class="checks vx-radios" role="radiogroup" aria-label="סוג פרסום">
        <label><input type="radio" name="vx_format" value="" ${story ? '' : 'checked'}>
          <span>פוסט רגיל<span class="d">באינסטגרם: תמונה — פוסט · סרטון — ריל · כמה קבצים — קרוסלה</span></span></label>
        <label><input type="radio" name="vx_format" value="story" ${story ? 'checked' : ''}>
          <span>סטורי<span class="d">קובץ אחד, נעלם אחרי 24 שעות</span></span></label>
      </div>
      <div class="fhint">${esc(hint(key, platform))}</div>`;
  }
  if (key === 'cover') {
    if (!files.some((a) => isVideo(a.mime))) {
      return '<div class="fhint">מוסיפים סרטון כדי לבחור לו שער.</div>';
    }
    const images = files.filter((a) => isImage(a.mime));
    const cur = String(meta.cover_asset_id ?? '');
    return `<select id="vx_cover" aria-label="שער לסרטון">
        <option value="">פריים מתוך הסרטון</option>
        ${images.map((a) => `<option value="${a.id}"${String(a.id) === cur ? ' selected' : ''}>
          תמונה: ${esc(a.filename)}</option>`).join('')}
        ${cur && !images.some((a) => String(a.id) === cur)
          ? `<option value="${esc(cur)}" selected>התמונה שנבחרה הוסרה — בוחרים אחרת</option>` : ''}
      </select>
      <div class="subfield" id="vx_offset_row"${cur ? ' hidden' : ''}>
        <label for="vx_offset">משנייה</label>
        <input id="vx_offset" type="number" min="0" step="0.5" value="${esc(meta.cover_offset_sec ?? '')}"
               placeholder="0">
      </div>
      <div class="fhint">${esc(hint(key, platform))}${images.length ? ''
        : ' כדי לבחור תמונה — מוסיפים אותה לקבצים ושומרים.'}</div>`;
  }
  if (key === 'first_comment') {
    return `<textarea id="vx_comment" aria-label="תגובה ראשונה">${esc(meta.first_comment ?? '')}</textarea>
      <div class="fhint">${esc(hint(key, platform))}</div>`;
  }
  if (key === 'alt_text') {
    return `<textarea id="vx_alt" maxlength="${IG_LIMITS.alt}" aria-label="תיאור תמונה"
        placeholder="למשל: אישה מחייכת מול מחשב נייד, על השולחן כוס קפה">${esc(meta.alt_text ?? '')}</textarea>
      <div class="fhint">${esc(hint(key, platform))}</div>`;
  }
  if (key === 'link') {
    return `<input id="vx_link" type="url" dir="ltr" value="${esc(meta.link ?? '')}"
        placeholder="https://" aria-label="קישור">
      <div class="fhint">${esc(hint(key, platform))}</div>`;
  }
  return '';
}

/**
 * שורת הסיכום של "אפשרויות נוספות": מה בשימוש ("סטורי · תגובה ראשונה"),
 * או "לא בשימוש". אזור שמוסתר כרגע (בסטורי) לא נספר.
 */
export function moreSummary(meta = {}, files = [], platform) {
  const used = extrasFor(platform)
    .filter((key) => !hiddenFor(key, meta) && extraSummary(key, meta, files).set)
    .map((key) => (key === 'format' ? 'סטורי' : LABELS[key]));
  return used.length ? used.join(' · ') : 'לא בשימוש';
}

/**
 * ה-HTML של כל האזורים, בתוך שורה מקופלת אחת "אפשרויות נוספות" (סגורה
 * כברירת מחדל, עם סיכום של מה בשימוש). files — הקבצים של הגרסה.
 */
export function extrasHtml({ platform, meta = {}, files = [] }) {
  const keys = extrasFor(platform);
  if (!keys.length) return '';
  const sum = moreSummary(meta, files, platform);
  return `<details class="vx-more">
    <summary><span class="vx-l">אפשרויות נוספות</span>
      <span class="vx-more-sum${sum === 'לא בשימוש' ? '' : ' set'}">${esc(sum)}</span></summary>
    <div class="vx-list">${sectionsHtml(keys, platform, meta, files)}</div>
  </details>`;
}

function sectionsHtml(keys, platform, meta, files) {
  return keys.map((key) => {
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
export function wireExtras(root, { files = () => [], keep = () => ({}), platform = () => null, onChange }) {
  const paint = () => {
    const meta = { ...keep(), ...readExtras(root) };
    const more = root.querySelector('.vx-more-sum');
    if (more) {
      more.textContent = moreSummary(meta, files(), platform());
      more.classList.toggle('set', more.textContent !== 'לא בשימוש');
    }
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
export function paintCaptionNote(el, { platform, text, meta = {}, files = [], repaint = () => {} }) {
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
  const coverId = Number(meta.cover_asset_id) || null;
  const bad = files
    .filter((a) => isImage(a.mime) && a.id !== coverId)
    .filter((a) => {
      const d = imageDims(a.url ?? `/api/assets/${a.id}`, repaint);
      return d && badFeedRatio(d.w, d.h);
    });
  const count = files.filter((a) => (isImage(a.mime) || isVideo(a.mime)) && a.id !== coverId).length;
  const many = count > IG_LIMITS.carousel
    ? `<div class="over">${count} קבצים — באינסטגרם יוצאים רק ${IG_LIMITS.carousel} הראשונים.</div>` : '';
  el.innerHTML = parts.join('<span class="vsep">·</span>') + many + bad.map((a) =>
    `<div class="over">"${esc(a.filename)}" גבוהה או רחבה מדי לפיד של אינסטגרם — הפרסום יידחה.
      חותכים ליחס שבין <bdi dir="ltr">4:5</bdi> (לאורך) ל־<bdi dir="ltr">1.91:1</bdi> (לרוחב), או מפרסמים כסטורי.</div>`).join('');
}
