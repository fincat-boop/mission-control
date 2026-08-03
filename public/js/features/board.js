import { api, postWithGapCheck } from '../core/api.js';
import { can, epColor, state } from '../core/state.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { HE_DAYS, KIND_HE, inkOn, ymd } from '../core/format.js';
import { refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { openEngine } from '../ui/engineDialog.js';
import { openPostPreview } from '../ui/postDialog.js';
import { openAddPost } from '../ui/addPost.js';

/* ========================= הלוח ========================= */

export async function renderBoard() {
  const b = await api(`/board${state.week ? `?week=${state.week}` : ''}`);
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
    return `<span class="oxychip${onAir ? '' : ' off'}" data-tt="${esc(tip)}">
      <i class="sw" style="background:${epColor(o.endpoint_id)}"></i>${esc(o.name)}
    </span>`;
  }).join('');

  const head = b.week.days.map((d) => `<th>${esc(d.label)}</th>`).join('');

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
      return `<td class="day${blocked ? ' blocked' : ''}" ${drop}
        ${blocked ? `data-tt="${esc(ch.name)} לא מקבל תוכן בימי ${HE_DAYS[dow]}"` : ''}
        >${cards}${add}</td>`;
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

  $('#board').innerHTML = `
    <div class="oxy"><span class="t">מי מקבל במה:</span>${oxy || '<span class="d">אין נקודות קצה פעילות</span>'}</div>

    <div class="toolbar">
      <div class="weeknav">
        <button data-week="${b.week.prevWeek}">‹</button>
        ${esc(b.week.label)}
        <button data-week="${b.week.nextWeek}">›</button>
      </div>
      <button class="btn small" id="thisWeek">השבוע</button>
      ${editable ? '<button class="btn small primary" id="runEngine">⚙ מלא את השבוע</button>' : ''}
      <div class="spacer"></div>
      <div class="legend">
        <span>הסוג מסומן בתג בכל פוסט · ⚡ דחוף · ✓ פורסם</span>
      </div>
    </div>

    <div class="board panel">
      <table class="grid">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${body || `<tr><td class="empty" colspan="8">אין ערוצים פעילים — מוסיפים אותם במסך "ניהול"</td></tr>`}</tbody>
      </table>
    </div>
    <div class="sumline">השבוע: <b>${s.total} פרסומים</b> · מהם <b>${s.promo} מכירתיים</b> · ${ratio}</div>
    ${b.held?.length ? `<div class="sumline held">⏸ מוסתרים בגלל השהיה:
      ${b.held.map((h) => `<b>${esc(h.name)}</b> (${h.n})`).join(' · ')}
      — חוזרים ללוח כשמפעילים את הקמפיין</div>` : ''}`;

  $$('#board [data-week]').forEach((btn) =>
    btn.addEventListener('click', run(async () => {
      state.week = btn.dataset.week;
      await refreshBoard();
    })));
  $('#thisWeek').addEventListener('click', run(async () => {
    state.week = null;
    await refreshBoard();
  }));
  $('#runEngine')?.addEventListener('click', run(openEngine));

  // לחיצה מציגה את הפוסט כפי שהוא ייצא. גם למי שאין לו הרשאת עריכה.
  $$('#board [data-post-id]').forEach((el) =>
    el.addEventListener('click', run(() => openPostPreview(el.dataset.postId))));

  // + במשבצת ריקה — הוספת פוסט ידנית
  $$('#board [data-add-slot]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddPost(Number(btn.dataset.channel), btn.dataset.date, btn.dataset.channelName);
    }));

  if (editable) wireBoardDrag();
}

/**
 * גרירת כרטיס ליום אחר על הלוח.
 * שינוי מדיה מותר רק אם לתוכן יש גרסה מוכנה למדיה היעד — אחרת היינו
 * מפרסמים שם ניסוח שנכתב למדיה אחרת.
 */
function wireBoardDrag() {
  let dragged = null;

  $$('#board [data-post-id]').forEach((el) => {
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
      toast('השיבוץ הוזז.');
      await Promise.all([refreshBoard(), refreshAlerts()]);
    }));
  });
}

function postCard(p) {
  const who = p.assignee_name ? ` · ${esc(p.assignee_name)}` : '';
  const payload = esc(JSON.stringify(p));
  // התצוגה פתוחה לכולם; הגרירה בלבד מוגבלת להרשאת תוכן
  const clickable = `data-post-id="${p.id}" data-post="${payload}"`;

  if (p.status === 'hole') {
    // ה"סיבה" שהמנוע כתב מבדילה בין שני מצבים: יש טיוטה שעוד לא אושרה
    // לאף ערוץ פנוי, או שאין בכלל תוכן לנקודה הזו — ראו findHoles ב-engine.js
    const hasDraft = (p.note ?? '').includes('יש תוכן');
    return `<div class="hole${hasDraft ? ' draft' : ''}" ${clickable}
      data-tt="הלוח מחכה לתוכן: ${esc(KIND_HE[p.kind])} — ${esc(p.endpoint_name ?? '')}${p.note ? ` · ${esc(p.note)}` : ''}">
      <span class="corner-tag ${hasDraft ? 'yellow' : 'red'}">${hasDraft ? 'יש טיוטה' : 'אין תוכן'}</span>
      מחכה לתוכן<br><small>${esc(KIND_HE[p.kind])} · ${esc(p.endpoint_name ?? '')}</small></div>`;
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
    return `<div class="post published" ${clickable} data-tt="${esc(tip)}"
      style="background:${bg};color:${inkOn(bg)}">
      <span class="pub-stamp">✓ פורסם</span>
      <div class="published-inner">
        <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
        <div class="meta">
          <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
          ${esc(p.time)}${who}
        </div>
      </div>
    </div>`;
  }

  // הצבע הוא נקודת הקצה. סוג התוכן מסומן בתג קטן, כדי ששני הממדים
  // יהיו קריאים בלי שאחד יסתיר את השני.
  // התגית נגזרת מהמצב האמיתי של התוכן — לא רק "משובץ = מוכן". שיבוץ
  // יכול להיות לפי אסטרטגיה גם בלי תוכן סופי (וגם בלי תוכן בכלל).
  // "פורסם" הוא הדבר היחיד שלא נגזר משום מקום: מישהו צריך לקבוע את זה בפועל.
  const contentTag = !p.content_id
    ? { cls: 'red', label: 'אין תוכן' }
    : p.variant_status === 'ready'
      ? { cls: 'blue', label: 'יש תוכן' }
      : { cls: 'yellow', label: 'יש טיוטה' };

  return `<div class="post" ${clickable} data-tt="${esc(tip)}"
    style="background:${bg};color:${inkOn(bg)}">
    <span class="corner-tag ${contentTag.cls}">${contentTag.label}</span>
    <span class="ep">${p.urgent ? '⚡ ' : ''}${esc(p.title)}</span>
    <div class="meta">
      <i class="kind ${p.kind}">${esc(KIND_HE[p.kind])}</i>
      ${esc(p.time)}${who}
    </div></div>`;
}
