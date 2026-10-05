import { esc, toast } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';

/**
 * ממלא התבניות — פורט נאמן של TemplateFieldsEditor מה-HUB לאפליקציה הזו:
 * חלונית מסך-מלא, רשימת השדות מימין לפי סדר הופעתם בתבנית, תצוגה חיה
 * משמאל שמתעדכנת מיידית בלי לאבד גלילה, קישור דו-כיווני (לחיצה על בלוק
 * בתצוגה מקפיצה לשדה; פוקוס בשדה מסמן את הבלוק), והדגשות בסגנון Markdown.
 *
 * לוגיקת המילוי משוכפלת אחד-לאחד מ-lib/templates של ה-HUB (editable /
 * fieldLinks / fieldFormat / blockMarkers) — **חובה שתישאר זהה**: מה
 * שרואים כאן חייב להתרנדר אותו דבר בשליחה, שנעשית ב-HUB באותן פונקציות.
 * תחביר הערכים: `**מודגש**`, `_נטוי_`, `[טקסט](כתובת)`.
 *
 * בלי טוקני האנשה (אין כאן נמענים) ובלי עריכת מבנה (שכפול/מחיקה/תמונות) —
 * את אלה עושים בתבנית עצמה ב-HUB.
 */

/* ---------- פורט מדויק של פונקציות המילוי מה-HUB ---------- */

const FIELD_RE = () => /\[\[\s*([^\]|]+?)\s*(?:\|([^\]]*?))?\s*\]\]/g;
const LIQUID_RE = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/g;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const BOLD_RE = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
const ITALIC_RE = /_(?!\s)([^_\n]+?)(?<!\s)_/g;
const OPAQUE_RE = /(<[^>]*>|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/;
const LINK_STYLE = 'color:#02132A; font-weight:bold; text-decoration:underline;';

const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeExceptLiquid = (v) =>
  v.split(LIQUID_RE).map((p, i) => (i % 2 === 1 ? p : escapeHtml(p))).join('');

function normalizeUrl(url) {
  const u = url.trim();
  if (!u) return null;
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(u)) return u;
  if (u.startsWith('{{') || u.startsWith('{%')) return u;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(u)) return `https://${u}`;
  return null;
}

const renderLinks = (escaped) => escaped.replace(LINK_RE, (full, text, url) => {
  const href = normalizeUrl(url);
  if (!href) return text || full;
  return `<a href="${href}" style="${LINK_STYLE}" target="_blank" rel="noopener noreferrer">${text}</a>`;
});

const emphasize = (t) => t
  .replace(BOLD_RE, (_f, inner) => `<strong>${inner}</strong>`)
  .replace(ITALIC_RE, (_f, inner) => `<em>${inner}</em>`);

const renderEmphasis = (html) =>
  html.split(OPAQUE_RE).map((p, i) => (i % 2 === 1 ? p : emphasize(p))).join('');

const stripMarkers = (html) => html
  .replace(/<!--fc:hide-->[\s\S]*?<!--\/fc:hide-->/g, '')
  .split('<!--fc:block-->').join('').split('<!--/fc:block-->').join('')
  .replace(/<!--fc:unit:[^>]*-->/g, '').replace(/<!--\/fc:unit-->/g, '');

/** האם ההיסט בתוך תג פתוח (בין < ל->) — שדה בתוך href לא נעטף לסימון. */
const insideTag = (html, offset) =>
  html.lastIndexOf('<', offset) > html.lastIndexOf('>', offset);

const isMultiline = (opts) => (opts ?? '').split(',').some((o) => o.trim() === 'multiline');

/** מילוי התבנית. markFields עוטף כל ערך ב-span מזוהה — לקישור הדו-כיווני. */
export function fillTemplate(html, values, { markFields = false } = {}) {
  const source = stripMarkers(html);
  return source.replace(FIELD_RE(), (_full, rawName, rawOpts, offset) => {
    const name = rawName.trim();
    const escaped = renderEmphasis(renderLinks(escapeExceptLiquid(values[name] ?? '')));
    const filled = isMultiline(rawOpts) ? escaped.replace(/\n/g, '<br>') : escaped;
    return markFields && !insideTag(source, offset)
      ? `<span data-fc-field="${escapeHtml(name)}" style="display:contents">${filled}</span>`
      : filled;
  });
}

/* ---------- הדגשה/קישור על הקטע המסומן בתיבה ---------- */

