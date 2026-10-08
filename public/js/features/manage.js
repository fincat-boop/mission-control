import { api } from '../core/api.js';
import { can, rebuildEpColors, state } from '../core/state.js';
import { $, $$, copyText, esc, run, toast } from '../core/dom.js';
import { HE_DAYS, fmtDate, ymd } from '../core/format.js';
import { refreshBoard } from '../ui/refresh.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from '../ui/dialog.js';
import { multiSelectHtml, wireMultiSelects } from '../ui/multiSelect.js';
import { engineToast } from '../ui/engineDialog.js';
import { resetSetupStatus } from '../ui/setup.js';
import { urgentReserve } from '../core/reserve.js';
import { apiKeysItem, wireApiKeys } from '../ui/apiKeys.js';

/* ========================= ניהול ========================= */

export async function renderManage() {
  const [{ endpoints }, { channels }, { settings }, { users }, backupsRes, pub, apiKeysRes] = await Promise.all([
    api('/endpoints'), api('/channels'), api('/settings'), api('/users'),
    can('settings') ? api('/backups') : Promise.resolve(null),
    api('/publish/status'),
    // מפתחות API — בעלים בלבד (כמו בשרת)
    // תקלה בה לא מפילה את כל הטאב
    state.me?.is_owner ? api('/api-keys').catch(() => null) : Promise.resolve(null),
  ]);
  state.endpoints = endpoints;
  rebuildEpColors();
  state.channels = channels;
  state.users = users;
  state.autopublish = !!pub.autopublish_enabled;

  const ro = !can('settings'); // read-only
  const connOf = (id) => pub.connections.find((c) => c.channel_id === id) ?? null;

  const root = $('#manage');
  const restorePlace = keepPlace(root);
  root.innerHTML = `
    <div class="setgroup" data-section="endpoints">
      <h2>נקודות קצה</h2>
      <p class="sub">ההגדרות של כל נקודה — חשיבות. הקמפיינים והתוכן שלה בטאב "קמפיינים ותוכן".</p>
      <div class="panel">${endpoints.map((e) => endpointItem(e, channels, ro)).join('')
        || '<div class="empty">אין עדיין נקודות קצה.</div>'}</div>
      ${ro ? '' : '<div class="setadd"><button class="btn" id="addEndpoint">＋ הוסף נקודת קצה</button></div>'}
    </div>

    <div class="setgroup" data-section="channels">
      <h2>ערוצי פרסום</h2>
      <p class="sub">כמה פוסטים כל ערוץ מקבל, איך מפרסמים אליו ובאילו ימים הוא סגור.</p>
      <div class="autopub" data-section="autopublish">
        <label class="cbline">
          <input type="checkbox" id="autopubGlobal" ${pub.autopublish_enabled ? 'checked' : ''}
                 ${ro ? 'disabled' : ''}>
          <b>פרסום אוטומטי</b>
        </label>
        <div class="fhint">${pub.autopublish_enabled
          ? `דלוק — המתג הראשי של כל הפרסום האוטומטי. גם כשהוא דולק, שום פוסט לא מתפרסם בלי
             אישור של הפוסט עצמו ("אשר לפרסום אוטומטי" בחלון הפוסט).`
          : `כבוי — כל הפרסום ידני: המערכת יוצרת משימת "לפרסם היום", מפרסמים בעצמכם
             ומסמנים פורסם.`}
        </div>
      </div>
      <div class="panel">${channels.map((c) => channelItem(c, ro, connOf(c.id), pub.hub_mail_ready)).join('')
        || '<div class="empty">אין עדיין ערוצים.</div>'}</div>
      ${ro ? '' : '<div class="setadd"><button class="btn" id="addChannel">＋ הוסף ערוץ</button></div>'}
    </div>

    ${systemGroup(users, settings, backupsRes, ro, apiKeysRes)}`;

  restorePlace();
  wireManage(ro, pub.connections, apiKeysRes, pub);
}

/**
 * כל שמירה מציירת את המסך מחדש (innerHTML), וזה סגר כל <details> והקפיץ
 * את הגלילה — בחיבור למטא: בוחרים פלטפורמה ← הערוץ נסגר ← פותחים ←
 * שומרים ← נסגר שוב. לפני ההחלפה זוכרים מה פתוח (לפי data-open-id יציב)
 * ואיפה הגלילה, ואחריה מחזירים. מחזיר את פונקציית ההחזרה.
 */
function keepPlace(root) {
  const open = $$('details[open][data-open-id]', root).map((d) => d.dataset.openId);
  const y = window.scrollY;
  return () => {
    for (const id of open) {
      const d = root.querySelector(`details[data-open-id="${id}"]`);
      if (d) d.open = true;
    }
    if (!root.hidden) window.scrollTo(0, y);
  };
}

function endpointItem(e, channels, ro) {
  // הקמפיינים והתוכן עברו לטאב "קמפיינים ותוכן". כאן נשארו רק ההגדרות של הנקודה עצמה.
  const hasContent = e.content.length > 0;

  // שני מצבים נפרדים: פעילה/מושבתת לפי active, ויש/אין תוכן (נקודה + טקסט).
  // קודם תג אחד ערבב אותם — "פעילה" הופיע רק כשהיה תוכן.
  const contentCls = hasContent ? 'on' : e.active ? 'warn' : 'off';
  return `<details class="item" data-open-id="ep-${e.id}">
    <summary>
      <b>${esc(e.name)}</b>
      <span class="info">חשיבות ${e.importance} · ${e.campaigns.length} קמפיינים</span>
      <span class="sdot-line epcontent ${contentCls}"><i></i>${hasContent ? 'יש תוכן' : 'אין תוכן'}</span>
      <span class="chip epstate ${e.active ? 'on' : 'bad'}">${e.active ? 'פעילה' : 'מושבתת'}</span>
    </summary>
    <div class="ibody">
      <div class="prow">
        <label>חשיבות (1–10) — כמה שטח מגיע לה ולקמפיינים שלה</label>
        <input type="number" min="1" max="10" value="${e.importance}"
               data-ep-field="importance" data-id="${e.id}" ${ro ? 'disabled' : ''}>
      </div>
      <!-- שורת ההשלכה (סעיף 35): הנתח והקצב — מהשרת (POST /settings/consequences) -->
      <div class="fhint" data-conseq="ep-${e.id}">${esc(epConseq({
        importance: e.importance, cadence_days: e.effective_min_days }))}</div>

      <div class="subsec">
        <h4>סיכום</h4>
        <div class="contentline">${e.campaigns.length} קמפיינים · ${e.content.length} פריטי תוכן
          <span style="color:var(--muted)">— לניהול שלהם: הטאב "קמפיינים ותוכן"</span></div>
      </div>

      ${ro ? '' : `<div style="margin-top:14px">
        <button class="btn small" data-toggle-endpoint="${e.id}" data-active="${e.active}">
          ${e.active ? 'השבת נקודת קצה' : 'הפעל נקודת קצה'}</button>
        <button class="btn small danger" data-del-endpoint="${e.id}">מחק נקודת קצה</button>
      </div>`}
    </div>
  </details>`;
}


const readyIn = (c, channels) => {
  const names = (c.ready_channel_ids ?? [])
    .map((id) => channels.find((ch) => ch.id === id)?.name)
    .filter(Boolean);
  return names.length ? `— מוכן ל${names.join(', ')}` : '— עוד לא סומן לאף ערוץ';
};

