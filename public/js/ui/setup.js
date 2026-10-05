import { $, $$, esc, run } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { goToTab } from './refresh.js';

/**
 * כרטיס "הקמה" בראש הלוח — לארגון שעוד חסר לו צעד חובה (ערוץ, נקודת
 * קצה, קמפיין/תוכן). הצעדים מחושבים בשרת (GET /setup-status, src/setup.js);
 * כאן רק הציור, הניווט של כל כפתור, וההסתרה לפי צופה.
 *
 * שכבה 1: נשען על core ועל מתאם הרענון, ולא מכיר רנדרר של אף פיצ'ר. הניווט
 * למקום בתוך "ניהול" נשען על מאפיינים יציבים שם: data-section לאזור,
 * data-open-id="ch-<id>" לערוץ.
 */

/* ---------- הסתרה לפי צופה ---------- */

// לפי ארגון ומשתמש — דפדפן משותף לא מסתיר לאחד את מה שהשני הסתיר
const hideKey = () => `mc.setupHidden.${state.me?.org_id ?? 0}.${state.me?.id ?? 0}`;

function readHidden() {
  try { return JSON.parse(localStorage.getItem(hideKey()) ?? 'null'); } catch { return null; }
}

function writeHidden(value) {
  try {
    if (value) localStorage.setItem(hideKey(), JSON.stringify(value));
    else localStorage.removeItem(hideKey());
  } catch { /* אחסון חסום — הכרטיס פשוט נשאר פתוח */ }
}

const doneRequired = (status) =>
  status.steps.filter((s) => s.required && s.done).map((s) => s.id);

/**
 * מקופל = הצופה לחץ "הסתר עד שאסיים", ושום צעד חובה שהיה בוצע באותו רגע
 * לא נסוג מאז. נסיגה (ערוץ אחרון נמחק, למשל) — הכרטיס חוזר פתוח.
 */
function isCollapsed(status) {
  const hidden = readHidden();
  if (!Array.isArray(hidden)) return false;
  const now = new Set(doneRequired(status));
  if (hidden.some((id) => !now.has(id))) {
    writeHidden(null);
    return false;
  }
  return true;
}

/* ---------- שליפה, עם זיכרון ל"הושלם" ---------- */

// ארגון שסיים את ההקמה לא צריך לשאול שוב בכל ציור של הלוח. נשמר רק בזיכרון
// של הדף (לא בדפדפן), ומתאפס כשערוץ או נקודת קצה נמחקים/מושבתים בניהול —
// רק אז צעד חובה יכול לסגת.
let completeThisSession = false;

/** מצב ההקמה, או null כשכבר ידוע שהושלמה (או כשהשליפה נכשלה — הלוח לא נופל) */
export async function fetchSetupStatus() {
  if (completeThisSession) return null;
  try {
    const status = await api('/setup-status');
    completeThisSession = !!status?.complete;
    return status;
  } catch {
    return null;
  }
}

/** ערוץ או נקודת קצה נמחקו/הושבתו — הבדיקה הבאה של הלוח שואלת שוב */
export function resetSetupStatus() {
  completeThisSession = false;
}

/* ---------- ציור ---------- */

/** כפתור שמנווט ליעד של צעד — גם מחוץ לכרטיס (המצב הריק של הלוח) */
export const setupGoButton = (target, label, primary = false) =>
  `<button type="button" class="btn small${primary ? ' primary' : ''}"
     data-setup-go="${esc(JSON.stringify(target))}">${esc(label)}</button>`;

function stepLine(s, primary) {
  const cls = s.done ? 'on' : s.info ? 'off' : s.required ? 'bad' : 'warn';
  const act = s.done ? ''
    : s.blocked ? '<span class="setup-wait">אחרי נקודת הקצה</span>'
    : setupGoButton(s.target, s.action, primary);
  return `<li class="setupline${s.done ? ' done' : ''}">
    <span class="sdot-line ${cls}"><i></i></span>
    <div class="setuptxt"><b>${esc(s.title)}</b><span>${esc(s.detail)}</span></div>
    ${act}
  </li>`;
}

