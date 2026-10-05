import { $$, esc } from '../core/dom.js';

/**
 * בחירה מרובה בדרופדאון: כפתור שמסכם מה נבחר, ורשימת סימונים שנפתחת מתחתיו.
 * מחליף את שורות השבבים (ערוצים, ימים) — אותה בחירה, בלי לתפוס חצי חלון.
 *
 * מאחורי הקלעים אלה אותם checkbox-ים בדיוק, עם ה-attributes שהקורא נתן
 * (data-multi, data-blocked…). לכן מי שקורא `:checked` או מאזין ל-change
 * ממשיך לעבוד בלי שינוי.
 *
 * @param {{options:[string|number,string][], value?:(string|number)[],
 *          attrs?:(v:string|number)=>string, placeholder?:string,
 *          disabled?:boolean, id?:string}} o
 *   attrs — ה-attributes של כל checkbox (בלי type/value/checked)
 */
export function multiSelectHtml({ options, value = [], attrs = () => '', placeholder = 'בחירה…',
  disabled = false, id = '' }) {
  const chosen = new Set(value.map(String));
  return `<div class="msel" data-msel data-placeholder="${esc(placeholder)}">
    <button type="button" class="msel-btn"${id ? ` id="${esc(id)}"` : ''} aria-haspopup="listbox"
      aria-expanded="false"${disabled ? ' disabled' : ''}>
      <span class="msel-sum"></span>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="msel-pop" role="listbox" aria-multiselectable="true" hidden>
      ${options.map(([v, l]) => `<label><input type="checkbox" ${attrs(v)} value="${esc(v)}"${
        chosen.has(String(v)) ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${esc(l)}</label>`).join('')}
    </div>
  </div>`;
}

/** "פייסבוק, לינקדאין ועוד 3" — עד שלושה שמות, והשאר במספר */
function summary(box) {
  const picked = $$('input:checked', box).map((i) => i.parentElement.textContent.trim());
  const sum = box.querySelector('.msel-sum');
  sum.classList.toggle('none', !picked.length);
  if (!picked.length) { sum.textContent = box.dataset.placeholder; return; }
  const total = box.querySelectorAll('input').length;
  if (picked.length === total && total > 3) { sum.textContent = `הכול (${total})`; return; }
  sum.textContent = picked.length <= 3 ? picked.join(', ')
    : `${picked.slice(0, 2).join(', ')} ועוד ${picked.length - 2}`;
}

function close(box) {
  box.querySelector('.msel-pop').hidden = true;
  box.querySelector('.msel-btn').setAttribute('aria-expanded', 'false');
}

/** פתיחה וסגירה, וסיכום שמתעדכן בכל סימון. root = האזור שבו נוצרו הרכיבים. */
export function wireMultiSelects(root = document) {
  $$('[data-msel]', root).forEach((box) => {
    if (box.dataset.wired) return;
    box.dataset.wired = '1';
    const btn = box.querySelector('.msel-btn');
    const pop = box.querySelector('.msel-pop');
    summary(box);
    pop.addEventListener('change', () => summary(box));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = pop.hidden;
      $$('[data-msel]').forEach(close);
      if (!open) return;
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      pop.querySelector('input')?.focus();
    });
    // סימון בתוך הרשימה לא סוגר אותה; לחיצה בכל מקום אחר — כן
    pop.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || pop.hidden) return;
      // Esc סוגר רק את הרשימה, לא את החלון שהיא בתוכו
      e.preventDefault();
      e.stopPropagation();
      close(box);
      btn.focus();
    });
  });
}

document.addEventListener('click', () => $$('[data-msel]').forEach(close));
