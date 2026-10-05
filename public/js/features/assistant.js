import { $, $$, esc, run, toast } from '../core/dom.js';
import { api } from '../core/api.js';
import { rebuildEpColors, state } from '../core/state.js';
import { describeArgs } from '../core/proposalArgs.js';
import { AI_CHAT_PREFIX } from '../core/session.js';
import { refreshAlerts, refreshCurrentTab, refreshTaskBadge } from '../ui/refresh.js';

/* ========================= העוזר ========================= */

/**
 * השיחה נשמרת כאן בלקוח ונשלחת בכל פנייה — השרת חסר מצב.
 * `log` הוא מה שרואים על המסך; `history` הוא מה שהמודל רואה.
 */
const ai = { history: [], log: [], busy: false, ready: null, usd: 0 };

/**
 * השיחה שורדת רענון (sessionStorage — רק בלשונית הזו, ונמחקת כשסוגרים
 * אותה). תקרה על הגודל: שיחה ארוכה מקצרת את ההתחלה, כמו trimHistory בשרת —
 * ההיסטוריה נחתכת רק בהודעת משתמש רגילה, כדי לא להשאיר תוצאת כלי בלי הקריאה שלה.
 * חסימת אחסון (גלישה פרטית, מכסה) לא מפילה כלום — פשוט לא נשמר.
 */
// לכל משתמש בארגון מפתח משלו — לשונית שעברה משתמש לא מציגה שיחה של אחר.
// הקידומת (AI_CHAT_PREFIX) נמחקת כולה ביציאה ובהחלפת משתמש (core/session.js).
const chatKey = () => `${AI_CHAT_PREFIX}${state.me?.org_id ?? 0}:${state.me?.id ?? 0}`;
const AI_CHAT_MAX_CHARS = 400000;
const AI_KEEP_LOG = 60;
const AI_KEEP_HISTORY = 30;

function trimForStorage({ history, log, usd }) {
  const keptLog = log.slice(-AI_KEEP_LOG);
  let keptHistory = [];
  for (let i = Math.max(0, history.length - AI_KEEP_HISTORY); i < history.length; i += 1) {
    const m = history[i];
    if (m.role === 'user' && typeof m.content === 'string') { keptHistory = history.slice(i); break; }
  }
  return { history: keptHistory, log: keptLog, usd };
}

function saveAI() {
  try {
    let data = { history: ai.history, log: ai.log.filter((e) => !e.pending), usd: ai.usd };
    let json = JSON.stringify(data);
    if (json.length > AI_CHAT_MAX_CHARS) {
      data = trimForStorage(data);
      json = JSON.stringify(data);
    }
    if (json.length > AI_CHAT_MAX_CHARS) json = JSON.stringify({ history: [], log: data.log, usd: data.usd });
    sessionStorage.setItem(chatKey(), json);
  } catch { /* אחסון חסום או מלא — השיחה פשוט לא תשרוד רענון */ }
}

function loadAI() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(chatKey()) ?? 'null');
    if (!saved || !Array.isArray(saved.log) || !Array.isArray(saved.history)) return;
    ai.history = saved.history;
    ai.usd = Number(saved.usd) || 0;
    // הצעה שאושרה ממש לפני הרענון — לא ידוע אם הסתיימה
    ai.log = saved.log.filter((e) => !e.pending).map((e) => (e.type === 'proposal' && e.state === 'running'
      ? { ...e, state: 'failed', error: 'הדף נטען מחדש באמצע הביצוע — בודקים במסך אם זה קרה' }
      : e));
  } catch { /* שמור פגום או אחסון חסום — מתחילים שיחה חדשה */ }
}

const AI_INTRO = `<div class="aihint"><b>מה אני יכול</b>
להסביר למה הלוח נראה כמו שהוא נראה, למצוא פוסטים שחסר להם תוכן ולהציע מה לעשות איתם.
אני גם יודע לייצר קמפיינים, להזיז פוסטים ולכתוב ניסוחים לכל ערוץ —
אבל כל פעולה עוברת אצלך לאישור לפני שהיא קורית.
במנוע השיבוץ אני לא נוגע: אני יכול להראות מה הוא היה מציע ולמה, לא לשנות אותו.</div>`;

const AI_OPEN_KEY = 'mb_ai_open';

