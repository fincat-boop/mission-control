import { api, postWithGapCheck } from '../core/api.js';
import { can, epColor, persistView, state } from '../core/state.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { HE_DAYS, KIND_HE, inkOn, ymd } from '../core/format.js';
import { refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { openEngine } from '../ui/engineDialog.js';
import { openPostPreview } from '../ui/postDialog.js';
import { openAddPost } from '../ui/addPost.js';
import { confirmDialog } from '../core/confirm.js';
import { isMissed } from '../core/postActions.js';
import { newsletterHubTag } from '../core/hubFill.js';
import { fetchSetupStatus, renderSetupCard, setupGoButton, wireSetupGo } from '../ui/setup.js';

/* ========================= הלוח ========================= */

/*
 * בטלפון (עד 600px) הלוח הוא רשימה לפי ימים במקום טבלה ברוחב 1000px — אותם
 * נתונים, רנדרר אחר. מעבר בין המצבים (סיבוב, שינוי חלון) מצייר מחדש.
 * בטלפון אין גרירה: הזזת פוסט היא דרך לשונית "עריכה" בחלון הפוסט.
 */
const PHONE = matchMedia('(max-width: 600px)');
PHONE.addEventListener('change', () => {
  if (state.tab === 'board') run(refreshBoard)();
});

let boardReq = 0; // רק התשובה לבקשה האחרונה מצוירת — לחיצות מהירות על ‹ › לא מתערבבות

export async function renderBoard() {
  const req = ++boardReq;
  // רשימת ההקמה — רכה: אם היא נכשלת, הלוח עצמו עדיין מוצג. אחרי שהושלמה
  // לא נשאלת שוב באותו דף (fetchSetupStatus)
  const [b, setup] = await Promise.all([
    api(`/board${state.week ? `?week=${state.week}` : ''}`),
    fetchSetupStatus(),
  ]);
  if (req !== boardReq) return; // בינתיים התבקש שבוע אחר
  const editable = can('content');

  // מי מקבל במה: בתחתית הלוח, נקודה לכל נקודת קצה (גם מקרא הצבעים) והמצב
  // שלה כטקסט גלוי — כמה פעמים משובצת השבוע ומתי פורסמה לאחרונה. כל נקודה
  // בלוק מלא בצבע שלה — אותו צבע כמו הכרטיסים שלה בלוח. נקודה שלא באוויר
  // (לא פורסמה מזמן ולא משובצת) — דהויה, עם ⚠ במצב
  const oxy = b.oxygen.map((o) => {
    const when = o.days_since === null
      ? 'עוד לא פורסם'
      : o.days_since === 0 ? 'פורסם היום'
      : o.days_since === 1 ? 'פורסם אתמול'
      : `${o.days_since} ימים בלי פרסום`;
    const onAir = !o.stale || o.scheduled_this_week > 0;
    const plan = o.scheduled_this_week
      ? (o.scheduled_this_week === 1 ? 'פעם אחת השבוע' : `${o.scheduled_this_week} פעמים השבוע`)
      : 'לא משובץ השבוע';
    const bg = epColor(o.endpoint_id);
    return `<li class="oxyitem${onAir ? '' : ' off'}" title="${esc(`${o.name} · ${plan} · ${when}`)}"
      style="background:${bg};color:${inkOn(bg)}">
      <span class="nm">${esc(o.name)}</span>
      <span class="st">${onAir ? '' : '⚠ '}${esc(plan)} · ${esc(when)}</span>
    </li>`;
  }).join('');

  const today = ymd(new Date());
  const head = b.week.days.map((d) => (d.date === today
    ? `<th class="today" aria-current="date">${esc(d.label)} · היום</th>`
    : `<th>${esc(d.label)}</th>`)).join('');

  const body = b.channels.map((ch) => {
    const full = ch.used >= ch.max_per_week;
    const days = ch.days.map((day) => {
      const cards = day.posts.map((p) => postCard(p)).join('');
      // יום חסום לא מקבל גרירה, ומסומן ויזואלית כדי שלא ינסו
      const dow = new Date(`${day.date}T00:00:00`).getDay();
      const blocked = (ch.blocked_days ?? []).includes(dow);
      const drop = editable && !blocked
        ? `data-drop-channel="${ch.id}" data-drop-date="${day.date}"` : '';
      // הוספה ידנית של פוסט — לא נוגעת בכלום אחר בלוח, רק פותחת משבצת חדשה
      const add = editable && !blocked
        ? `<button type="button" class="addslot" data-add-slot
             data-channel="${ch.id}" data-date="${day.date}"
             data-channel-name="${esc(ch.name)}" title="הוסף פוסט">+</button>` : '';
      // הסיבה גם כטקסט גלוי — במגע אין tooltip של ריחוף
      const why = `${ch.name} לא מקבל תוכן בימי ${HE_DAYS[dow]}`;
      return `<td class="day${blocked ? ' blocked' : ''}${day.date === today ? ' today' : ''}" ${drop}
        ${blocked ? `data-tt="${esc(why)}"` : ''}
        >${blocked ? `<span class="daynote" title="${esc(why)}">יום חסום</span>` : ''}${cards}${add}</td>`;
    }).join('');
    return `<tr>
      <td class="chan">
        <div class="cname">${esc(ch.name)}</div>
        <div class="cap${full ? ' full' : ''}">${ch.used} מתוך ${ch.max_per_week} השבוע</div>
      </td>${days}</tr>`;
  }).join('');

  const s = b.summary;
  // min_value_per_promo=0 פירושו שהמשתמש כיבה את הדרישה במפורש — לא
  // משווים כלפיה בכלל, כדי שלא יופיע ⚠ על יחס שהוא בחר לא לאכוף
  const ratio = s.value_per_promo === null
    ? 'אין עדיין פוסטים מכירתיים השבוע'
    : s.min_value_per_promo > 0
      ? `על כל מכירתי יש <b>${s.value_per_promo} פוסטי ערך</b> ${
          s.value_per_promo >= s.min_value_per_promo ? '✓' : '⚠'}`
      : `על כל מכירתי יש <b>${s.value_per_promo} פוסטי ערך</b>`;

  // בלי ערוצים פעילים אין שורות בלוח — כפתור למקום שבו מוסיפים/מפעילים, לא טקסט
  const chStep = setup?.steps.find((x) => x.id === 'channel');
  const emptyRow = `<tr><td class="empty" colspan="8">אין ערוצים פעילים — כל ערוץ הוא שורה בלוח.
    ${setupGoButton(chStep?.target ?? { tab: 'manage', section: 'channels' },
                    chStep?.action ?? 'לערוצים', true)}</td></tr>`;

  $('#board').innerHTML = `
    <div id="setupCard"></div>
    <div class="toolbar">
      <div class="weeknav">
        <button data-week="${b.week.prevWeek}">‹</button>
        ${esc(b.week.label)}
        <button data-week="${b.week.nextWeek}">›</button>
      </div>
      <button class="btn small" id="thisWeek">השבוע</button>
      ${editable ? '<button class="btn small primary" id="runEngine">⚙ מלא את השבוע</button>' : ''}
      ${can('approve') ? `<button class="btn small" id="approveWeek">${APPROVE_WEEK_LABEL}</button>` : ''}
      <div class="spacer"></div>
      <div class="legend">
        <span>צבע הכרטיס = נקודת הקצה (מקרא בתחתית) · ⚡ דחוף</span>
      </div>
    </div>

    ${PHONE.matches
      ? `<div class="board mboard">${b.channels.length ? phoneDays(b, editable)
          : `<div class="empty">אין ערוצים פעילים — כל ערוץ הוא שורה בלוח.
             ${setupGoButton(chStep?.target ?? { tab: 'manage', section: 'channels' },
                             chStep?.action ?? 'לערוצים', true)}</div>`}</div>`
      : `<div class="board panel">
      <table class="grid wboard">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body || emptyRow}</tbody>
      </table>
    </div>`}
    <div class="sumline">השבוע: <b>${s.total} פרסומים</b> · מהם <b>${s.promo} מכירתיים</b> · ${ratio}</div>
    ${b.held?.length ? `<div class="sumline held">⏸ מוסתרים בגלל השהיה:
      ${b.held.map((h) => `<b>${esc(h.name)}</b> (${h.n})`).join(' · ')}
      — חוזרים ללוח כשמפעילים את הקמפיין</div>` : ''}
    <section class="oxy" aria-label="מי מקבל במה">
      <h3>מי מקבל במה</h3>
      ${oxy ? `<ul>${oxy}</ul>` : '<p class="d">אין נקודות קצה פעילות</p>'}
    </section>`;

  renderSetupCard($('#setupCard'), setup);
  wireSetupGo($('#board .board'));

  // השבוע המוצג נשמר בכתובת (;w=) — רענון נשאר על אותו שבוע
  $$('#board [data-week]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      state.week = btn.dataset.week;
      persistView();
      await refreshBoard();
    })));
  $('#thisWeek').addEventListener('click', run(async () => {
    state.week = null;
    persistView();
    await refreshBoard();
  }));
  $('#runEngine')?.addEventListener('click', run(openEngine));

  // אישור מרוכז — כל המוכנים לפרסום אוטומטי של השבוע שמועדם עוד לא עבר
  // עוברים ל-approved, וכל אחד מתפרסם במועד שנקבע לו. לא שולח מיד.
  $('#approveWeek')?.addEventListener('click', run(async () => {
    if (!(await confirmDialog('לאשר לפרסום אוטומטי את כל הפוסטים המוכנים של השבוע שמועדם עוד לא עבר? כל אחד יתפרסם במועד שנקבע לו.',
      { okLabel: 'אשר לפרסום' }))) return;
    const btn = $('#approveWeek');
    btn.disabled = true;
    btn.textContent = 'מאשר…';
    try {
      const res = await api('/publish/approve-week', { method: 'POST', body: { week: state.week } });
      const offNote = res.autopublish_enabled ? ''
        : 'שימו לב: מתג הפרסום האוטומטי כבוי — לא ייצא כלום עד שמדליקים אותו בניהול.';
      if (res.skipped.length) {
        // מה לא אושר ולמה — רשימה ולא רק מספר, כדי שאפשר יהיה לתקן
        await confirmDialog(skippedReport(res, offNote), { okLabel: 'הבנתי' });
      } else if (!res.approved) {
        toast('אין פוסטים לאשר השבוע.', true);
      } else {
        toast(`אושרו ${res.approved} פוסטים לפרסום אוטומטי ⚡${offNote ? ` — ${offNote}` : ''}`);
      }
      await Promise.all([refreshBoard(), refreshAlerts()]);
    } finally {
      btn.disabled = false;
      btn.textContent = APPROVE_WEEK_LABEL;
    }
  }));

  // לחיצה מציגה את הפוסט כפי שהוא ייצא. גם למי שאין לו הרשאת עריכה.
  $$('#board [data-post-id]').forEach((el) =>
    el.addEventListener('click', run(() => openPostPreview(el.dataset.postId))));

  // מצב האוויר של נקודה — גם בלחיצה (במגע אין ריחוף)

  // + במשבצת ריקה — הוספת פוסט ידנית
  $$('#board [data-add-slot]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddPost(Number(btn.dataset.channel), btn.dataset.date, btn.dataset.channelName);
    }));
  // בטלפון — פוסט ליום, והערוץ נבחר בחלון ההוספה
  $$('#board [data-add-day]').forEach((btn) =>
    btn.addEventListener('click', () => openAddPost(null, btn.dataset.addDay, null)));

  if (editable && !PHONE.matches) wireBoardDrag();
}

