import { $, $$, esc, run, toast } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { acceptAttr, fileLimitLabel } from '../core/upload.js';
import { PERIOD_PRESETS, parsePeriod, periodEnd, periodLabel } from '../core/period.js';
import { multiSelectHtml, wireMultiSelects } from './multiSelect.js';

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
 *   checkbox · multicheck · select · radio · auto · period · textarea · files
 *   html (שורת מידע מוכנה, בלי ערך — f.html כבר מוסלש בידי הקורא)
 *   וכל type נייטיבי אחר (text/date/number/email…) דרך ברירת המחדל.
 *
 * כל שורה נושאת data-field="<name>", כדי שטופס יוכל להסתיר שורה שלא
 * רלוונטית לבחירה אחרת בו (hidden: true מסתיר מההתחלה).
 */

let genSpec = null;
let genSnapshot = null; // הערכים בפתיחה — להשוואה לפני סגירה (guardDirty)
let genClosing = false; // שאלת "לסגור?" כבר פתוחה — Esc נוסף לא פותח שנייה

/** תמונת מצב של הטופס: הערכים + שמות הקבצים שנבחרו. שגיאת קריאה = לא משווים. */
function snapshot(fields) {
  try {
    const files = fields.filter((f) => f.type === 'files')
      .map((f) => [...($(`#gen_${f.name}`)?.files ?? [])].map((x) => x.name));
    return JSON.stringify([collectValues(fields), files]);
  } catch {
    return null;
  }
}

/** האם יש בטופס שינוי שלא נשמר — רק לטפסים שביקשו (guardDirty) */
function isDirty() {
  const g = genSpec?.guardDirty;
  if (!g) return false;
  if (typeof g === 'function') return g();
  const now = snapshot(genSpec.fields);
  return now !== null && genSnapshot !== null && now !== genSnapshot;
}

/**
 * סגירה בביטול/Esc. טופס עם guardDirty ששונה — שואלים קודם (עיקרון 4: לא
 * מאבדים עבודה). force — סוגרים בלי לשאול (אחרי שמירה, או מחיקה).
 * @returns {Promise<boolean>} האם הדיאלוג נסגר
 */
export async function closeGeneric({ force = false } = {}) {
  const dlg = $('#genDlg');
  if (!dlg.open) return true;
  if (!force && isDirty()) {
    if (genClosing) return false;
    genClosing = true;
    try {
      const ok = await confirmDialog('יש שינויים שלא נשמרו — לסגור?',
        { okLabel: 'סגור בלי לשמור', danger: true });
      if (!ok) return false;
    } finally {
      genClosing = false;
    }
  }
  dlg.close();
  finishClose();
  return true;
}

/**
 * onClose של הטופס הנוכחי — פעם אחת לכל פתיחה. נקרא ישירות מכל מסלול סגירה
 * שלנו (ולא רק מאירוע close, שהדפדפן מעכב בלשונית מוסתרת).
 */
function finishClose() {
  const spec = genSpec;
  if (spec && !spec.closed) {
    spec.closed = true;
    spec.onClose?.();
  }
}

/** אחרי שמירה חלקית (למשל קבצים שנכשלו): מה שכבר נשמר הוא נקודת ההשוואה החדשה */
export function markGenericClean() {
  if (genSpec) genSnapshot = snapshot(genSpec.fields);
}