const PLATFORMS = [
  ['manual',     'ידני — בלי אינטגרציה'],
  ['facebook',   'פייסבוק (עמוד)'],
  ['instagram',  'אינסטגרם (חשבון עסקי)'],
  ['whatsapp',   'וואטסאפ (קבוצה)'],
  ['newsletter', 'ניוזלטר'],
];

/**
 * בלוק "חיבור ופרסום" בפרטי הערוץ: פלטפורמה, ולפייסבוק/אינסטגרם גם
 * מזהה, טוקן ופרסום אוטומטי לערוץ — שלושתם נשמרים יחד ב"שמור חיבור"
 * (לא בכל שינוי, כמו הקיבולת), כדי שיהיה מודל שמירה אחד לבלוק.
 */
function connectionBlock(c, conn, ro, hubReady) {
  const platform = c.platform ?? 'manual';

  const select = `
    <div class="prow">
      <label for="chpf-${c.id}">פלטפורמה — קובעת איך מפרסמים לערוץ</label>
      <select id="chpf-${c.id}" data-ch-platform="${c.id}" ${ro ? 'disabled' : ''}>
        ${PLATFORMS.map(([v, l]) =>
          `<option value="${v}" ${platform === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>`;

  if (platform === 'whatsapp') {
    return `${select}<div class="fhint">לקבוצת וואטסאפ אין API רשמי — הפרסום חצי-אוטומטי:
      כשמגיע מועד הפוסט נוצרת משימה דחופה עם הטקסט מוכן להעתקה, ומסמנים "פורסם" אחרי השליחה.</div>`;
  }
  if (platform === 'newsletter') {
    const chip = hubReady
      ? '<span class="chip on">מחובר ל-HUB</span>'
      : '<span class="chip bad">לא מחובר</span>';
    return `${select}
      <div class="prow"><label>מערכת הדיוור (HUB)</label>${chip}</div>
      <div class="fhint">${!state.autopublish
        ? 'הפרסום האוטומטי כבוי — שולחים את הניוזלטר ב-HUB בעצמכם ומסמנים "פורסם". נושא וגוף נכתבים בעריכת הגרסה של ערוץ המייל בתוכן.'
        : hubReady
        ? 'הניוזלטר נשלח דרך ה-HUB: נושא, גוף ורשימות יעד נקבעים בעריכת הגרסה של ערוץ המייל בתוכן. פרסום רק אחרי אישור של כל פוסט.'
        : 'חסרים HUB_API_URL / HUB_API_KEY בשרת (Railway). עד אז אין פרסום אוטומטי לערוץ — אפשר לשבץ ולסמן "פורסם" ידנית.'}</div>`;
  }
  if (platform === 'manual') {
    return `${select}<div class="fhint">ידני = מפרסמים בעצמכם ומסמנים "פורסם" בפוסט.</div>`;
  }

  const isFb = platform === 'facebook';
  const status = !conn?.has_token
    ? '<span class="chip bad">לא מחובר</span>'
    : conn.last_check_ok === false
      ? '<span class="chip bad">בעיה בחיבור</span>'
      : conn.last_check_ok
        ? `<span class="chip on">מחובר${conn.auto_enabled && state.autopublish ? ' · פרסום אוטומטי פעיל' : ''}</span>`
        : '<span class="chip">נשמר, עוד לא נבדק</span>';

  return `${select}
    <div class="prow"><label>חיבור ל-Meta</label>${status}</div>
    ${conn?.last_check_note ? `<div class="fhint">בדיקה אחרונה: ${esc(conn.last_check_note)}</div>` : ''}
    <div class="prow">
      <label for="chid-${c.id}">${isFb ? 'מזהה העמוד (Page ID)' : 'מזהה חשבון אינסטגרם (IG User ID)'}</label>
      <input id="chid-${c.id}" type="text" dir="ltr" value="${esc((isFb ? conn?.page_id : conn?.ig_user_id) ?? '')}"
             data-conn-id-field="${c.id}" ${ro ? 'disabled' : ''}>
    </div>
    <div class="prow">
      <label for="chtok-${c.id}">Access Token (${isFb ? 'של העמוד; לתגובה ראשונה צריך גם pages_manage_engagement' : 'עם הרשאות instagram_content_publish; לתגובה ראשונה גם instagram_manage_comments'})</label>
      <input id="chtok-${c.id}" type="password" dir="ltr" data-conn-token="${c.id}"
             placeholder="${conn?.has_token ? 'שמור ✓ — מזינים רק כדי להחליף' : 'מדביקים כאן'}"
             ${ro ? 'disabled' : ''}>
    </div>
    ${state.autopublish ? `<div class="prow">
      <label class="cbline">
        <input type="checkbox" data-conn-auto="${c.id}"
               ${conn?.auto_enabled ? 'checked' : ''} ${ro ? 'disabled' : ''}>
        פרסום אוטומטי לערוץ הזה
      </label>
    </div>` : `<div class="fhint">החיבור משמש לתובנות. הפרסום האוטומטי כבוי לכל המערכת
      (המתג למעלה) — מפרסמים בעצמכם ומסמנים "פורסם".</div>`}
    ${ro ? '' : `<div class="btnrow">
      <button class="btn small primary" data-conn-save="${c.id}">שמור חיבור</button>
      ${conn?.has_token ? `<button class="btn small" data-conn-verify="${c.id}">בדוק חיבור</button>
      <button class="btn small danger" data-conn-del="${c.id}">נתק</button>` : ''}
    </div>`}`;
}

/**
 * פרטי ערוץ בשלושה בלוקים, כל אחד עם מודל שמירה אחד:
 * קיבולת וימים חסומים — נשמרים בכל שינוי; חיבור ופרסום — בכפתור.
 */
/** "שמור לדחופים: 1 בשבוע" — המספר שהאחוז נותן בפועל (urgentReserve, סעיף 7) */
/* ---------- שורות ההשלכה (סעיף 35) ---------- */

// המספרים מהשרת (src/consequences.js — capacity.js); כאן רק הניסוח
const daysHe = (n) => (n === 0 ? 'בלי מרווח' : n === 1 ? 'יום אחד' : `${n} ימים`);

/** נקודת קצה: הנתח בערוצים שלה השבוע והקצב. share_pct undefined — עוד לא נטען */
function epConseq(x) {
  const cadence = `פוסט כל ~${x.cadence_days} ימים`;
  if (x.share_pct === undefined) return `חשיבות ${x.importance} ← ${cadence}`;
  if (x.share_pct === null) return `חשיבות ${x.importance} ← אין לה קמפיין שרץ השבוע; ${cadence}`;
  const where = x.channels.length === 1 ? `ב${x.channels[0]}` : 'בערוצים שלה';
  return x.fixed
    ? `חשיבות ${x.importance} ← ${x.share_pct}% מהמקום ${where} השבוע (נתח קבוע), ${cadence}`
    : `חשיבות ${x.importance} ← בערך ${x.share_pct}% מהמקום של הקמפיינים ${where} השבוע, ${cadence}`;
}

/** ערוץ: כמה המנוע ממלא, השמורה, והמרווח שנגזר */
const chConseq = (x) => `← המנוע ממלא עד ${x.budget} בשבוע (שמור לדחופים ${x.reserve}) · ` +
  `מרווח ברירת מחדל: ${daysHe(x.gap_days)}`;

/** הערכים שבשדות עכשיו — לפני שמירה */
function conseqDraft() {
  const val = (el) => (el ? el.value.trim() : '');
  const endpoints = {};
  for (const inp of $$('#manage [data-ep-field="importance"]')) {
    if (val(inp) !== '') endpoints[inp.dataset.id] = Number(val(inp));
  }
  const channels = {};
  for (const ch of state.channels ?? []) {
    const f = (name) => $(`#manage [data-ch-field="${name}"][data-id="${ch.id}"]`);
    const max = val(f('max_per_week'));
    const pct = val(f('urgent_reserve_pct'));
    channels[ch.id] = {
      ...(max !== '' ? { max_per_week: Number(max) } : {}),
      urgent_reserve_pct: pct === '' ? null : Number(pct),
    };
  }
  const gap = val($('#manage [data-engine="min_gap_days"]'));
  const ratioOn = $('#engRatioOn')?.checked;
  return {
    endpoints, channels,
    settings: {
      ...(gap !== '' ? { min_gap_days: Number(gap) } : {}),
      ...(ratioOn == null ? {} : { min_value_per_promo: ratioOn ? Number(val($('#engRatioVal'))) || 3 : 0 }),
    },
  };
}