/* ========================= הלוח בטלפון ========================= */

/**
 * המצב של פוסט במילים — אותו מקור לכרטיס בטבלה ולשורה בטלפון. cls הוא הגוון
 * (red/yellow/blue/auto). hint — פרט משני (יש מה לשייך לפוסט בלי תוכן).
 */
function statusTag(p) {
  if (p.status === 'hole' || (!p.content_id && !AUTO_TAG[p.status] && p.status !== 'published')) {
    // שורות 'hole' ישנות: ה"סיבה" שהמנוע כתב אומרת אם יש טיוטה (findHoles ב-engine.js)
    const hint = p.status === 'hole'
      ? ((p.note ?? '').includes('יש תוכן') ? 'יש טיוטה לשייך' : '')
      : p.content_hint === 'ready' ? 'יש תוכן מוכן לשייך'
      : p.content_hint ? 'יש טיוטה לשייך' : '';
    if (isMissed(p)) return { cls: 'yellow', label: 'המועד עבר', hint: 'אין תוכן' };
    return { cls: 'red', label: 'אין תוכן', hint };
  }
  if (p.status === 'pending_approval') return { cls: 'yellow', label: 'ממתין לאישור' };
  if (p.status === 'published') {
    return p.has_results ? { cls: 'auto', label: 'פורסם' } : { cls: 'auto', label: 'פורסם', hint: 'אין תוצאות עדיין' };
  }
  if (isMissed(p)) return { cls: 'yellow', label: 'המועד עבר', hint: 'לא פורסם' };
  const hub = newsletterHubTag(p); // ניוזלטר שהועבר — "ממתין לאישור ב-HUB"
  if (hub) return hub;
  if (AUTO_TAG[p.status]) return AUTO_TAG[p.status];
  return p.variant_status === 'ready'
    ? { cls: 'blue', label: 'מוכן לפרסום' }
    : { cls: 'yellow', label: 'טיוטה', hint: 'התוכן עוד לא מוכן' };
}

