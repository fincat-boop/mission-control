import { api } from '../core/api.js';
import { can, rebuildEpColors, state } from '../core/state.js';
import { $, $$, copyText, esc, run, toast } from '../core/dom.js';
import { HE_DAYS, fmtDate, ymd } from '../core/format.js';
import { refreshBoard } from '../ui/refresh.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from '../ui/dialog.js';
import { engineToast } from '../ui/engineDialog.js';
import { resetSetupStatus } from '../ui/setup.js';

/* ========================= ניהול ========================= */

export async function renderManage() {
  const [{ endpoints }, { channels }, { settings }, { users }, backupsRes, pub] = await Promise.all([
    api('/endpoints'), api('/channels'), api('/settings'), api('/users'),
    can('settings') ? api('/backups') : Promise.resolve(null),
    api('/publish/status'),
  ]);
  state.endpoints = endpoints;
  rebuildEpColors();
  state.channels = channels;
  state.users = users;

  const ro = !can('settings'); // read-only
  const connOf = (id) => pub.connections.find((c) => c.channel_id === id) ?? null;

  const root = $('#manage');
  const restorePlace = keepPlace(root);
  root.innerHTML = `
    <div class="setgroup" data-section="endpoints">
      <h2>נקודות קצה</h2>
      <p class="sub">ההגדרות של כל נקודה — חשיבות ותדירות. הקמפיינים והתוכן שלה בטאב "קמפיינים ותוכן".</p>
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
          <b>פרסום אוטומטי פעיל</b>
        </label>
        <div class="fhint">
          המתג הראשי של כל הפרסום האוטומטי. גם כשהוא דולק — שום פוסט לא מתפרסם בלי
          אישור של הפוסט עצמו ("אשר לשליחה אוטומטית" בחלון הפוסט).
        </div>
      </div>
      <div class="panel">${channels.map((c) => channelItem(c, ro, connOf(c.id), pub.hub_mail_ready)).join('')
        || '<div class="empty">אין עדיין ערוצים.</div>'}</div>
      ${ro ? '' : '<div class="setadd"><button class="btn" id="addChannel">＋ הוסף ערוץ</button></div>'}
    </div>

    ${systemGroup(users, settings, backupsRes, ro)}`;

  restorePlace();
  wireManage(ro, pub.connections);
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
        <label>חשיבות (1–10) — כמה שטח מגיע לה</label>
        <input type="number" min="1" max="10" value="${e.importance}"
               data-ep-field="importance" data-id="${e.id}" ${ro ? 'disabled' : ''}>
      </div>
      <div class="prow">
        <label>תדירות (פעם ב־X ימים)</label>
        <div class="autofield">
          <label class="opt"><input type="radio" name="cadence-${e.id}" value="auto"
                 data-ep-cadence-mode="${e.id}" ${e.min_days_between == null ? 'checked' : ''}
                 ${ro ? 'disabled' : ''}>
            אוטומטי<b>${e.effective_min_days}</b></label>
          <label class="opt"><input type="radio" name="cadence-${e.id}" value="manual"
                 data-ep-cadence-mode="${e.id}" ${e.min_days_between != null ? 'checked' : ''}
                 ${ro ? 'disabled' : ''}>
            קבוע</label>
          <input type="number" min="1" value="${e.min_days_between ?? ''}"
                 data-ep-cadence-input="${e.id}" data-id="${e.id}"
                 ${e.min_days_between == null ? 'disabled' : ''} ${ro ? 'disabled' : ''}>
        </div>
        <div class="fhint">אוטומטי מחשב את התדירות לפי החשיבות — חשיבות גבוהה יותר, פוסטים תכופים יותר.
          קבוע נועד למקרה שיש צורך בתדירות מסוימת, בלי קשר לחשיבות.</div>
      </div>

      <div class="subsec">
        <h4>סיכום</h4>
        <div class="contentline">${e.campaigns.length} קמפיינים · ${e.content.length} פריטי תוכן
          <span style="color:var(--muted)">— לניהול שלהם: הטאב "קמפיינים ותוכן"</span></div>
      </div>

      ${ro ? '' : `<div style="margin-top:14px">
        <button class="btn small" data-toggle-endpoint="${e.id}" data-active="${e.active}">
          ${e.active ? 'השבת נקודת קצה' : 'הפעל נקודת קצה'}</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-endpoint="${e.id}">מחק נקודת קצה</button>
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
      <div class="fhint">${hubReady
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
        ? `<span class="chip on">מחובר${conn.auto_enabled ? ' · פרסום אוטומטי פעיל' : ''}</span>`
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
      <label for="chtok-${c.id}">Access Token (${isFb ? 'של העמוד' : 'עם הרשאות instagram_content_publish'})</label>
      <input id="chtok-${c.id}" type="password" dir="ltr" data-conn-token="${c.id}"
             placeholder="${conn?.has_token ? 'שמור ✓ — מזינים רק כדי להחליף' : 'מדביקים כאן'}"
             ${ro ? 'disabled' : ''}>
    </div>
    <div class="prow">
      <label class="cbline">
        <input type="checkbox" data-conn-auto="${c.id}"
               ${conn?.auto_enabled ? 'checked' : ''} ${ro ? 'disabled' : ''}>
        פרסום אוטומטי לערוץ הזה
      </label>
    </div>
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
      <span class="info">${Number(c.target_per_week ?? c.max_per_week)} פוסטים בשבוע · תקרה ${c.max_per_week}</span>
      <span class="chip ${c.active ? 'on' : 'bad'}">${c.active ? 'פעיל' : 'מושבת'}</span>
    </summary>
    <div class="ibody">
      <section class="chblock">
        <h4>קיבולת <span class="savenote">נשמר ביציאה מהשדה</span></h4>
        ${num('פוסטים בשבוע — ממנו נגזר כמה מגיע לכל קמפיין', 'target_per_week', c.target_per_week)}
        ${num('תקרה — מקסימום פוסטים בשבוע', 'max_per_week', c.max_per_week)}
        ${num('מתוכם מכירתיים — לכל היותר', 'max_promo_per_week', c.max_promo_per_week, 'promo')}
        ${num('מתוכם משולבים — לכל היותר', 'max_hybrid_per_week', c.max_hybrid_per_week, 'hybrid')}
        ${num('מתוכם ערך — לכל היותר', 'max_value_per_week', c.max_value_per_week, 'value')}
        ${num('שטח ששמור לפוסטים דחופים (%)', 'urgent_reserve_pct', c.urgent_reserve_pct)}
        ${num('עדיפות ערוץ (1–10) — אופציונלי', 'efficiency', c.efficiency, '', 10)}
        <div class="fhint">
          ריק = ניטרלי. כשמוגדרת, המנוע ממלא קודם ערוצים בעדיפות גבוהה יותר, כדי שתוכן חשוב
          יגיע קודם לערוץ הכי טוב. כשהביצועים הנמדדים משפיעים על השיבוץ (כללי המנוע), המדידה
          מחליפה אותה.
        </div>
      </section>

      <section class="chblock">
        <h4>חיבור ופרסום${['facebook', 'instagram'].includes(c.platform)
          ? ' <span class="savenote">נשמר בכפתור "שמור חיבור" · כיבוי הפרסום האוטומטי נשמר מיד</span>' : ''}</h4>
        ${connectionBlock(c, conn, ro, hubReady)}
      </section>

      <section class="chblock">
        <h4>ימים חסומים <span class="savenote">נשמר בכל סימון</span></h4>
        <div class="fhint">ימים שבהם הערוץ לא מקבל פוסטים. פוסט שכבר שובץ ביום שנחסם מוזז ליום פנוי.</div>
        <div class="checks blockdays">
          ${HE_DAYS.map((d, i) => `<label>
            <input type="checkbox" data-blocked="${c.id}" value="${i}"
                   ${(c.blocked_days ?? []).includes(i) ? 'checked' : ''} ${ro ? 'disabled' : ''}>
            ${d}</label>`).join('')}
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

// מה הרשאת approve פותחת בפועל: אישור לפרסום אוטומטי (גם מרוכז לשבוע),
// פרסום מיידי, ומבצע דחוף שנכנס ללוח בלי להמתין לאישור (routes/publish.js,
// routes/board.js, routes/engine.js)
const APPROVE_HINT = 'אישור פוסטים לפרסום אוטומטי ופרסום מיידי לרשתות, וגם מבצע דחוף בלי המתנה לאישור';

/**
 * קבוצת "מערכת" — כל חלק לפי ההרשאה שהשרת דורש בפועל:
 * משתמשים ← users; כללי המנוע גלויים לכולם וניתנים לעריכה רק עם settings
 * (PATCH /settings), כמו ערוצים ונקודות קצה; גיבויים ← settings (GET /backups).
 */
function systemGroup(users, settings, backupsRes, ro) {
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
      <td>${u.is_owner ? '' : `<button class="btn small" data-del-user="${u.id}" style="color:var(--st-crit)">מחק</button>`}</td>
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
              <th title="${esc(APPROVE_HINT)}">אישור פרסום</th><th>ניהול משתמשים</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div style="margin-top:10px"><button class="btn small primary" id="addUser">＋ הוסף משתמש</button></div>
        </div>
      </details>` : ''}
      <details class="item" data-open-id="engine">
        <summary><b>מתקדם — כללי המנוע</b><span class="info">נוגעים בזה לעיתים רחוקות</span></summary>
        <div class="ibody">
          ${eng('ימים לפחות בין שני פוסטים של אותה נקודת קצה באותו ערוץ', 'min_gap_days', s.min_gap_days)}
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
          <div class="fhint enghint-row">כשמסומן, המנוע לא משבץ פוסט מכירתי אם אין מספיק פוסטי ערך באותו שבוע.</div>
          ${eng('כמה פוסט "משולב" נחשב מכירתי (0–1)', 'hybrid_weight', s.hybrid_weight, '0.1')}
          <div class="fhint enghint-row">1 = נספר כמו מכירתי מלא, 0.5 = חצי מכירתי וחצי ערך, 0 = נספר כערך.</div>
          ${eng('התראה על פוסט חסר תוכן — כמה שעות לפני המועד', 'content_alert_hours', s.content_alert_hours)}
          <div class="prow">
            <label class="cbline">
              <input type="checkbox" id="engUsePerf" ${s.use_performance ? 'checked' : ''} ${dis}>
              לתת לביצועים הנמדדים להשפיע על השיבוץ
            </label>
          </div>
          <div class="fhint enghint-row">
            דולק = ערוצים, ימים ונקודות קצה שהתוצאות שלהם טובות יותר מקבלים עדיפות בשיבוץ הבא.
            כבוי = התוצאות רק מוצגות בטאב "נתונים". כדאי להדליק אחרי שיש מספיק מדידות.
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
    { label: 'מחק לצמיתות', value: 'delete', cls: 'crit' },
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

function wireManage(ro, connections) {
  const reload = run(async () => { await renderManage(); await refreshBoard(); });

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

  // אוטומטי/קבוע לקצב הפרסום — לא שני שדות שיכולים לסתור זה את זה
  $$('#manage [data-ep-cadence-mode]').forEach((r) =>
    r.addEventListener('change', run(async () => {
      const id = r.dataset.epCadenceMode;
      const input = $(`[data-ep-cadence-input="${id}"]`);
      if (r.value === 'auto') {
        input.disabled = true;
        const res = await api(`/endpoints/${id}`,
          { method: 'PATCH', body: { min_days_between: null, week: state.week } });
        engineToast(res, 'נשמר — התדירות תחושב אוטומטית לפי החשיבות.');
        await refreshBoard();
      } else {
        input.disabled = false;
        input.focus();
      }
    })));

  $$('#manage [data-ep-cadence-input]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const val = inp.value.trim() === '' ? null : Number(inp.value);
      const res = await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { min_days_between: val, week: state.week } });
      engineToast(res, 'נשמר.');
      await refreshBoard();
    })));

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

  $('#autopubGlobal')?.addEventListener('change', run(async (e) => {
    await api('/settings', { method: 'PATCH', body: { autopublish_enabled: e.target.checked } });
    toast(e.target.checked
      ? 'הפרסום האוטומטי פעיל — יתפרסמו רק פוסטים שאושרו אחד-אחד.'
      : 'הפרסום האוטומטי כבוי — שום פוסט לא יתפרסם לבד.');
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
    b.auto_enabled = $(`[data-conn-auto="${id}"]`)?.checked ?? false;
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
      || ($(`#manage [data-conn-auto="${id}"]`)?.checked ?? false) !== !!saved?.auto_enabled;
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
      await api(`/channels/${id}/connection`, { method: 'PUT', body });
      toast('החיבור נשמר. כדאי ללחוץ "בדוק חיבור" כדי לוודא שהוא עובד.');
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
      if (!(await confirmDialog('לנתק את הערוץ? הטוקן יימחק ותצטרך להזין אותו מחדש כדי לחבר.', { danger: true }))) return;
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

  $('#engUsePerf')?.addEventListener('change', run(async (e) => {
    const on = e.target.checked;
    const res = await api('/settings',
      { method: 'PATCH', body: { use_performance: on, week: state.week } });
    engineToast(res, on ? 'נשמר — הביצועים הנמדדים משפיעים עכשיו על השיבוץ.'
                        : 'נשמר — הביצועים רק נמדדים, בלי להשפיע על הלוח.');
    await refreshBoard();
  }));

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
      if (!(await confirmDialog('למחוק את המשתמש?', { danger: true }))) return;
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
        (x.posts ? `\n${x.posts} פוסטים שלה על הלוח יישארו בלי נקודת קצה ובלי תוכן.` : '');
      const choice = await deleteOrDisable(msg, x.active && (lost || x.posts),
        'השבתה משאירה הכול במקום ורק מוציאה את הנקודה מהשיבוץ.', 'מחק נקודת קצה');
      if (choice === 'disable') {
        await api(`/endpoints/${id}`, { method: 'PATCH', body: { active: false, week: state.week } });
        toast('נקודת הקצה הושבתה — שום דבר לא נמחק.');
      } else if (choice === 'delete') {
        await api(`/endpoints/${id}?force=1`, { method: 'DELETE', body: { week: state.week } });
        toast('נקודת הקצה נמחקה.');
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
        'השבתה משאירה את ההיסטוריה ורק מוציאה את הערוץ מהשיבוץ.', 'מחק ערוץ');
      if (choice === 'disable') {
        await api(`/channels/${id}`, { method: 'PATCH', body: { active: false, week: state.week } });
        toast('הערוץ הושבת — שום דבר לא נמחק.');
      } else if (choice === 'delete') {
        await api(`/channels/${id}?force=1`, { method: 'DELETE', body: { week: state.week } });
        toast('הערוץ נמחק.');
      } else return;
      resetSetupStatus();   // צעד חובה בהקמה יכול לסגת — הלוח שואל שוב
      await reload();
    })));

  $$('#manage [data-toggle-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/endpoints/${b.dataset.toggleEndpoint}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true', week: state.week } });
      if (b.dataset.active === 'true') resetSetupStatus();   // הושבת — ההקמה יכולה לסגת
      await reload();
    })));

  $$('#manage [data-toggle-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/channels/${b.dataset.toggleChannel}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true', week: state.week } });
      if (b.dataset.active === 'true') resetSetupStatus();   // הושבת — ההקמה יכולה לסגת
      await reload();
    })));

  if (!ro) {
    $('#addEndpoint')?.addEventListener('click', () => openGeneric({
      title: 'נקודת קצה חדשה',
      fields: [
        { name: 'name', label: 'שם', type: 'text' },
        { name: 'importance', label: 'חשיבות (1–10)', type: 'number', value: 5 },
        { name: 'min_days_between', label: 'תדירות (פעם ב־X ימים)', type: 'auto',
          value: null, auto: 'נגזר מהחשיבות',
          hint: 'אוטומטי מחשב את התדירות לפי החשיבות. קבוע נועד למקרה שיש צורך בתדירות ' +
                'מסוימת, בלי קשר לחשיבות.' },
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
        { name: 'max_per_week', label: 'מקסימום פרסומים בשבוע', type: 'number', value: 5 },
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
      { name: 'perm_approve', label: `אישור פרסום — ${APPROVE_HINT}`, type: 'checkbox' },
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