function paintConseq(c) {
  const set = (key, text) => {
    const el = $(`#manage [data-conseq="${key}"]`);
    if (el) el.textContent = text;
  };
  for (const e of c.endpoints) set(`ep-${e.id}`, epConseq(e));
  for (const ch of c.channels) set(`ch-${ch.id}`, chConseq(ch));
  const active = c.channels.filter((ch) => ch.active);
  set('gap', active.length
    ? `← בערוצים שלך בפועל: ${active.map((ch) => `${ch.name} ${daysHe(ch.gap_days)}`).join(' · ')}`
    : '');
  set('ratio', !c.ratio_on ? '← כבוי: אין מגבלה לפי יחס.'
    : active.length ? `← מכירתיים לכל היותר ב-${c.ratio_window_days} יום (ובשבוע): ${
      active.map((ch) => (ch.promo_28 == null ? `${ch.name} בלי מגבלה`
        : `${ch.name} ${ch.promo_28} (${ch.promo_week})`)).join(' · ')}` : '');
}

let conseqSeq = 0;
let conseqTimer = null;
/** מחשב מחדש את כל השורות מהערכים שבשדות; תשובה ישנה (הקלדה מהירה) נזרקת */
async function refreshConseq() {
  const seq = ++conseqSeq;
  const c = await api('/settings/consequences', { method: 'POST', body: conseqDraft() });
  if (seq === conseqSeq) paintConseq(c);
}
const scheduleConseq = () => {
  clearTimeout(conseqTimer);
  conseqTimer = setTimeout(() => refreshConseq().catch(() => {}), 250);
};

function reserveNote(max, pct) {
  const n = urgentReserve(max, pct);
  return `שמור לדחופים: ${n === 0 ? 'אף פוסט' : n === 1 ? 'פוסט אחד' : `${n} פוסטים`} בשבוע`;
}