/** שורת המצב בתחתית הכרטיס: נקודה בגוון + המילים, ופרט משני באפור */
const statusLine = (t) => `<div class="pst ${t.cls}"><i></i>${esc(t.label)}${
  t.hint ? `<span class="h"> · ${esc(t.hint)}</span>` : ''}</div>`;

/** שורת פוסט בטלפון: שעה, צבע הנקודה, כותרת, ערוץ ונקודה, ותג מצב */
function phoneRow(p) {
  const tag = statusTag(p);
  const title = p.status === 'hole' ? KIND_HE[p.kind] : p.title;
  return `<button type="button" class="mpost${p.status === 'published' ? ' done' : ''}" data-post-id="${p.id}">
    <span class="mtime">${esc(p.time)}</span>
    <i class="sw" style="background:${epColor(p.endpoint_id)}"></i>
    <span class="mbody">
      <b>${p.urgent ? '⚡ ' : ''}${esc(title)}</b>
      <span class="d">${esc(p.channel_name)}${p.endpoint_name ? ` · ${esc(p.endpoint_name)}` : ''}${
        p.assignee_name ? ` · ${esc(p.assignee_name)}` : ''}</span>
    </span>
    <span class="mtag ${tag.cls}"><i></i>${esc(tag.label)}</span>
  </button>`;
}