function cardHtml(status) {
  const required = status.steps.filter((s) => s.required);
  const left = required.filter((s) => !s.done).length;

  if (isCollapsed(status)) {
    return `<div class="setupbar">
      <b>הקמה</b><span>${left === 1 ? 'נשאר צעד אחד' : `נשארו ${left} צעדים`} מתוך ${required.length}</span>
      <button type="button" class="btn small" data-setup-show>הצג</button>
    </div>`;
  }

  // הכפתור הראשי — לצעד החובה הראשון שאפשר לבצע עכשיו
  const next = required.find((s) => !s.done && !s.blocked);
  const optional = status.steps.filter((s) => !s.required && s.relevant);
  return `<section class="setupcard panel" aria-labelledby="setupTitle">
    <div class="setuphead">
      <h2 id="setupTitle">הקמה</h2>
      <span class="setupcount">${required.length - left} מתוך ${required.length} בוצעו</span>
      <button type="button" class="btn small" data-setup-hide>הסתר עד שאסיים</button>
    </div>
    <p class="setupsub">שלושה צעדים, והלוח מתחיל להתמלא לבד.</p>
    <ol class="setuplist">${required.map((s) => stepLine(s, s === next)).join('')}</ol>
    ${optional.length ? `<h3 class="setupopt">מומלץ</h3>
      <ul class="setuplist">${optional.map((s) => stepLine(s, false)).join('')}</ul>` : ''}
  </section>`;
}

/**
 * מצייר את הכרטיס לתוך el (ריק כשההקמה הושלמה או כשאין נתונים) ומחווט אותו.
 * הסתרה/הצגה מציירות מחדש מקומית, בלי לרענן את כל הלוח.
 */
export function renderSetupCard(el, status) {
  if (!el) return;
  el.innerHTML = status && !status.complete ? cardHtml(status) : '';
  wireSetupGo(el);
  $('[data-setup-hide]', el)?.addEventListener('click', () => {
    writeHidden(doneRequired(status));
    renderSetupCard(el, status);
  });
  $('[data-setup-show]', el)?.addEventListener('click', () => {
    writeHidden(null);
    renderSetupCard(el, status);
  });
}

/* ---------- ניווט ---------- */

const ADD_BUTTON = { channels: '#addChannel', endpoints: '#addEndpoint' };
const FOCUS = {
  platform: (id) => `[data-ch-platform="${id}"]`,
  token: (id) => `[data-conn-token="${id}"]`,
};

/**
 * מעבר ליעד של צעד: טאב, ובתוך "ניהול" — לאזור או לערוץ מסוים (נפתח),
 * פוקוס על השדה הרלוונטי, או פתיחת חלון ההוספה כשאין עדיין כלום.
 */
export async function goToSetupTarget(t) {
  await goToTab(t.tab);
  if (t.tab !== 'manage') return;
  const root = $('#manage');
  let el = null;
  if (t.channel) {
    el = root.querySelector(`details[data-open-id="ch-${Number(t.channel)}"]`);
    if (el) el.open = true;
  } else if (t.section) {
    el = root.querySelector(`[data-section="${t.section}"]`);
  }
  el?.scrollIntoView({ block: 'start' });
  if (t.focus && FOCUS[t.focus]) root.querySelector(FOCUS[t.focus](Number(t.channel)))?.focus();
  if (t.add && ADD_BUTTON[t.section]) $(ADD_BUTTON[t.section])?.click();
}

/** מחווט כל כפתור data-setup-go בתוך root */
export function wireSetupGo(root) {
  $$('[data-setup-go]', root).forEach((b) =>
    b.addEventListener('click', run(() => goToSetupTarget(JSON.parse(b.dataset.setupGo)))));
}