/** שורת הסיכום של "מתקדם" בערוץ: רק מה שהוגדר בו, כדי שלא יהיה מוסתר בשקט */
function advSummary(c) {
  const bits = [
    c.max_promo_per_week != null && `עד ${c.max_promo_per_week} מכירתיים`,
    c.max_hybrid_per_week != null && `עד ${c.max_hybrid_per_week} משולבים`,
    c.max_value_per_week != null && `עד ${c.max_value_per_week} ערך`,
    // 20% היא ברירת המחדל — מוצגת רק כשמישהו שינה אותה
    c.urgent_reserve_pct != null && Number(c.urgent_reserve_pct) !== 20 && `${c.urgent_reserve_pct}% לדחופים`,
    c.efficiency != null && `עדיפות ${c.efficiency}`,
    c.default_hour != null && `בשעה ${String(c.default_hour).padStart(2, '0')}:00`,
  ].filter(Boolean);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

function channelItem(c, ro, conn, hubReady) {
  const num = (label, field, value, kind = '', max = '') => `
    <div class="prow">
      <label for="chf-${field}-${c.id}">${kind ? `<span class="kindsw k-${kind}"></span>` : ''}${label}</label>
      <input id="chf-${field}-${c.id}" type="number" min="0" ${max ? `max="${max}"` : ''}
             value="${value ?? ''}" placeholder="ללא"
             data-ch-field="${field}" data-id="${c.id}" ${ro ? 'disabled' : ''}>
    </div>`;

  return `<details class="item" data-open-id="ch-${c.id}">
    <summary>
      <b>${esc(c.name)}</b>
      <span class="info">${c.max_per_week} פוסטים בשבוע</span>
      <span class="chip ${c.active ? 'on' : 'bad'}">${c.active ? 'פעיל' : 'מושבת'}</span>
    </summary>
    <div class="ibody">
      <section class="chblock">
        <h4>קיבולת <span class="savenote">נשמר ביציאה מהשדה</span></h4>
        ${num('פוסטים בשבוע', 'max_per_week', c.max_per_week)}
        <div class="fhint">כמה פוסטים הערוץ מפרסם בשבוע. מזה נגזר גם כמה תוכן כל קמפיין צריך בערוץ.</div>
        <div class="fhint" data-conseq="ch-${c.id}"></div>
        <details class="adv">
          <summary>מתקדם${advSummary(c)}</summary>
          ${num('מתוכם מכירתיים — לכל היותר', 'max_promo_per_week', c.max_promo_per_week, 'promo')}
          ${num('מתוכם משולבים — לכל היותר', 'max_hybrid_per_week', c.max_hybrid_per_week, 'hybrid')}
          ${num('מתוכם ערך — לכל היותר', 'max_value_per_week', c.max_value_per_week, 'value')}
          ${num('שטח ששמור לפוסטים דחופים (%)', 'urgent_reserve_pct', c.urgent_reserve_pct)}
          <div class="fhint" data-reserve-note="${c.id}">${esc(reserveNote(c.max_per_week, c.urgent_reserve_pct))}</div>
          ${num('עדיפות ערוץ (1–10)', 'efficiency', c.efficiency, '', 10)}
          <div class="fhint">
            עדיפות ריקה = ניטרלי. היא מכריעה רק בין שני מועדים שקולים בשבוע — לא קובעת כמה
            מתפרסם. הביצועים הנמדדים לא משנים אותה.
          </div>
          <div class="prow">
            <label for="chf-default_hour-${c.id}">שעת פרסום רגילה</label>
            <select id="chf-default_hour-${c.id}" data-ch-field="default_hour" data-id="${c.id}"
                    ${ro ? 'disabled' : ''}>
              <option value="">10:00 (ברירת מחדל)</option>
              ${[...new Set([...(c.default_hour != null && c.default_hour < 6 ? [Number(c.default_hour)] : []),
                ...Array.from({ length: 17 }, (_, i) => i + 6)])].map((h) =>
                `<option value="${h}" ${Number(c.default_hour) === h && c.default_hour != null
                  ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
            </select>
          </div>
          <div class="fhint">
            השעה שבה המנוע משבץ פוסטים בערוץ, וברירת המחדל בהוספת פוסט ובמבצע דחוף. כשהשעה תפוסה
            באותו יום — השעה הפנויה הבאה.
          </div>
        </details>
      </section>

      <section class="chblock">
        <h4>חיבור ופרסום${['facebook', 'instagram'].includes(c.platform)
          ? ' <span class="savenote">נשמר בכפתור "שמור חיבור" · כיבוי הפרסום האוטומטי נשמר מיד</span>' : ''}</h4>
        ${connectionBlock(c, conn, ro, hubReady)}
      </section>

      <section class="chblock">
        <h4>ימים חסומים <span class="savenote">נשמר בכל סימון</span></h4>
        <div class="fhint">ימים שבהם הערוץ לא מקבל פוסטים. פוסט שכבר שובץ ביום שנחסם מוזז ליום פנוי.</div>
        <div class="blockdays">
          ${multiSelectHtml({ options: HE_DAYS.map((d, i) => [i, d]), value: c.blocked_days ?? [],
            attrs: () => `data-blocked="${c.id}"`, placeholder: 'אין ימים חסומים', disabled: ro })}
        </div>
      </section>

      ${ro ? '' : `<div class="btnrow chactions">
        <button class="btn small" data-toggle-channel="${c.id}" data-active="${c.active}">
          ${c.active ? 'השבת ערוץ' : 'הפעל ערוץ'}</button>
        <button class="btn small danger" data-del-channel="${c.id}">מחק ערוץ</button>
      </div>`}
    </div>
  </details>`;
}

// מה הרשאת approve פותחת בפועל: אישור לפרסום אוטומטי (גם מרוכז לשבוע) —
// רק כשהמתג דלוק,
// פרסום מיידי, ומבצע דחוף שנכנס ללוח בלי להמתין לאישור (routes/publish.js,
// routes/board.js, routes/engine.js)
// פרסום אוטומטי כבוי (state.autopublish) — אין מה לאשר לפרסום, רק מבצע דחוף
const approveHint = () => (state.autopublish
  ? 'אישור פוסטים לפרסום אוטומטי ופרסום מיידי לרשתות, וגם מבצע דחוף בלי המתנה לאישור'
  : 'מבצע דחוף שנכנס ללוח בלי המתנה לאישור (הפרסום האוטומטי כבוי — כל הפרסום ידני)');

/**
 * קבוצת "מערכת" — כל חלק לפי ההרשאה שהשרת דורש בפועל:
 * משתמשים ← users; כללי המנוע גלויים לכולם וניתנים לעריכה רק עם settings
 * (PATCH /settings), כמו ערוצים ונקודות קצה; גיבויים ← settings (GET /backups).
 */
function systemGroup(users, settings, backupsRes, ro, apiKeysRes) {
  const backups = backupsRes?.backups ?? null;
  const rows = users.map((u) => {
    const cell = (perm) => u.is_owner
      ? '✓'
      : `<input type="checkbox" data-user="${u.id}" data-perm="${perm}" ${u[`perm_${perm}`] ? 'checked' : ''}>`;
    return `<tr>
      <td><b>${esc(u.name)}</b> ${u.is_owner ? '<span class="owner-tag">בעלים</span>' : ''}
        <div style="color:var(--muted);font-size:11.5px">${esc(u.email)}</div></td>
      <td>${cell('content')}</td><td>${cell('settings')}</td>
      <td>${cell('approve')}</td><td>${cell('users')}</td>
      <td>${u.is_owner ? '' : `<button class="btn small danger" data-del-user="${u.id}">מחק</button>`}</td>
    </tr>`;
  }).join('');

  const s = settings;
  const dis = ro ? 'disabled' : '';
  const eng = (label, field, value, step = '1') => `
    <div class="prow"><label>${label}</label>
      <input type="number" step="${step}" value="${value}" data-engine="${field}" ${dis}></div>`;

  return `<div class="setgroup">
    <h2>מערכת</h2>
    <div class="panel">
      ${can('users') ? `<details class="item" data-open-id="users">
        <summary><b>משתמשים והרשאות</b>
          <span class="info">${users.length} משתמשים</span></summary>
        <div class="ibody">
          <div class="tablewrap"><table class="utable">
            <thead><tr><th>משתמש</th><th>תוכן ושיבוץ</th><th>הגדרות</th>
              <th title="${esc(approveHint())}">אישור פרסום</th><th>ניהול משתמשים</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div style="margin-top:10px"><button class="btn small primary" id="addUser">＋ הוסף משתמש</button></div>
        </div>
      </details>` : ''}
      ${apiKeysRes ? apiKeysItem(apiKeysRes) : ''}
      <details class="item" data-open-id="engine">
        <summary><b>מתקדם — כללי המנוע</b><span class="info">נוגעים בזה לעיתים רחוקות</span></summary>
        <div class="ibody">
          ${eng('ברירת מחדל: ימים בין שני פוסטים של אותה נקודת קצה באותו ערוץ — לכל היותר; בערוץ שיש בו מקום לכמה פוסטים בשבוע המרווח קטן יותר לבד. כל קמפיין יכול לקבוע משלו', 'min_gap_days', s.min_gap_days)}
          <div class="fhint enghint-row" data-conseq="gap"></div>
          ${eng('פוסטים מכירתיים ביום — לכל היותר, בכל הערוצים יחד', 'max_promo_per_day', s.max_promo_per_day)}
          <div class="prow">
            <label class="cbline">
              <input type="checkbox" id="engRatioOn" ${s.min_value_per_promo > 0 ? 'checked' : ''} ${dis}>
              לדרוש מספר פוסטי ערך על כל פוסט מכירתי
            </label>
            <input type="number" step="0.5" min="0.5" id="engRatioVal" aria-label="פוסטי ערך לכל מכירתי"
                   value="${s.min_value_per_promo > 0 ? s.min_value_per_promo : 3}"
                   data-engine="min_value_per_promo" ${s.min_value_per_promo > 0 && !ro ? '' : 'disabled'}>
          </div>
          <div class="fhint enghint-row">כשמסומן, כל ערוץ מקבל מכירתיים לפי היחס מתוך הפוסטים שלו בשבוע. משולב נספר לפי המשקל שלמטה.</div>
          <div class="fhint enghint-row" data-conseq="ratio"></div>
          ${eng('כמה פוסט "משולב" נחשב מכירתי (0–1)', 'hybrid_weight', s.hybrid_weight, '0.1')}
          <div class="fhint enghint-row">1 = נספר כמו מכירתי מלא, 0.5 = חצי מכירתי וחצי ערך, 0 = נספר כערך.</div>
          ${eng('התראה על פוסט חסר תוכן — כמה שעות לפני המועד', 'content_alert_hours', s.content_alert_hours)}
          <!-- סעיף 33: אין מתג — הביצועים משפיעים לבד. id נשאר ל"לכלל בניהול" בטאב נתונים -->
          <div class="fhint" id="engUsePerf" tabindex="-1">
            <b>ביצועים נמדדים</b> — משפיעים על נקודת קצה מ-5 תוצאות ומעלה ב-180 הימים האחרונים,
            עד ±15% מהחשיבות שלה. ערוצים, ימים ושעות רק מוצגים בטאב "נתונים" ולא משנים את השיבוץ.
          </div>
        </div>
      </details>
      ${backups ? backupsItem(backups, backupsRes.layers ?? []) : ''}
    </div>
  </div>`;
}

const whenHe = (d) => new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

/** שורת מצב לשכבת גיבוי אחת: נקודה + טקסט — הצליח מתי / נכשל ולמה / לא מוגדר */
function backupLayerLine(l) {
  let tone;
  let text;
  if (!l.configured || l.last_result === 'skipped') {
    tone = 'muted';
    text = 'לא מוגדר — ההגדרה אצל המפתח';
  } else if (!l.last_result) {
    tone = 'muted';
    text = 'עוד לא רץ מאז העלייה האחרונה';
  } else if (l.last_result === 'ok') {
    tone = 'good';
    text = `הצליח · ${whenHe(l.last_attempt_at)}`;
  } else {
    tone = 'crit';
    text = `נכשל · ${whenHe(l.last_attempt_at)}${l.last_error ? ` — ${l.last_error}` : ''}` +
      (l.last_success_at ? ` · הצלחה אחרונה ${whenHe(l.last_success_at)}` : '');
  }
  return `<div class="bkline"><span class="dot bk-${tone}"></span>
    <b>${esc(l.label)}</b><span>${esc(text)}</span></div>`;
}

function backupsItem(backups, layers) {
  const failed = layers.filter((l) => l.configured && l.last_result === 'failed').length;
  const info = failed
    ? `${failed === 1 ? 'שכבה אחת נכשלה' : `${failed} שכבות נכשלו`}`
    : backups.length ? `אחרון ${fmtDate(ymd(new Date(backups[0].created_at)))}` : 'עוד לא רץ גיבוי';
  return `<details class="item">
        <summary><b>גיבויים</b><span class="info${failed ? ' bk-warn' : ''}">${esc(info)}</span></summary>
        <div class="ibody">
          <p class="sub">המערכת מגבה את עצמה לבד פעם ביממה, לכמה מקומות. העותק בתוך המסד
            מאפשר לחזור אחורה אחרי מחיקה בטעות. העותקים בחוץ שומרים על הנתונים גם אם השרת
            עצמו נפגע — והגיבוי המלא הוא היחיד שכולל גם את הקבצים. שחזור נעשה על ידי המפתח.</p>
          <div class="bklayers">${layers.map(backupLayerLine).join('')}</div>
          ${backups.length ? `<details class="bkhist"><summary>העותקים בתוך המסד (${backups.length})</summary>
            <table class="utable"><thead><tr><th>מתי</th><th>שורות</th></tr></thead>
            <tbody>${backups.slice(0, 10).map((b) => `<tr>
              <td>${esc(new Date(b.created_at).toLocaleString('he-IL'))}</td>
              <td>${b.row_count}</td></tr>`).join('')}</tbody></table></details>` : ''}
        </div>
      </details>`;
}

/**
 * חלון בחירה עם כמה כפתורים — confirmDialog יודע רק כן/לא, וכאן צריך
 * שלוש: ביטול, מחיקה, והשבתה כברירה הבטוחה. נבנה ונהרס בכל פתיחה.
 * מחזיר את value של הכפתור שנלחץ, או null (ביטול / Esc).
 */
function choiceDialog(message, choices) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'choice-dlg';
    dlg.innerHTML = `<p class="choice-msg"></p><div class="dactions">${choices.map((c, i) =>
      `<button class="btn ${c.cls ?? ''}" data-choice="${i}">${esc(c.label)}</button>`).join('')}</div>`;
    dlg.querySelector('.choice-msg').textContent = message;
    let result = null;
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-choice]');
      if (!btn) return;
      result = choices[Number(btn.dataset.choice)].value;
      dlg.close();
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/* ---------- השבתה = החזקה (סעיף 16) ---------- */

const ENDPOINT_DISABLE_NOTE = 'השבתה לא מוחקת כלום: הפוסטים העתידיים שלה יורדים מהלוח ולא ' +
  'מתפרסמים, והקמפיינים שלה לא מקבלים שטח — עד שמפעילים אותה שוב.';
const CHANNEL_DISABLE_NOTE = 'השבתה לא מוחקת כלום: הפוסטים העתידיים בערוץ יורדים מהלוח ולא ' +
  'מתפרסמים — עד שמפעילים אותו שוב.';

const futurePosts = (n) => (n === 1 ? 'פוסט עתידי אחד' : `${n} פוסטים עתידיים`);

/**
 * שאלת ההשבתה: מה יוחזק (x.future_posts, מתוכם x.future_approved מאושרים).
 * whose — "שלה" / "בו"; extra — משפט נוסף לפני "שום דבר"; it — "אותה" / "אותו".
 */
function disableQuestion(what, x, whose, extra, it) {
  const n = x.future_posts ?? 0;
  const posts = n
    ? `${futurePosts(n)} ${whose} ${n === 1 ? 'יירד' : 'יירדו'} מהלוח ולא ${n === 1 ? 'יתפרסם' : 'יתפרסמו'}` +
      (x.future_approved ? ` (כולל ${x.future_approved} שאושרו לפרסום אוטומטי)` : '') +
      ` עד שתפעיל ${it} שוב.`
    : `אין ${whose} פוסטים עתידיים על הלוח.`;
  return `להשבית את ${what}?\n${posts}\n${extra}שום דבר לא נמחק.`;
}

const heldToast = (done, n) =>
  (n ? `${done} — ${futurePosts(n)} ${n === 1 ? 'ירד' : 'ירדו'} מהלוח עד שתפעיל שוב. שום דבר לא נמחק.`
     : `${done} — שום דבר לא נמחק.`);

/**
 * שאלת ההפעלה מחדש (releaseHeld בשרת): שום דבר לא נמחק — הפוסטים העתידיים
 * חוזרים ללוח במקומם, ומאושר שהמועד שלו עבר בזמן ההשבתה חוזר לאישור.
 */
function enableQuestion(what, x, whose) {
  const n = x.future_posts ?? 0;
  const m = x.missed_approved ?? 0;
  return `להפעיל מחדש את ${what}?\n` +
    (n ? `${futurePosts(n)} ${whose} ${n === 1 ? 'חוזר' : 'חוזרים'} ללוח, למקום ${n === 1 ? 'שלו' : 'שלהם'}.`
       : `אין ${whose} פוסטים עתידיים מוחזקים.`) +
    (m ? `\n${m === 1 ? 'פוסט מאושר אחד שהמועד שלו עבר חוזר'
      : `${m} פוסטים מאושרים שהמועד שלהם עבר חוזרים`} לאישור — ${m === 1 ? 'לא יתפרסם' : 'לא יתפרסמו'} לבד.` : '') +
    '\nשום דבר לא נמחק.';
}

const enabledToast = (done, res) =>
  `${done}.` +
  (res.back ? ` ${res.back === 1 ? 'פוסט אחד חזר' : `${res.back} פוסטים חזרו`} ללוח.` : '') +
  (res.approval_reset ? ` ${res.approval_reset === 1 ? 'מאושר אחד שהמועד שלו עבר חזר'
    : `${res.approval_reset} מאושרים שהמועד שלהם עבר חזרו`} לאישור.` : '');

/**
 * מחיקה של ערוץ / נקודת קצה. כשיש מה לאבד והישות פעילה — השבתה היא
 * הכפתור הראשי, ומחיקה היא בחירה שנייה ומפורשת. אחרת — אישור מחיקה רגיל.
 * מחזיר 'disable' / 'delete' / null.
 */
async function deleteOrDisable(message, offerDisable, disableNote, deleteLabel) {
  if (!offerDisable) {
    return (await confirmDialog(message, { danger: true, okLabel: deleteLabel })) ? 'delete' : null;
  }
  return choiceDialog(`${message}\n\n${disableNote}`, [
    { label: 'ביטול', value: null },
    { label: 'מחק לצמיתות', value: 'delete', cls: 'danger' },
    { label: 'השבת במקום למחוק', value: 'disable', cls: 'primary' },
  ]);
}

/**
 * משתמש חדש לא מקבל הזמנה מהמערכת — מי שהוסיף אותו צריך להגיד לו איך
 * נכנסים. הכתובת היא של האתר הנוכחי, והכניסה רק עם Google במייל שנרשם.
 */
async function teammateAdded(u) {
  const howTo = (url, email) => `כדי להיכנס: נכנסים ל-${url} ומתחברים עם Google עם ${email}.`;
  // בתצוגה — בידוד כיווני סביב הכתובת והמייל, שלא יתהפכו בתוך משפט בעברית
  const iso = (t) => `\u2068${t}\u2069`;
  const choice = await choiceDialog(`${u.name} נוסף.\n${howTo(iso(location.origin), iso(u.email))}`, [
    { label: 'סגור', value: null },
    { label: 'העתק הוראות', value: 'copy', cls: 'primary' },
  ]);
  if (choice !== 'copy') return;
  await copyText(`Mission Control — ${howTo(location.origin, u.email)}`);
  toast(`ההוראות הועתקו — אפשר להדביק ל${u.name}.`);
}

function wireManage(ro, connections, apiKeysRes, pubStatus) {
  wireMultiSelects($('#manage'));
  const reload = run(async () => { await renderManage(); await refreshBoard(); });
  if (apiKeysRes) wireApiKeys(apiKeysRes, run(renderManage));

  // חסימת יום מפנה את מי שכבר יושב עליו. מי שלא נמצא לו יום חוקי נשאר על
  // היום החסום — וזה חייב להיאמר כאן ולא רק בהתראות.
  const blockedToast = (base, res) => {
    const r = res.relocated;
    if (!r) return base;
    const moved = r.moved ? ` הוזזו ${r.moved} פוסטים מהימים שנחסמו.` : '';
    const stuck = r.stuck?.length
      ? ` ⚠ ${r.stuck.length} פוסטים נשארו על יום חסום (אין להם יום פנוי) — צריך להזיז ידנית.`
      : '';
    return base + moved + stuck;
  };

  // עריכת שדה בשדה — נשמר ביציאה מהשדה
  $$('#manage [data-ep-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { [inp.dataset.epField]: Number(inp.value), week: state.week } });
      engineToast(res, 'נשמר.');
      await refreshBoard();
    })));

  // שורות ההשלכה (סעיף 35): מתעדכנות תוך כדי הקלדה, לפני השמירה
  $$(['#manage [data-ep-field="importance"]', '#manage [data-ch-field="max_per_week"]',
      '#manage [data-ch-field="urgent_reserve_pct"]', '#manage [data-engine="min_gap_days"]',
      '#engRatioVal'].join(', '))
    .forEach((inp) => inp.addEventListener('input', scheduleConseq));
  $('#engRatioOn')?.addEventListener('change', scheduleConseq);
  refreshConseq().catch(() => {});

  // המספר שהאחוז לדחופים נותן מתעדכן תוך כדי הקלדה (לפני השמירה ביציאה)
  $$('#manage [data-ch-field="max_per_week"], #manage [data-ch-field="urgent_reserve_pct"]')
    .forEach((inp) => inp.addEventListener('input', () => {
      const id = inp.dataset.id;
      const note = $(`#manage [data-reserve-note="${id}"]`);
      if (!note) return;
      const val = (f) => $(`#manage [data-ch-field="${f}"][data-id="${id}"]`)?.value.trim();
      const pct = val('urgent_reserve_pct');
      note.textContent = reserveNote(val('max_per_week'), pct === '' ? null : pct);
    }));

  $$('#manage [data-ch-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const raw = inp.value.trim();
      const res = await api(`/channels/${inp.dataset.id}`,
        { method: 'PATCH',
          body: { [inp.dataset.chField]: raw === '' ? null : Number(raw), week: state.week } });
      engineToast(res, 'נשמר.');
      await refreshBoard();
    })));

  /* ---------- פרסום אוטומטי ---------- */

  // כיבוי = הכול ידני מעכשיו: מאושרים ונכשלים חוזרים למתוכנן בשרת
  // (resetToManual) — אומרים כמה לפני, ומחכים לאישור
  $('#autopubGlobal')?.addEventListener('change', run(async (e) => {
    const on = e.target.checked;
    if (!on) {
      const { approved = 0, failed = 0 } = pubStatus.manual_reset ?? {};
      const back = [
        approved === 1 ? 'פוסט אחד שאושר לפרסום אוטומטי' : approved ? `${approved} פוסטים שאושרו לפרסום אוטומטי` : '',
        failed === 1 ? 'פוסט אחד שהפרסום שלו נכשל' : failed ? `${failed} פוסטים שהפרסום שלהם נכשל` : '',
      ].filter(Boolean).join(' ו');
      const ok = await confirmDialog(
        'לכבות את הפרסום האוטומטי? מעכשיו כל הפרסום ידני: המערכת יוצרת משימת "לפרסם היום", ' +
        'מפרסמים בעצמכם ומסמנים פורסם.' +
        (back ? `\n${back} — ${approved + failed === 1 ? 'יחזור' : 'יחזרו'} למתוכנן.` : ''),
        { okLabel: 'כבה פרסום אוטומטי' });
      if (!ok) {
        e.target.checked = true;
        return;
      }
    }
    let res;
    try {
      res = await api('/settings', { method: 'PATCH', body: { autopublish_enabled: on } });
    } catch (err) {
      e.target.checked = !on;   // לא נשמר בשרת — התיבה לא משקרת
      throw err;
    }
    state.autopublish = on;
    const n = (res.manual_reset?.approved ?? 0) + (res.manual_reset?.failed ?? 0);
    toast(on
      ? 'הפרסום האוטומטי פעיל — יתפרסמו רק פוסטים שאושרו אחד-אחד.'
      : `הפרסום האוטומטי כבוי — כל הפרסום ידני.${n ? ` ${n} פוסטים חזרו למתוכנן.` : ''}`);
    await reload();   // תיבות האוטומטי לכל ערוץ, הלוח וכפתור "אשר את השבוע"
  }));

  // אחרי שינוי פלטפורמה הערוץ נשאר פתוח (keepPlace), והפוקוס עובר לשדה
  // הבא במסלול: הטוקן בפייסבוק/אינסטגרם, אחרת חזרה לבחירה עצמה
  $$('#manage [data-ch-platform]').forEach((sel) =>
    sel.addEventListener('change', run(async () => {
      const id = sel.dataset.chPlatform;
      await api(`/channels/${id}`,
        { method: 'PATCH', body: { platform: sel.value, week: state.week } });
      toast('הפלטפורמה עודכנה.');
      await reload();
      ($(`#manage [data-conn-token="${id}"]`) ?? $(`#manage [data-ch-platform="${id}"]`))
        ?.focus();
    })));

  const connBody = (id) => {
    const b = {};
    const idField = $(`[data-conn-id-field="${id}"]`)?.value.trim();
    const ch = state.channels.find((c) => c.id === Number(id));
    if (idField != null) b[ch?.platform === 'instagram' ? 'ig_user_id' : 'page_id'] = idField;
    const token = $(`[data-conn-token="${id}"]`)?.value.trim();
    if (token) b.access_token = token;   // ריק = לא נוגעים בטוקן השמור
    // הפרסום האוטומטי כבוי — התיבה לא מוצגת, והשמירה לא נוגעת בערך השמור
    const auto = $(`[data-conn-auto="${id}"]`);
    if (auto) b.auto_enabled = auto.checked;
    return b;
  };

  // יש שינוי שלא נשמר בבלוק החיבור — הכפתור מסומן "שמור חיבור •"
  const markConnDirty = (id) => {
    const btn = $(`#manage [data-conn-save="${id}"]`);
    if (!btn) return;
    const saved = connections.find((c) => c.channel_id === Number(id));
    const idInput = $(`#manage [data-conn-id-field="${id}"]`);
    const dirty = (idInput && idInput.value.trim() !== idInput.defaultValue.trim())
      || !!$(`#manage [data-conn-token="${id}"]`)?.value.trim()
      || ($(`#manage [data-conn-auto="${id}"]`)?.checked ?? !!saved?.auto_enabled) !== !!saved?.auto_enabled;
    btn.classList.toggle('dirty', dirty);
    btn.textContent = dirty ? 'שמור חיבור •' : 'שמור חיבור';
  };
  $$('#manage [data-conn-id-field], #manage [data-conn-token]').forEach((inp) =>
    inp.addEventListener('input', () =>
      markConnDirty(inp.dataset.connIdField ?? inp.dataset.connToken)));

  // כיבוי פרסום אוטומטי לערוץ = פעולת בטיחות: נשמר מיד, בלי לחכות לכפתור.
  // הדלקה נשארת חלק מ"שמור חיבור" (ודורשת חיבור שנבדק).
  $$('#manage [data-conn-auto]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      const id = cb.dataset.connAuto;
      const saved = connections.find((c) => c.channel_id === Number(id));
      if (!cb.checked && saved?.auto_enabled) {
        try {
          await api(`/channels/${id}/connection`,
            { method: 'PUT', body: { auto_enabled: false } });
        } catch (e) {
          cb.checked = true;   // לא כובה בשרת — התיבה לא משקרת
          throw e;
        }
        saved.auto_enabled = false;
        toast('הפרסום האוטומטי כובה לערוץ.');
      }
      markConnDirty(id);
    })));

  // מזהה, טוקן ופרסום אוטומטי לערוץ — נשמרים יחד, רק בכפתור. אחרי השמירה
  // הפוקוס עובר ל"בדוק חיבור", הצעד הבא.
  // הדלקת פרסום אוטומטי רק על חיבור שנבדק ועבר — וטוקן חדש עוד לא נבדק.
  // השרת אוכף את אותו כלל (autoEnableBlocker ב-routes/publish.js).
  $$('#manage [data-conn-save]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      const id = btn.dataset.connSave;
      const body = connBody(id);
      const saved = connections.find((c) => c.channel_id === Number(id));
      if (body.auto_enabled && (body.access_token || saved?.last_check_ok !== true)) {
        ($(`#manage [data-conn-verify="${id}"]`) ?? $(`#manage [data-conn-token="${id}"]`))?.focus();
        throw new Error('בודקים חיבור לפני שמדליקים פרסום אוטומטי — שומרים בלי הסימון, ' +
          'לוחצים "בדוק חיבור", ואז מסמנים ושומרים.');
      }
      const { connection } = await api(`/channels/${id}/connection`, { method: 'PUT', body });
      toast(body.access_token && saved?.auto_enabled && !connection.auto_enabled
        ? 'החיבור נשמר, והפרסום האוטומטי כובה עד שהטוקן החדש ייבדק — לוחצים "בדוק חיבור" ומדליקים מחדש.'
        : 'החיבור נשמר. כדאי ללחוץ "בדוק חיבור" כדי לוודא שהוא עובד.');
      await reload();
      $(`#manage [data-conn-verify="${id}"]`)?.focus();
    })));

  $$('#manage [data-conn-verify]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      btn.disabled = true;
      btn.textContent = 'בודק…';
      try {
        const { ok, note } = await api(`/channels/${btn.dataset.connVerify}/connection/verify`,
          { method: 'POST' });
        toast(ok ? `החיבור תקין ✓ ${note}` : `החיבור לא עובד: ${note}`, !ok);
      } finally {
        await reload();
      }
    })));

  $$('#manage [data-conn-del]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      if (!(await confirmDialog('לנתק את הערוץ? הטוקן יימחק ותצטרך להזין אותו מחדש כדי לחבר.', { okLabel: 'נתק', danger: true }))) return;
      await api(`/channels/${btn.dataset.connDel}/connection`, { method: 'DELETE' });
      toast('הערוץ נותק.');
      await reload();
    })));

  // הימים החסומים נשמרים כקבוצה, כי הם מערך אחד ולא שדה בודד
  $$('#manage [data-blocked]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      const id = cb.dataset.blocked;
      const days = $$(`[data-blocked="${id}"]:checked`).map((i) => Number(i.value));
      const res = await api(`/channels/${id}`,
        { method: 'PATCH', body: { blocked_days: days, week: state.week } });
      engineToast(res, blockedToast(
        days.length ? `נחסמו ימי ${days.map((d) => HE_DAYS[d]).join(', ')}.` : 'כל הימים פתוחים.',
        res));
      await refreshBoard();
    })));

  $$('#manage [data-engine]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api('/settings',
        { method: 'PATCH', body: { [inp.dataset.engine]: Number(inp.value), week: state.week } });
      engineToast(res, 'נשמר.');
      await refreshBoard();
    })));

  // יחס ערך/מכירתי אופציונלי — 0 אומר למנוע לא לאכוף אותו בכלל
  $('#engRatioOn')?.addEventListener('change', run(async (e) => {
    const numInput = $('#engRatioVal');
    const enforcing = e.target.checked;
    numInput.disabled = !enforcing;
    const value = enforcing ? (Number(numInput.value) || 3) : 0;
    const res = await api('/settings',
      { method: 'PATCH', body: { min_value_per_promo: value, week: state.week } });
    engineToast(res, enforcing ? 'נשמר — היחס נאכף שוב.' : 'נשמר — היחס לא נאכף יותר.');
    await refreshBoard();
  }));

  $$('#manage [data-user][data-perm]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      await api(`/users/${cb.dataset.user}`,
        { method: 'PATCH', body: { [`perm_${cb.dataset.perm}`]: cb.checked } });
      toast('ההרשאה עודכנה.');
    })));

  $$('#manage [data-del-user]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!(await confirmDialog('למחוק את המשתמש?', { okLabel: 'מחק', danger: true }))) return;
      await api(`/users/${b.dataset.delUser}`, { method: 'DELETE' });
      await reload();
    })));

  // מחיקה מציגה קודם מה בדיוק נמחק, ומציעה השבתה כברירה הבטוחה
  $$('#manage [data-del-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const id = b.dataset.delEndpoint;
      const { impact: x } = await api(`/endpoints/${id}/delete-impact`);
      const lost = x.campaigns || x.content;
      const msg = `למחוק את נקודת הקצה "${x.name}"?\n` +
        (lost ? `${x.campaigns} קמפיינים ו־${x.content} פריטי תוכן יימחקו איתה לצמיתות.`
              : 'אין לה קמפיינים או תוכן.') +
        (x.future_posts ? `\n${futurePosts(x.future_posts)} שלה ${
          x.future_posts === 1 ? 'שלא פורסם יימחק' : 'שלא פורסמו יימחקו'} מהלוח.` : '') +
        // נקודה מושבתת: מה שהגיע מועדו בזמן ההשבתה הוחזק ולא יצא — נמחק איתה
        (x.held_past ? `\n${x.held_past === 1
          ? 'פוסט אחד שהמועד שלו הגיע בזמן שהנקודה מושבתת לא יצא, ויימחק'
          : `${x.held_past} פוסטים שהמועד שלהם הגיע בזמן שהנקודה מושבתת לא יצאו, ויימחקו`}.` : '') +
        (x.past_open ? `\n${x.past_open === 1
          ? `פוסט אחד שהמועד שלו עבר${x.active ? '' : ' לפני ההשבתה'} ולא סומן נשאר`
          : `${x.past_open} פוסטים שהמועד שלהם עבר${x.active ? '' : ' לפני ההשבתה'} ולא סומנו נשארים`} ` +
          `בלי נקודת קצה ובלי תוכן${x.active ? '' : ' — מאושר ביניהם חוזר לאישור ולא יתפרסם לבד'}.` : '') +
        (x.published ? `\n${x.published === 1 ? 'פוסט אחד שפורסם נשאר'
          : `${x.published} פוסטים שפורסמו נשארים`} בהיסטוריה.` : '');
      const choice = await deleteOrDisable(msg, x.active && (lost || x.posts),
        ENDPOINT_DISABLE_NOTE, 'מחק נקודת קצה');
      if (choice === 'disable') {
        await api(`/endpoints/${id}`, { method: 'PATCH', body: { active: false, week: state.week } });
        toast(heldToast('נקודת הקצה הושבתה', x.future_posts));
      } else if (choice === 'delete') {
        const res = await api(`/endpoints/${id}?force=1`, { method: 'DELETE', body: { week: state.week } });
        toast(res.removed_posts
          ? `נקודת הקצה נמחקה, ואיתה ${res.removed_posts === 1 ? 'פוסט אחד שלא פורסם'
            : `${res.removed_posts} פוסטים שלא פורסמו`}.`
          : 'נקודת הקצה נמחקה.');
      } else return;
      resetSetupStatus();   // צעד חובה בהקמה יכול לסגת — הלוח שואל שוב
      await reload();
    })));

  $$('#manage [data-del-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const id = b.dataset.delChannel;
      const { impact: x } = await api(`/channels/${id}/delete-impact`);
      const msg = `למחוק את הערוץ "${x.name}"?\n` +
        (x.published
          ? `${x.published} פוסטים שכבר פורסמו בו${x.results ? ` ו־${x.results} רשומות תוצאות` : ''} יימחקו לצמיתות — כולל ההיסטוריה בטאב "נתונים".`
          : 'אין בו פוסטים שפורסמו.') +
        (x.other ? `\n${x.other} פוסטים מתוכננים בו יימחקו מהלוח.` : '') +
        (x.variants ? `\n${x.variants} ניסוחים שנכתבו לערוץ הזה יימחקו.` : '');
      const choice = await deleteOrDisable(msg, x.active && (x.published || x.other || x.variants),
        CHANNEL_DISABLE_NOTE, 'מחק ערוץ');
      if (choice === 'disable') {
        await api(`/channels/${id}`, { method: 'PATCH', body: { active: false, week: state.week } });
        toast(heldToast('הערוץ הושבת', x.future_posts));
      } else if (choice === 'delete') {
        await api(`/channels/${id}?force=1`, { method: 'DELETE', body: { week: state.week } });
        toast('הערוץ נמחק.');
      } else return;
      resetSetupStatus();   // צעד חובה בהקמה יכול לסגת — הלוח שואל שוב
      await reload();
    })));

  // השבתה = כמו השהיית קמפיין (סעיף 16): האישור אומר כמה פוסטים יוחזקו.
  // הפעלה (releaseHeld בשרת): שום דבר לא נמחק — האישור אומר כמה פוסטים חוזרים
  // ללוח וכמה מאושרים שהמועד שלהם עבר חוזרים לאישור
  $$('#manage [data-toggle-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const id = b.dataset.toggleEndpoint;
      const disabling = b.dataset.active === 'true';
      const { impact: x } = await api(`/endpoints/${id}/delete-impact`);
      const held = x.future_posts;
      if (!(await confirmDialog(disabling
        ? disableQuestion(`נקודת הקצה "${x.name}"`, x, 'שלה', 'הקמפיינים שלה לא יקבלו שטח בזמן הזה. ', 'אותה')
        : enableQuestion(`נקודת הקצה "${x.name}"`, x, 'שלה'),
      { okLabel: disabling ? 'השבת נקודת קצה' : 'הפעל נקודת קצה' }))) return;
      const res = await api(`/endpoints/${id}`,
        { method: 'PATCH', body: { active: !disabling, week: state.week } });
      if (disabling) {
        resetSetupStatus();   // הושבת — ההקמה יכולה לסגת
        toast(heldToast('נקודת הקצה הושבתה', held));
      } else engineToast(res, enabledToast('נקודת הקצה הופעלה', res));
      await reload();
    })));

  $$('#manage [data-toggle-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      const id = b.dataset.toggleChannel;
      const disabling = b.dataset.active === 'true';
      const { impact: x } = await api(`/channels/${id}/delete-impact`);
      const held = x.future_posts;
      if (!(await confirmDialog(disabling
        ? disableQuestion(`הערוץ "${x.name}"`, x, 'בו', '', 'אותו')
        : enableQuestion(`הערוץ "${x.name}"`, x, 'בו'),
      { okLabel: disabling ? 'השבת ערוץ' : 'הפעל ערוץ' }))) return;
      const res = await api(`/channels/${id}`,
        { method: 'PATCH', body: { active: !disabling, week: state.week } });
      if (disabling) {
        resetSetupStatus();   // הושבת — ההקמה יכולה לסגת
        toast(heldToast('הערוץ הושבת', held));
      } else engineToast(res, enabledToast('הערוץ הופעל', res));
      await reload();
    })));

  if (!ro) {
    $('#addEndpoint')?.addEventListener('click', () => openGeneric({
      title: 'נקודת קצה חדשה',
      fields: [
        { name: 'name', label: 'שם', type: 'text' },
        { name: 'importance', label: 'חשיבות (1–10) — כמה שטח מגיע לה ולקמפיינים שלה',
          type: 'number', value: 5 },
      ],
      onSave: async (v) => {
        v.week = state.week;
        await api('/endpoints', { method: 'POST', body: v });
        await reload();
      },
    }));

    $('#addChannel')?.addEventListener('click', () => openGeneric({
      title: 'ערוץ חדש',
      fields: [
        { name: 'name', label: 'שם הערוץ', type: 'text' },
        { name: 'max_per_week', label: 'פוסטים בשבוע', type: 'number', value: 5 },
      ],
      onSave: async (v) => {
        v.week = state.week;
        await api('/channels', { method: 'POST', body: v });
        await reload();
      },
    }));
  }

  $('#addUser')?.addEventListener('click', () => openGeneric({
    title: 'משתמש חדש',
    fields: [
      { name: 'name', label: 'שם', type: 'text' },
      { name: 'email', label: 'אימייל (חשבון Google — איתו הוא נכנס)', type: 'email' },
      { name: 'perm_content', label: 'תוכן ושיבוץ', type: 'checkbox', value: true },
      { name: 'perm_settings', label: 'הגדרות', type: 'checkbox' },
      { name: 'perm_approve', label: `אישור פרסום — ${approveHint()}`, type: 'checkbox' },
      { name: 'perm_users', label: 'ניהול משתמשים', type: 'checkbox' },
    ],
    onSave: async (v) => {
      const { user } = await api('/users', { method: 'POST', body: v });
      await reload();
      // אחרי שחלון הטופס נסגר — במקום "נשמר." מה המשתמש החדש צריך לעשות
      setTimeout(run(() => teammateAdded(user)));
      return false;
    },
  }));
}
