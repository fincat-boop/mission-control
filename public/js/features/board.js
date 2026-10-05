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

  // רשימה אחת שמשמשת גם כמקרא הצבעים וגם כמצב האוויר של כל נקודה.
  // קודם היו כאן שתי שורות שמציגות את אותן נקודות בשתי מערכות צבע שונות.
  const oxy = b.oxygen.map((o) => {
    const when = o.days_since === null
      ? 'עוד לא פורסם'
      : o.days_since === 0 ? 'פורסם היום'
      : o.days_since === 1 ? 'פורסם אתמול'
      : `${o.days_since} ימים בלי פרסום`;
    const onAir = !o.stale || o.scheduled_this_week > 0;
    const tip = `${o.name} · ${when}` +
                (o.scheduled_this_week ? ` · משובץ ${o.scheduled_this_week} פעמים השבוע`
                                       : ' · לא משובץ השבוע');
    // כפתור ולא span: במגע אין ריחוף, ולחיצה מציגה את אותו הסבר (data-oxy)
    return `<button type="button" class="oxychip${onAir ? '' : ' off'}" data-tt="${esc(tip)}"
      data-oxy="${esc(tip)}" aria-label="${esc(tip)}">
      <i class="sw" style="background:${epColor(o.endpoint_id)}"></i>${esc(o.name)}
    </button>`;
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
    <div class="oxy"><span class="t">מי מקבל במה:</span>${oxy || '<span class="d">אין נקודות קצה פעילות</span>'}</div>

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
        <span>הסוג מסומן בתג בכל פוסט · ⚡ דחוף · ✓ פורסם</span>
      </div>
    </div>

    ${PHONE.matches
      ? `<div class="board mboard">${b.channels.length ? phoneDays(b, editable)
          : `<div class="empty">אין ערוצים פעילים — כל ערוץ הוא שורה בלוח.
             ${setupGoButton(chStep?.target ?? { tab: 'manage', section: 'channels' },
                             chStep?.action ?? 'לערוצים', true)}</div>`}</div>`
      : `<div class="board panel">
      <table class="grid">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body || emptyRow}</tbody>
      </table>
    </div>`}
    <div class="sumline">השבוע: <b>${s.total} פרסומים</b> · מהם <b>${s.promo} מכירתיים</b> · ${ratio}</div>
    ${b.held?.length ? `<div class="sumline held">⏸ מוסתרים בגלל השהיה:
      ${b.held.map((h) => `<b>${esc(h.name)}</b> (${h.n})`).join(' · ')}
      — חוזרים ללוח כשמפעילים את הקמפיין</div>` : ''}`;

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
  $$('#board [data-oxy]').forEach((chip) =>
    chip.addEventListener('click', () => toast(chip.dataset.oxy)));

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

/** תג המצב של פוסט ברשימת הטלפון — אותה שפה כמו התגיות הפינתיות בטבלה */
function statusTag(p) {
  if (p.status === 'hole') return { cls: 'red', label: 'חסר תוכן' };
  if (p.status === 'pending_approval') return { cls: 'yellow', label: 'ממתין לאישור' };
  if (p.status === 'published') {
    return p.has_results ? { cls: 'auto', label: '✓ פורסם' } : { cls: 'yellow', label: '✓ פורסם · לא נמדד' };
  }
  if (isMissed(p)) return { cls: 'yellow', label: 'עבר המועד' };
  const hub = newsletterHubTag(p); // ניוזלטר שהועבר — "ממתין לאישור ב-HUB"
  if (hub) return hub;
  if (AUTO_TAG[p.status]) return AUTO_TAG[p.status];
  if (!p.content_id) return { cls: 'red', label: 'חסר תוכן' };
  return p.variant_status === 'ready' ? { cls: 'blue', label: 'יש תוכן' } : { cls: 'yellow', label: 'יש טיוטה' };
}

/** שורת פוסט בטלפון: שעה, צבע הנקודה, כותרת, ערוץ ונקודה, ותג מצב */
function phoneRow(p) {
  const tag = statusTag(p);
  const title = p.status === 'hole' ? 'חסר תוכן' : p.title;
  return `<button type="button" class="mpost${p.status === 'published' ? ' done' : ''}" data-post-id="${p.id}">
    <span class="mtime">${esc(p.time)}</span>
    <i class="sw" style="background:${epColor(p.endpoint_id)}"></i>
    <span class="mbody">
      <b>${p.urgent ? '⚡ ' : ''}${esc(title)}</b>
      <span class="d">${esc(p.channel_name)}${p.endpoint_name ? ` · ${esc(p.endpoint_name)}` : ''}${
        p.assignee_name ? ` · ${esc(p.assignee_name)}` : ''}</span>
    </span>
    <span class="mtag ${tag.cls}">${tag.label}</span>
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
  approved:   { cls: 'auto', label: '⚡ פרסום אוטו׳' },
  publishing: { cls: 'auto', label: '🚀 מתפרסם…' },
  failed:     { cls: 'red',  label: '✗ הפרסום נכשל' },
};

function postCard(p) {
  const who = p.assignee_name ? ` · ${esc(p.assignee_name)}` : '';
  const payload = esc(JSON.stringify(p));
  // התצוגה פתוחה לכולם; הגרירה בלבד מוגבלת להרשאת תוכן
  const clickable = `data-post-id="${p.id}" data-post="${payload}"`;

  if (p.status === 'hole') {
    // שורות 'hole' ישנות (לפני שפוסט חסר תוכן הפך לפוסט רגיל בלי content_id).
    // ה"סיבה" שהמנוע כתב מבדילה בין שני מצבים: יש טיוטה שעוד לא אושרה
    // לאף ערוץ פנוי, או שאין בכלל תוכן לנקודה הזו — ראו findHoles ב-engine.js
    const hasDraft = (p.note ?? '').includes('יש תוכן');
    return `<div class="hole${hasDraft ? ' draft' : ''}" ${clickable}
      data-tt="חסר תוכן: ${esc(KIND_HE[p.kind])} — ${esc(p.endpoint_name ?? '')}${p.note ? ` · ${esc(p.note)}` : ''}">
      <span class="corner-tag ${hasDraft ? 'yellow' : 'red'}">${hasDraft ? 'יש טיוטה' : 'חסר תוכן'}</span>
      חסר תוכן<br><small>${esc(KIND_HE[p.kind])} · ${esc(p.endpoint_name ?? '')}</small></div>`;
  }
  if (p.status === 'pending_approval') {
    return `<div class="pending" ${clickable}
      data-tt="ממתין לאישור — ${esc(p.title)}">
      ממתין לאישור<br><small>${esc(p.title)}</small></div>`;
  }

  const tip = `${p.endpoint_name ?? ''} · ${KIND_HE[p.kind]}${p.urgent ? ' · דחוף' : ''}` +
              `${p.assignee_name ? ` · אחראי: ${p.assignee_name}` : ''}`;
  const bg = epColor(p.endpoint_id);

  // פוסט שכבר יצא לאוויר: הכרטיס עצמו נשאר (צבע, כותרת, פרטים), רק
  // דהוי, וחותמת ירוקה גדולה למעלה אומרת שזה כבר קרה.
  if (p.status === 'published') {
    return `<div class="post published" ${clickable} data-tt="${esc(p.has_results ? tip : `לא נמדד · ${tip}`)}"
      style="background:${bg};color:${inkOn(bg)}">
      <span class="pub-stamp">✓ פורסם</span>
      <div class="published-inner">
        <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
        <div class="meta">
          <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
          ${esc(p.time)}${who}
        </div>
      </div>
      ${p.has_results ? '' : '<i class="unmeasured" title="עוד לא הוזנו תוצאות — לוחצים כדי להזין">לא נמדד</i>'}
    </div>`;
  }

  // הצבע הוא נקודת הקצה. סוג התוכן מסומן בתג קטן, כדי ששני הממדים
  // יהיו קריאים בלי שאחד יסתיר את השני.
  // התגית נגזרת מהמצב האמיתי של התוכן — לא רק "משובץ = מוכן". שיבוץ
  // יכול להיות לפי אסטרטגיה גם בלי תוכן סופי (וגם בלי תוכן בכלל).
  // "פורסם" הוא הדבר היחיד שלא נגזר משום מקום: מישהו צריך לקבוע את זה בפועל.
  //
  // פוסט חסר תוכן (content_id ריק) נשאר הכרטיס הרגיל — צבע הנקודה, כותרת,
  // שעה — אבל במסגרת מקווקוות, כדי שיהיה ברור שהוא מחכה. content_hint אומר
  // אם יש לנקודה כבר משהו לשייך לו בערוץ הזה (טיוטה או מוכן).
  const missing = !p.content_id;
  const contentTag = missing
    ? { cls: 'red', label: 'חסר תוכן' }
    : p.variant_status === 'ready'
      ? { cls: 'blue', label: 'יש תוכן' }
      : { cls: 'yellow', label: 'יש טיוטה' };
  const hint = missing && p.content_hint
    ? `<i class="hint">${p.content_hint === 'ready' ? 'יש תוכן לשייך' : 'יש טיוטה'}</i>` : '';

  const tag = newsletterHubTag(p) ?? AUTO_TAG[p.status] ?? contentTag;
  // מתוכנן (או מאושר שלא נתפס) שהמועד שלו עבר — לא יצא, וצריך החלטה
  const missed = isMissed(p);
  const cls = ['post', p.status === 'failed' && 'failed', missing && 'missing', missed && 'missed']
    .filter(Boolean).join(' ');
  const tt = [missed && 'עבר המועד', missing && 'חסר תוכן', tip].filter(Boolean).join(' · ');

  return `<div class="${cls}" ${clickable} data-tt="${esc(tt)}"
    style="background:${bg};color:${inkOn(bg)}">
    <span class="corner-tag ${tag.cls}">${tag.label}</span>
    <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
    <div class="meta">
      <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
      ${esc(p.time)}${who}${hint}
    </div>${missed ? '<i class="missed-tag">עבר המועד</i>' : ''}</div>`;
}