/** השבוע כרשימת ימים: כותרת יום ← הפוסטים לפי שעה; יום ריק — "+" */
function phoneDays(b, editable) {
  const today = ymd(new Date());
  return b.week.days.map((d) => {
    const posts = b.channels
      .flatMap((ch) => (ch.days.find((x) => x.date === d.date)?.posts ?? [])
        .map((p) => ({ ...p, channel_name: ch.name })))
      .sort((x, y) => new Date(x.scheduled_at) - new Date(y.scheduled_at));
    const add = editable
      ? `<button type="button" class="btn small mday-add" data-add-day="${d.date}"
           aria-label="הוסף פוסט ליום ${esc(d.label)}">+ פוסט</button>` : '';
    return `<section class="mday${d.date === today ? ' today' : ''}">
      <h4 class="mday-head"><span>${esc(d.label)}${d.date === today ? ' · היום' : ''}</span>${add}</h4>
      ${posts.length ? posts.map(phoneRow).join('') : '<div class="mday-empty">אין פוסטים ביום הזה</div>'}
    </section>`;
  }).join('');
}

const APPROVE_WEEK_LABEL = '⚡ אשר מוכנים לפרסום אוטומטי';

/** סיכום האישור המרוכז כשחלק מהפוסטים לא אושרו — עד 10 עם הסיבה */
function skippedReport({ approved, skipped }, offNote) {
  const shown = skipped.slice(0, 10).map((x) => `• ${x.title} — ${x.reason}`);
  const more = skipped.length > 10 ? [`ועוד ${skipped.length - 10}…`] : [];
  return [
    approved ? `אושרו ${approved} פוסטים לפרסום אוטומטי.` : 'לא אושר אף פוסט.',
    `${skipped.length} לא אושרו:`,
    ...shown, ...more,
    ...(approved && offNote ? ['', offNote] : []),
  ].join('\n');
}

const DRAGGABLE = new Set(['scheduled', 'approved', 'failed', 'pending_approval']);

