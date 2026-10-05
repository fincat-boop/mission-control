/**
 * עזרי DOM בסיסיים. שכבה 0 — לא מייבאת שום דבר מהאפליקציה,
 * וכל מודול אחר יכול להישען עליה בלי לחשוש ממעגל.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
let toastHold = false; // הטוסט הנוכחי מחכה ללחיצה — ריחוף/פוקוס עוצרים את ההסתרה
const hideToast = () => { $('#toast').style.display = 'none'; };

/**
 * מכריזים: הודעה רגילה בנימוס (status), שגיאה מיד (alert). אותו אלמנט —
 * התפקיד מתחלף לפני שהטקסט נכנס, כדי שקורא המסך יכריז לפי החדש.
 */
function setToastRole(t, urgent) {
  t.setAttribute('role', urgent ? 'alert' : 'status');
  t.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
}

/**
 * הודעה קצרה בתחתית המסך.
 *
 * מידע נעלם אחרי 3.2 שניות. שגיאה (isError) ואזהרה (טקסט שמתחיל ב-⚠)
 * נשארות עד שסוגרים ב-✕ או שהודעה חדשה מחליפה אותן — שגיאה שנעלמת לפני
 * שקראו אותה היא שגיאה שלא קרתה.
 */
export function toast(msg, isError = false) {
  const t = $('#toast');
  const warn = !isError && String(msg).trimStart().startsWith('⚠');
  const sticky = isError || warn;
  toastHold = false;
  clearTimeout(toastTimer);
  setToastRole(t, isError);
  t.classList.toggle('err', isError);
  t.classList.toggle('warn', warn);

  const text = document.createElement('span');
  text.textContent = msg;
  if (!sticky) {
    t.replaceChildren(text);
    t.style.display = 'block';
    toastTimer = setTimeout(hideToast, 3200);
    return;
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-x';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'סגור את ההודעה');
  close.addEventListener('click', hideToast, { once: true });
  t.replaceChildren(text, close);
  t.style.display = 'block';
}

/** ריחוף או פוקוס על טוסט עם פעולה עוצרים את הספירה; היציאה מחדשת אותה */
function wireToastHold(t) {
  if (t.dataset.holdWired) return;
  t.dataset.holdWired = '1';
  const pause = () => { if (toastHold) clearTimeout(toastTimer); };
  const resume = () => {
    if (!toastHold) return;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3000);
  };
  t.addEventListener('mouseenter', pause);
  t.addEventListener('focusin', pause);
  t.addEventListener('mouseleave', resume);
  t.addEventListener('focusout', resume);
}

/**
 * טוסט עם כפתור פעולה ("בטל"). נשאר ~8 שניות — מספיק לקרוא ולהחליט;
 * ריחוף או פוקוס עוצרים את הספירה, כדי שמי שמגיע עם מקלדת לא יפספס.
 * אותו אלמנט #toast (role=status), כך שקורא מסך מכריז עליו כמו על כל טוסט.
 */
export function toastAction(msg, label, onClick, ms = 8000) {
  const t = $('#toast');
  wireToastHold(t);
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-act';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    toastHold = false;
    clearTimeout(toastTimer);
    hideToast();
    onClick();
  }, { once: true });
  setToastRole(t, false);
  t.replaceChildren(text, btn);
  t.classList.remove('err', 'warn');
  t.style.display = 'block';
  toastHold = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

/** עוטף פעולה כך ששגיאת שרת תוצג כטוסט במקום להיעלם בקונסול */
export const run = (fn) => async (...args) => {
  try { await fn(...args); }
  catch (e) { toast(e.message, true); }
};

/**
 * כפתור "העתק קישור" לקובץ שיש לו קישור ציבורי קבוע (מדיה ב-R2).
 * בלי url — אין כפתור (קובץ ישן שעוד לא הועבר).
 */
export const copyLinkButton = (url) => (url
  ? `<button type="button" class="btn small" data-copy-link="${esc(url)}"
       title="קישור ציבורי קבוע — להדבקה ברשת חברתית או לשליחה לעורך">העתק קישור</button>`
  : '');

/**
 * העתקה ללוח. Clipboard API קודם; אם הדפדפן מסרב (הרשאה, הקשר לא מאובטח)
 * — textarea זמני + execCommand. ה-textarea נשתל ליד הכפתור, כי מחוץ
 * ל-<dialog> מודאלי אי אפשר לבחור בו טקסט.
 */
export async function copyText(text, near) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* ננסה בדרך הישנה */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  (near ?? document.body).appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('ההעתקה נכשלה — הדפדפן חסם גישה ללוח');
}

/** מחווט את כל כפתורי "העתק קישור" בתוך root */
export function wireCopyLinks(root) {
  root?.querySelectorAll('[data-copy-link]').forEach((b) =>
    b.addEventListener('click', run(async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await copyText(b.dataset.copyLink, b.parentElement);
      toast('הקישור הועתק');
    })));
}

export function fillSelect(sel, items, labelKey, emptyLabel) {
  sel.innerHTML =
    (emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : '') +
    items.map((i) => `<option value="${i.id}">${esc(i[labelKey])}</option>`).join('');
}