function wrapSelection(input, marker) {
  const { selectionStart: a, selectionEnd: b, value } = input;
  if (a == null || b == null || b <= a || !value.slice(a, b).trim()) {
    toast('סמן קודם את הטקסט בתיבה.');
    return null;
  }
  const inner = value.slice(a, b);
  // כיבוי: הקטע כבר עטוף בדיוק בסימון הזה
  if (value.slice(a - marker.length, a) === marker && value.slice(b, b + marker.length) === marker) {
    return { value: value.slice(0, a - marker.length) + inner + value.slice(b + marker.length) };
  }
  return { value: value.slice(0, a) + marker + inner + marker + value.slice(b) };
}

function wrapSelectionAsLink(input) {
  const { selectionStart: a, selectionEnd: b, value } = input;
  const text = value.slice(a ?? 0, b ?? 0);
  if (!text.trim()) { toast('סמן קודם את הטקסט שיהפוך לקישור.'); return null; }
  if (/[[\]()]/.test(text)) { toast('הקטע המסומן נוגע בקישור קיים.'); return null; }
  const url = prompt('כתובת הקישור (אפשר גם דומיין חשוף):');
  if (url == null) return null;
  return { value: `${value.slice(0, a)}[${text}](${url.trim()})${value.slice(b)}` };
}

/* ---------- החלונית עצמה ---------- */

let dlgEl = null;

function ensureDialog() {
  if (dlgEl) return dlgEl;
  dlgEl = document.createElement('dialog');
  dlgEl.className = 'filler-dlg';
  document.body.appendChild(dlgEl);
  return dlgEl;
}

/**
 * @param {{html:string, fields:Array<{name:string,label?:string,multiline:boolean,max?:number}>,
 *          values:Record<string,string>, title?:string,
 *          subject?:string, readyButton?:boolean,
 *          onSave:(values:Record<string,string>, extra:{subject:string, ready:boolean})=>Promise<void>|void}} spec
 * subject !== undefined — שדה נושא בראש הרשימה; readyButton — כפתור
 * "שמור וסמן מוכן" לצד השמירה הרגילה.
 * onSave — החלונית נשארת פתוחה עד שהשמירה מצליחה; שגיאה (throw) מוצגת
 * כהודעת שגיאה והמילוי נשאר כמו שהוא.
 */