export function wireAIWidget() {
  loadAI();
  $('#aiFab').addEventListener('click', () => openAI(true));
  $('#aiClose').addEventListener('click', () => openAI(false));
  $('#aiSend').addEventListener('click', run(sendAI));
  $('#aiClear').addEventListener('click', () => {
    ai.history = [];
    ai.log = [];
    ai.usd = 0;
    try { sessionStorage.removeItem(chatKey()); } catch { /* אין מה למחוק */ }
    renderAI();
    $('#aiInput').focus();
  });

  const input = $('#aiInput');
  input.addEventListener('keydown', (e) => {
    // Enter שולח, Shift+Enter יורד שורה
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run(sendAI)();
    }
  });
  // תיבת הכתיבה גדלה עם הטקסט עד לתקרה שנקבעת ב-CSS
  input.addEventListener('input', autosizeAI);

  // Esc סוגר את הווידג'ט כשהמיקוד בתוכו — בלי לפגוע בדיאלוגים
  $('#aiWidget').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openAI(false);
  });

  // נשאר פתוח בין רענונים אם ככה השארת אותו
  if (localStorage.getItem(AI_OPEN_KEY) === '1') openAI(true);
}

function autosizeAI() {
  const el = $('#aiInput');
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const openAI = run(async (open) => {
  localStorage.setItem(AI_OPEN_KEY, open ? '1' : '0');
  $('#aiPanel').hidden = !open;
  $('#aiFab').hidden = open;
  if (!open) return;

  if (ai.ready === null) {
    const { ready } = await api('/assistant/status');
    ai.ready = ready;
  }
  renderAI();
  $('#aiInput').focus();
});

function renderAI() {
  const log = $('#aiLog');
  if (!ai.ready) {
    log.innerHTML = `<div class="aihint"><b>העוזר לא מחובר</b>
      צריך להוסיף משתנה סביבה בשם <code>ANTHROPIC_API_KEY</code> בשירות ב-Railway
      ולהפעיל מחדש. אחרי זה הוא זמין כאן.</div>`;
    return;
  }
  saveAI();
  log.innerHTML = (ai.log.length ? '' : AI_INTRO) + ai.log.map(aiEntry).join('');
  log.scrollTop = log.scrollHeight;
  // העלות המצטברת של השיחה — כדי שלא תהיה הפתעה בחשבון
  $('#aiCost').textContent = ai.usd
    ? `${ai.usd < 0.01 ? '<$0.01' : `$${ai.usd.toFixed(2)}`} בשיחה הזו`
    : 'מבצע רק אחרי אישור';
}

/** הצעה שנשמרת בשרת 30 דקות (PROPOSAL_TTL_MS ב-src/assistant.js) — אחריהן "אשר" יחזיר 410 */
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const proposalExpired = (entry) => !entry.state && entry.at != null && Date.now() - entry.at > PROPOSAL_TTL_MS;

function aiEntry(entry, i) {
  if (entry.type === 'proposal') {
    const p = entry.proposal;
    // מה ההצעה עושה, בעברית ובשמות; ה-JSON הגולמי מקופל למי שצריך אותו
    const rows = describeArgs(p.args, {
      channels: state.channels, endpoints: state.endpoints,
      campaigns: state.campaigns, users: state.users,
    });
    const raw = Object.entries(p.args ?? {})
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    return `<div class="aiprop${entry.state || proposalExpired(entry) ? ' done' : ''}">
      <div class="t">${esc(p.summary)}</div>
      ${p.warnings?.length
        ? `<div class="w">${p.warnings.map((w) => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
      ${rows.length ? `<dl class="aiargs">${rows.map(([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${raw ? `<details class="aitech"><summary>פרטים טכניים</summary>
        <div class="args">${esc(raw)}</div></details>` : ''}
      ${entry.state === 'failed'
        ? `<div class="w err">הביצוע נכשל: ${esc(entry.error)} — אפשר לבקש מהעוזר שוב</div>`
        : proposalExpired(entry)
        ? '<div class="w">פג תוקף — ההצעה כבר לא בשרת. אפשר לבקש מהעוזר שוב.</div>'
        : entry.state
        ? `<div class="w" style="color:${entry.state === 'done' ? 'var(--st-good)' : 'var(--ink-2)'}">${
            entry.state === 'done' ? '✓ בוצע' : 'בוטל'}</div>`
        : `<div class="acts">
             <button class="btn small" data-ai-skip="${i}">לא עכשיו</button>
             <button class="btn small primary" data-ai-ok="${i}">אשר ובצע</button>
           </div>`}
    </div>`;
  }
  const html = entry.role === 'bot' ? aiText(entry.text) : esc(entry.text);
  return `<div class="aimsg ${entry.role}">${html}</div>`;
}

/**
 * העוזר מתבקש לכתוב טקסט רגיל, בלי markdown. מה שכן מותר לו זה שורת
 * רשימה שמתחילה ב-"- ", ולכן רק היא מקבלת טיפול. ההימלטות קודמת להכול,
 * כך שגם אם בכל זאת יגיע תו מסוכן הוא לא ייכנס כ-HTML.
 */
function aiText(text) {
  return esc(text)
    .split('\n')
    .map((line) => {
      if (/^\s*-\s+/.test(line)) {
        return `<span class="li">${line.replace(/^\s*-\s+/, '')}</span>`;
      }
      // רשת ביטחון: אם בכל זאת חוזרת כותרת markdown, מציגים אותה ככותרת
      // ולא כשורה שמתחילה בסולמיות
      if (/^\s*#{1,6}\s+/.test(line)) {
        return `<span class="h">${line.replace(/^\s*#{1,6}\s+/, '')}</span>`;
      }
      return line;
    })
    .join('\n');
}

// לחיצות על כפתורי ההצעות — האזנה אחת על המכל, כי התוכן מצויר מחדש
document.addEventListener('click', (e) => {
  const ok = e.target.closest('[data-ai-ok]');
  const skip = e.target.closest('[data-ai-skip]');
  if (ok) return void run(confirmProposal)(Number(ok.dataset.aiOk));
  if (skip) {
    const entry = ai.log[Number(skip.dataset.aiSkip)];
    if (entry) {
      entry.state = 'skipped';
      ai.history.push({ role: 'user', content: `[המשתמש דחה את ההצעה: ${entry.proposal.summary}]` });
      renderAI();
    }
  }
});

async function sendAI() {
  if (ai.busy) return;
  const input = $('#aiInput');
  const text = input.value.trim();
  if (!text) return;

  ai.busy = true;
  input.value = '';
  autosizeAI();
  ai.log.push({ type: 'msg', role: 'me', text });
  ai.log.push({ type: 'msg', role: 'sys', text: 'חושב…', pending: true });
  renderAI();
  $('#aiSend').disabled = true;

  try {
    const res = await api('/assistant/chat', {
      method: 'POST',
      body: { message: text, messages: ai.history },
    });
    ai.history = res.messages;
    ai.usd += res.usage?.usd ?? 0;
    ai.log.pop(); // "חושב…"
    ai.log.push({ type: 'msg', role: 'bot', text: res.reply });
    // at — כדי לדעת אחרי רענון שההצעה כבר פגה בשרת (PROPOSAL_TTL_MS)
    for (const proposal of res.proposals ?? []) {
      ai.log.push({ type: 'proposal', proposal, at: Date.now() });
    }
  } catch (e) {
    ai.log.pop();
    ai.log.push({ type: 'msg', role: 'sys', text: `לא הצלחתי: ${e.message}` });
  } finally {
    ai.busy = false;
    $('#aiSend').disabled = false;
    renderAI();
    input.focus();
  }
}

async function confirmProposal(i) {
  const entry = ai.log[i];
  if (!entry || entry.state || proposalExpired(entry)) return;

  entry.state = 'running';
  renderAI();
  try {
    const res = await api('/assistant/confirm', {
      method: 'POST', body: { proposal_id: entry.proposal.id },
    });
    entry.state = 'done';
    // המודל צריך לדעת שזה קרה — בלי לשלם על סבב נוסף עכשיו
    ai.history.push({
      role: 'user',
      content: `[המשתמש אישר וההצעה בוצעה: ${res.summary}]`,
    });
    toast('בוצע.');
  } catch (e) {
    // החיבור פג: הבקשה נעצרה בשער ההתחברות, ההצעה לא נצרכה ועדיין תקפה.
    // הכרטיס חוזר לממתין, וחלון "החיבור פג" כבר פתוח — אחרי ההתחברות מאשרים שוב.
    if (e.status === 401) {
      delete entry.state;
      return;
    }
    // ההצעה נצרכה בשרת גם כשהביצוע נכשל — כפתור "אשר ובצע" שחוזר היה
    // מחזיר 410. הכישלון מוצג על הכרטיס עצמו, וניסיון נוסף = בקשה חדשה.
    entry.state = 'failed';
    entry.error = e.message;
    ai.history.push({
      role: 'user',
      content: `[הביצוע נכשל: ${e.message}. הסבר למשתמש ואל תנסה שוב בלי לתקן.]`,
    });
  } finally {
    renderAI();
  }
  // מחוץ ל-try: רענון שנכשל אחרי ביצוע מוצלח לא הופך אותו ל"נכשל"
  if (entry.state === 'done') {
    await refreshAfterAI().catch((e) => toast(`בוצע, אבל הרענון נכשל: ${e.message}`, true));
  }
}

/** אחרי פעולה שאושרה — לרענן את מה שמוצג מתחת לדיאלוג */
async function refreshAfterAI() {
  const [{ endpoints }, { channels }] = await Promise.all([
    api('/endpoints'), api('/channels'),
  ]);
  state.endpoints = endpoints;
  state.channels = channels;
  rebuildEpColors();
  await Promise.all([refreshCurrentTab(), refreshTaskBadge(), refreshAlerts()]);
}
