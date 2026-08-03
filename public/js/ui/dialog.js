import { $, $$, esc, run, toast } from '../core/dom.js';

/**
 * דיאלוג טופס כללי.
 *
 * במקום לכתוב טופס לכל ישות, מתארים אותו כרשימת שדות ומקבלים בחזרה
 * אובייקט ערכים. שמונה מקומות במערכת נשענים על זה — קמפיין, תוכן,
 * גרסה, נקודת קצה, ערוץ, משתמש ועוד.
 *
 * שכבה 1: תלוי רק ב-core, ואף מודול פיצ'ר לא מייבא ממנו רנדרר.
 *
 * סוגי שדות נתמכים:
 *   checkbox · multicheck · select · auto · textarea · files
 *   וכל type נייטיבי אחר (text/date/number/email…) דרך ברירת המחדל.
 */

let genSpec = null;

/** קורא את הערכים מהטופס לפי סוג כל שדה ומחזיר אובייקט אחד */
function collectValues(fields) {
  const values = {};
  for (const f of fields) {
    if (f.type === 'files') continue;      // קבצים נשלחים בנפרד ב-onSave
    const el = $(`#gen_${f.name}`);
    if (f.type === 'checkbox') {
      values[f.name] = el.checked;
    } else if (f.type === 'multicheck') {
      values[f.name] = $$(`[data-multi="${f.name}"]:checked`).map((i) => Number(i.value));
    } else if (f.type === 'auto') {
      // מצב "אוטומטי" נשמר כ-null, וזה מה שגורם לשרת לגזור את הערך בעצמו
      const manual = $(`#gen_${f.name}_mode`).checked;
      values[f.name] = manual && el.value !== '' ? Number(el.value) : null;
    } else if (f.type === 'number') {
      values[f.name] = el.value === '' ? null : Number(el.value);
    } else if (f.type === 'select') {
      const v = el.value;
      // בחירה של ישות מחזירה מזהה מספרי, בחירה של סוג מחזירה מחרוזת
      values[f.name] = v === '' ? null : (/^\d+$/.test(v) ? Number(v) : v);
    } else {
      values[f.name] = el.value.trim() === '' ? null : el.value.trim();
    }
  }
  return values;
}

export function wireGenericDialog() {
  $('#genCancel').addEventListener('click', () => $('#genDlg').close());
  $('#genSave').addEventListener('click', run(async () => {
    const values = collectValues(genSpec.fields);
    const btn = $('#genSave');
    btn.disabled = true;
    try {
      await genSpec.onSave(values);
      $('#genDlg').close();
      toast('נשמר.');
    } finally {
      btn.disabled = false;
    }
  }));
}

/** ה-HTML של שדה בודד, לפי סוגו */
function fieldHtml(f) {
  const id = `gen_${f.name}`;

  if (f.type === 'checkbox') {
    return `<div class="frow"><div class="checks"><label>
      <input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}> ${esc(f.label)}
    </label></div></div>`;
  }
  if (f.type === 'multicheck') {
    const chosen = new Set((f.value ?? []).map(Number));
    return `<div class="frow"><label>${esc(f.label)}</label><div class="checks">
      ${f.options.map(([v, l]) =>
        `<label><input type="checkbox" data-multi="${f.name}" value="${v}"${
          chosen.has(Number(v)) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}
    </div></div>`;
  }
  if (f.type === 'select') {
    const cur = f.value ?? '';
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      <select id="${id}">${f.options.map(([v, l]) =>
        `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`
      ).join('')}</select></div>`;
  }
  if (f.type === 'auto') {
    const manual = f.value != null;
    return `<div class="frow"><label>${esc(f.label)}</label>
      <div class="autofield">
        <label class="opt"><input type="radio" name="${id}_r" ${manual ? '' : 'checked'}
               data-auto-off="${f.name}">
          אוטומטי<b>${esc(f.auto ?? '—')}</b></label>
        <label class="opt"><input type="radio" name="${id}_r" ${manual ? 'checked' : ''}
               id="${id}_mode" data-auto-on="${f.name}">
          קבוע</label>
        <input id="${id}" type="number" value="${esc(f.value ?? '')}"
               placeholder="${esc(f.placeholder ?? '')}" ${manual ? '' : 'disabled'}>
      </div>
      ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}
    </div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      <textarea id="${id}">${esc(f.value ?? '')}</textarea></div>`;
  }
  if (f.type === 'files') {
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      ${f.existing ?? ''}
      <input id="${id}" type="file" multiple>
      <span class="d" style="color:var(--muted);font-size:11.5px">עד 10MB לקובץ</span>
    </div>`;
  }
  return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
    <input id="${id}" type="${f.type}" value="${esc(f.value ?? '')}">
    ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}</div>`;
}

/**
 * @param {{title:string, fields:object[], onSave:(v:object)=>Promise<void>,
 *          extraActions?:string, onOpen?:()=>void}} spec
 */
export function openGeneric(spec) {
  genSpec = spec;
  $('#genTitle').textContent = spec.title;
  $('#genBody').innerHTML = spec.fields.map(fieldHtml).join('');

  $$('#genBody [data-auto-on]').forEach((r) => r.addEventListener('change', () => {
    const input = $(`#gen_${r.dataset.autoOn}`);
    input.disabled = false;
    input.focus();
  }));
  $$('#genBody [data-auto-off]').forEach((r) => r.addEventListener('change', () => {
    $(`#gen_${r.dataset.autoOff}`).disabled = true;
  }));

  // כפתורים נוספים (למשל "מחק תוכן") נשתלים משמאל לביטול/שמירה
  $('#genExtra').innerHTML = spec.extraActions ?? '';
  spec.onOpen?.();

  $('#genDlg').showModal();
}