/**
 * גרירת כרטיס ליום אחר על הלוח.
 * שינוי ערוץ מותר רק אם לתוכן יש גרסה מוכנה לערוץ היעד — אחרת היינו
 * מפרסמים שם ניסוח שנכתב לערוץ אחר.
 */
function wireBoardDrag() {
  let dragged = null;

  // רק מה שעוד לא יצא אפשר להזיז; פורסם / בשליחה — לא.
  // השרת אוכף את אותו כלל (moveBlocker ב-routes/board.js).
  $$('#board [data-post-id]').forEach((el) => {
    if (!DRAGGABLE.has(JSON.parse(el.dataset.post).status)) return;
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      dragged = JSON.parse(el.dataset.post);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      $$('#board .day.over').forEach((d) => d.classList.remove('over'));
      dragged = null;
    });
  });

  $$('#board [data-drop-channel]').forEach((cell) => {
    cell.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      cell.classList.add('over');
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));

    cell.addEventListener('drop', run(async (e) => {
      e.preventDefault();
      cell.classList.remove('over');
      if (!dragged) return;

      const channelId = Number(cell.dataset.dropChannel);
      const date = cell.dataset.dropDate;
      const sameSpot = channelId === dragged.channel_id &&
                       date === ymd(new Date(dragged.scheduled_at));
      if (sameSpot) return;

      // שומרים את שעת היום המקורית
      const at = new Date(dragged.scheduled_at);
      const [y, m, d] = date.split('-').map(Number);
      at.setFullYear(y, m - 1, d);

      const moved = await postWithGapCheck(`/posts/${dragged.id}`,
        { scheduled_at: at.toISOString(), channel_id: channelId });
      if (!moved) return;   // המשתמש ביטל אחרי האזהרה
      toast(moved.approval_reset
        ? 'השיבוץ הוזז. האישור לפרסום אוטומטי בוטל כי הערוץ השתנה — צריך לאשר שוב.'
        : 'השיבוץ הוזז.');
      await Promise.all([refreshBoard(), refreshAlerts()]);
    }));
  });
}

// מצבי מסלול הפרסום האוטומטי — תג במקום תגית התוכן, כי הם חזקים ממנה
const AUTO_TAG = {
  approved:   { cls: 'auto', label: 'יתפרסם אוטומטית' },
  publishing: { cls: 'auto', label: 'מתפרסם עכשיו' },
  failed:     { cls: 'red',  label: 'הפרסום נכשל' },
};

function postCard(p) {
  const who = p.assignee_name ? ` · ${esc(p.assignee_name)}` : '';
  const payload = esc(JSON.stringify(p));
  // התצוגה פתוחה לכולם; הגרירה בלבד מוגבלת להרשאת תוכן
  const clickable = `data-post-id="${p.id}" data-post="${payload}"`;
  // הכותרת לא בכרטיס (קטן ומהיר לסריקה) — רק בריחוף ובחלון הפוסט
  const title = p.status === 'hole' ? '' : p.title;
  const tip = `${title ? `${title} · ` : ''}${p.endpoint_name ?? ''} · ${KIND_HE[p.kind]}` +
              `${p.urgent ? ' · דחוף' : ''}${p.assignee_name ? ` · אחראי: ${p.assignee_name}` : ''}`;

  // הכרטיס כולו בצבע נקודת הקצה — אותו צבע כמו הבלוק שלה במקרא שבתחתית —
  // ושם הנקודה כתוב בראשו.
  // מתחת: הסוג והשעה, ושורת מצב אחת במילים.
  const tag = statusTag(p);
  const missing = p.status === 'hole' || (!p.content_id && p.status !== 'published');
  const cls = ['post', p.status === 'published' && 'published', missing && 'missing',
    p.status === 'failed' && 'failed'].filter(Boolean).join(' ');
  return `<div class="${cls}" ${clickable} data-tt="${esc(tip)}"
    style="--ep:${epColor(p.endpoint_id)};--on:${inkOn(epColor(p.endpoint_id))}">
    <span class="pep">${p.urgent ? '⚡ ' : ''}${esc(p.endpoint_name ?? '')}</span>
    <div class="meta"><i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>${esc(p.time ?? '')}${who}</div>
    ${statusLine(tag)}
  </div>`;
}