export function openTemplateFiller({ html, fields, values, title = 'מילוי תוכן', subject, readyButton = false, onSave }) {
  const dlg = ensureDialog();
  const current = { ...values };

  dlg.innerHTML = `
    <div class="filler-head">
      <h3>${esc(title)}</h3>
      <span class="filler-tools">
        <button type="button" class="btn tiny" data-em="**" title="הדגש מסומן (או הקלד **סביב**)"><b>B</b></button>
        <button type="button" class="btn tiny" data-em="_" title="הטה מסומן"><i>I</i></button>
        <button type="button" class="btn tiny" data-link="1" title="הפוך מסומן לקישור">🔗</button>
      </span>
      <span class="d">מה שרואים כאן הוא מה שיישלח</span>
      <span class="filler-actions">
        <button type="button" class="btn" id="fillerCancel">ביטול</button>
        ${readyButton ? '<button type="button" class="btn" id="fillerReady" style="color:var(--st-good)">⚡ שמור וסמן מוכן</button>' : ''}
        <button type="button" class="btn primary" id="fillerSave">שמירה</button>
      </span>
    </div>
    <div class="filler-cols">
      <div class="filler-fields">
        ${subject !== undefined ? `
          <div class="filler-row filler-subject">
            <div class="filler-row-head"><label for="fl__subject">נושא המייל</label></div>
            <input id="fl__subject" value="${esc(subject ?? '')}" placeholder='"פרסומת" תתווסף אוטומטית אם חסר'>
          </div>` : ''}
        ${fields.map((f) => `
          <div class="filler-row" data-row="${esc(f.name)}">
            <div class="filler-row-head">
              <label for="fl_${esc(f.name)}">${esc(f.label || f.name)}</label>
            </div>
            ${f.multiline
              ? `<textarea id="fl_${esc(f.name)}" rows="3"${f.max ? ` maxlength="${f.max}"` : ''}>${esc(current[f.name] ?? '')}</textarea>`
              : `<input id="fl_${esc(f.name)}"${f.max ? ` maxlength="${f.max}"` : ''} value="${esc(current[f.name] ?? '')}">`}
            ${f.max ? `<span class="filler-count d" data-count="${esc(f.name)}"></span>` : ''}
          </div>`).join('')}
      </div>
      <div class="filler-preview"><iframe sandbox="allow-same-origin" title="תצוגת המייל"></iframe></div>
    </div>`;

  const frame = dlg.querySelector('iframe');
  const input = (name) => dlg.querySelector(`#fl_${CSS.escape(name)}`);

  // הסרגל בראש פועל על השדה האחרון שהיה בפוקוס
  let activeField = null;

  /* תצוגה: כתיבה פעם אחת, אחר-כך החלפת body בלבד — הגלילה נשמרת. */
  let painted = false;
  const paint = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const body = fillTemplate(html, current, { markFields: true });
    if (!painted || !doc.body) {
      doc.open();
      doc.write(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><style>body{margin:0;background:#fff;font-family:Arial,sans-serif;}[data-fc-field]{cursor:pointer;}</style></head><body>${body}</body></html>`);
      doc.close();
      painted = true;
    } else {
      doc.body.innerHTML = body;
    }
    // לחיצה על בלוק בתצוגה מקפיצה לשדה שלו
    doc.body.querySelectorAll('[data-fc-field]').forEach((el) =>
      el.addEventListener('click', () => {
        const target = input(el.dataset.fcField);
        target?.focus();
        target?.closest('.filler-row')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }));
  };

  /* פוקוס בשדה מסמן את הבלוק בתצוגה (outline — לא מזיז כלום) */
  const mark = (name, on) => {
    frame.contentDocument?.querySelectorAll(`[data-fc-field="${CSS.escape(name)}"]`)
      .forEach((el) => { el.style.outline = on ? '2px solid #c99a3c' : ''; });
  };

  const counters = () => fields.forEach((f) => {
    if (!f.max) return;
    const left = f.max - (input(f.name)?.value.length ?? 0);
    const el = dlg.querySelector(`[data-count="${CSS.escape(f.name)}"]`);
    if (el) el.textContent = `${left} תווים נותרו`;
  });

  fields.forEach((f) => {
    const el = input(f.name);
    el?.addEventListener('input', () => { current[f.name] = el.value; paint(); counters(); });
    el?.addEventListener('focus', () => { activeField = f.name; mark(f.name, true); });
    el?.addEventListener('blur', () => mark(f.name, false));
  });

  const applyToActive = (fn) => {
    if (!activeField) return toast('היכנס קודם לשדה שרוצים לעצב.');
    const el = input(activeField);
    const next = el && fn(el);
    if (next) { el.value = next.value; current[activeField] = next.value; paint(); }
    el?.focus();
  };
  dlg.querySelectorAll('[data-em]').forEach((b) =>
    // mousedown ולא click — לחיצה רגילה מפילה קודם את הפוקוס והבחירה מהשדה
    b.addEventListener('mousedown', (e) => { e.preventDefault(); applyToActive((el) => wrapSelection(el, b.dataset.em)); }));
  dlg.querySelector('[data-link]')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    applyToActive((el) => wrapSelectionAsLink(el));
  });

  const collect = () => ({
    values: { ...current },
    subject: dlg.querySelector('#fl__subject')?.value?.trim() ?? '',
  });
  // מה שהיה בפתיחה — "ביטול" על מילוי ששונה שואל קודם (לא מאבדים עבודה)
  const initial = JSON.stringify(collect());
  const dirty = () => JSON.stringify(collect()) !== initial;
  const close = async () => {
    if (dirty() && !(await confirmDialog('יש שינויים שלא נשמרו — לסגור?',
      { okLabel: 'סגור בלי לשמור', danger: true }))) return;
    dlg.close();
  };
  dlg.oncancel = (e) => { e.preventDefault(); close(); };
  dlg.querySelector('#fillerCancel').addEventListener('click', close);

  const actionBtns = [...dlg.querySelectorAll('.filler-actions .btn')];
  const save = async (ready) => {
    const { values: v, subject: subj } = collect();
    actionBtns.forEach((b) => { b.disabled = true; });
    try {
      await onSave(v, { subject: subj, ready });
      dlg.close();
    } catch (e) {
      toast(e.message, true);
    } finally {
      actionBtns.forEach((b) => { b.disabled = false; });
    }
  };
  dlg.querySelector('#fillerSave').addEventListener('click', () => save(false));
  dlg.querySelector('#fillerReady')?.addEventListener('click', () => save(true));

  dlg.showModal();
  paint();
  counters();
}