/** קורא את הערכים מהטופס לפי סוג כל שדה ומחזיר אובייקט אחד */
function collectValues(fields) {
  const values = {};
  for (const f of fields) {
    if (f.type === 'files') continue;      // קבצים נשלחים בנפרד ב-onSave
    if (f.type === 'html') continue;       // שורת מידע, אין ערך
    if (f.type === 'radio') {
      // רדיו מושבת = אין מה לשנות; לא נשלח בכלל, והשרת לא נוגע בערך הקיים
      const picked = $(`[name="gen_${f.name}"]:checked`);
      if (picked && !picked.disabled) values[f.name] = picked.value;
      continue;
    }
    if (f.type === 'period') {
      Object.assign(values, periodValue(f));
      continue;
    }
    const el = $(`#gen_${f.name}`);
    if (f.type === 'checkbox') {
      values[f.name] = el.checked;
    } else if (f.type === 'multicheck') {
      // מזהה מספרי חוזר כמספר (ערוצים וכו'); מזהה מחרוזת (UUID של רשימת
      // קהל ב-HUB) נשאר מחרוזת
      values[f.name] = $$(`[data-multi="${f.name}"]:checked`)
        .map((i) => (/^\d+$/.test(i.value) ? Number(i.value) : i.value));
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

/* ---------- תקופה: בחירה מוכנה, מספר שבועות, או תאריך סיום ידני ---------- */

/** הערך שהשדה מייצג כרגע: '1m' / '<N>w' / 'custom' (+ ends_on בידני) */
function periodValue(f) {
  const sel = $(`#gen_${f.name}`).value;
  if (sel === 'weeks') {
    const n = Number($(`#gen_${f.name}_weeks`).value);
    if (!parsePeriod(`${n}w`)) throw new Error('צריך מספר שבועות שלם בין 1 ל-104');
    return { [f.name]: `${n}w` };
  }
  if (sel === 'custom') return { [f.name]: 'custom', ends_on: $(`#gen_${f.name}_end`).value || null };
  return { [f.name]: sel };
}

/** 2026-11-11 → 11.11.26 */
const shortDate = (s) => `${Number(s.slice(8, 10))}.${Number(s.slice(5, 7))}.${s.slice(2, 4)}`;

/** מציג/מסתיר את שדה המשנה, ומעדכן את "רץ עד…" מתחת לבחירה */
function syncPeriod(f) {
  const sel = $(`#gen_${f.name}`).value;
  $(`#gen_${f.name}_weeks_row`).hidden = sel !== 'weeks';
  $(`#gen_${f.name}_end_row`).hidden = sel !== 'custom';

  const start = f.start ? $(`#gen_${f.start}`)?.value : null;
  let end = null;
  if (sel === 'custom') end = $(`#gen_${f.name}_end`).value || null;
  else if (sel === 'weeks') end = periodEnd(start, `${Number($(`#gen_${f.name}_weeks`).value)}w`);
  else end = periodEnd(start, sel);

  const note = $(`#gen_${f.name}_note`);
  if (sel === 'open') {
    note.textContent = 'הקמפיין נשמר בלי תאריך סיום, כמו שהיה';
  } else if (sel === 'custom') {
    note.textContent = start && end && end < start ? 'תאריך הסיום מוקדם מהפוסט הראשון' : '';
  } else if (!start) {
    note.textContent = 'בוחרים תאריך לפוסט הראשון, ותאריך הסיום יחושב ממנו';
  } else {
    note.textContent = end ? `רץ עד ${shortDate(end)}` : '';
  }
}

function periodHtml(f, id) {
  const value = parsePeriod(f.value) ? f.value : '1m';
  const p = parsePeriod(value);
  const preset = PERIOD_PRESETS.some(([v]) => v === value);
  // ערך שמור שאינו בין המוכנים: שבועות → "מספר שבועות אחר" עם המספר;
  // חודשים (4 חודשים ומעלה) ו"בלי תאריך סיום" → אפשרות משלהם, מסומנת
  const own = !preset && (p.unit === 'm' || p.unit === 'open');
  const sel = p.unit === 'custom' ? 'custom' : (preset || own) ? value : 'weeks';
  const weeks = !preset && p.unit === 'w' ? p.n : '';
  const opts = [...PERIOD_PRESETS, ...(own ? [[value, periodLabel(value)]] : []),
    ['weeks', 'מספר שבועות אחר'], ['custom', 'תאריך סיום ידני']];
  return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
    <select id="${id}">${opts.map(([v, l]) =>
      `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <div class="subfield" id="${id}_weeks_row" hidden>
      <input id="${id}_weeks" type="number" min="1" max="104" value="${esc(weeks)}"> שבועות
    </div>
    <div class="subfield" id="${id}_end_row" hidden>
      <input id="${id}_end" type="date" value="${esc(sel === 'custom' ? f.ends_on ?? '' : '')}"
             aria-label="תאריך סיום">
    </div>
    <div class="fhint" id="${id}_note" aria-live="polite"></div>
  </div>`;
}

export function wireGenericDialog() {
  $('#genCancel').addEventListener('click', () => closeGeneric());
  // Esc: הדפדפן סוגר מיד — בטופס עם שינויים עוצרים ושואלים
  $('#genDlg').addEventListener('cancel', (e) => {
    e.preventDefault();
    closeGeneric();
  });
  // גיבוי ל-onClose: סגירה ישירה (dlg.close()) מקוד שלא עובר ב-closeGeneric.
  // אירוע שהגיע אחרי שכבר נפתח טופס חדש — שייך לקודם, שכבר טופל בפתיחה.
  $('#genDlg').addEventListener('close', () => {
    if (!$('#genDlg').open) finishClose();
  });
  $('#genSave').addEventListener('click', run(async () => {
    const values = collectValues(genSpec.fields);
    const btn = $('#genSave');
    btn.disabled = true;
    try {
      // onSave יכול להחזיר הודעה משלו במקום "נשמר.", או false — בלי טוסט
      // (כשהוא מציג משהו אחר במקומו, למשל הוראות כניסה למשתמש חדש), או
      // {keepOpen, message} — הטופס נשאר פתוח (למשל גרסה שנטענה מחדש)
      const msg = await genSpec.onSave(values);
      if (msg && typeof msg === 'object' && msg.keepOpen) {
        if (msg.message) toast(msg.message);
        return;
      }
      $('#genDlg').close();
      finishClose();
      if (msg !== false) toast(typeof msg === 'string' ? msg : 'נשמר.');
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
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      ${multiSelectHtml({ id, options: f.options, value: f.value ?? [],
        attrs: () => `data-multi="${esc(f.name)}"`, placeholder: f.placeholder })}
      ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}</div>`;
  }
  if (f.type === 'select') {
    const cur = f.value ?? '';
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      <select id="${id}">${f.options.map(([v, l]) =>
        `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`
      ).join('')}</select></div>`;
  }
  if (f.type === 'radio') {
    const cur = String(f.value ?? '');
    return `<div class="frow"><label>${esc(f.label)}</label>
      <div class="checks" role="radiogroup">${f.options.map(([v, l]) =>
        `<label><input type="radio" name="${id}" value="${esc(v)}"${
          String(v) === cur ? ' checked' : ''}${f.disabled ? ' disabled' : ''}> ${esc(l)}</label>`
      ).join('')}</div>
      ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}
    </div>`;
  }
  if (f.type === 'period') return periodHtml(f, id);
  if (f.type === 'html') return `<div class="frow">${f.html}</div>`;
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
      <textarea id="${id}"${f.max ? ` maxlength="${f.max}"` : ''}>${esc(f.value ?? '')}</textarea></div>`;
  }
  if (f.type === 'files') {
    return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
      ${f.existing ?? ''}
      <input id="${id}" type="file" multiple${acceptAttr() ? ` accept="${esc(acceptAttr())}"` : ''}>
      <span class="d" style="color:var(--muted);font-size:11.5px">${esc(fileLimitLabel())}</span>
      <div class="upload-progress" id="${id}_progress" hidden></div>
    </div>`;
  }
  return `<div class="frow"><label for="${id}">${esc(f.label)}</label>
    <input id="${id}" type="${f.type}" value="${esc(f.value ?? '')}"${f.max ? ` maxlength="${f.max}"` : ''}>
    ${f.hint ? `<div class="fhint">${esc(f.hint)}</div>` : ''}</div>`;
}

/**
 * @param {{title:string, fields:object[], onSave:(v:object)=>Promise<void>,
 *          extraActions?:string, onOpen?:()=>void, saveLabel?:string,
 *          guardDirty?:boolean|(()=>boolean), onClose?:()=>void}} spec
 * guardDirty — ביטול/Esc שואלים "לסגור?" כשהטופס השתנה מאז הפתיחה (true =
 * השוואת ערכים; פונקציה = הקורא מחליט). onClose — אחרי כל סגירה.
 */
export function openGeneric(spec) {
  // שרשור טפסים (פתיחה מתוך טופס, או לפני שאירוע הסגירה של הקודם הגיע) —
  // ה-onClose של הקודם רץ עכשיו, פעם אחת
  finishClose();
  genSpec = spec;
  // הדיאלוג משותף לכל הישויות — קישוטי התצוגה החיה של גרסת המייל
  // (עמודה + class) מוסרים לפני כל פתיחה, שלא ידבקו לטופס הבא.
  $('#genDlg').classList.remove('with-live-preview');
  $('#livePreviewPane')?.remove();
  $('#genTitle').textContent = spec.title;
  $('#genSave').textContent = spec.saveLabel ?? 'שמור';
  $('#genBody').innerHTML = spec.fields.map((f) =>
    fieldHtml(f).replace('<div class="frow"',
      `<div class="frow" data-field="${esc(f.name)}"${f.hidden ? ' hidden' : ''}`)).join('');

  for (const f of spec.fields.filter((x) => x.type === 'period')) {
    const sync = () => syncPeriod(f);
    [`#gen_${f.name}`, `#gen_${f.name}_weeks`, `#gen_${f.name}_end`, `#gen_${f.start}`]
      .forEach((sel) => $(sel)?.addEventListener('input', sync));
    sync();
  }

  wireMultiSelects($('#genBody'));

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
  genSnapshot = spec.guardDirty === true ? snapshot(spec.fields) : null;

  if (!$('#genDlg').open) $('#genDlg').showModal();
}
