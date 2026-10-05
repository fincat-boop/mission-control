import { api, postWithGapCheck } from '../core/api.js';
import { can, epColor, state, persistView } from '../core/state.js';
import { $, $$, copyLinkButton, esc, run, toast, wireCopyLinks } from '../core/dom.js';
import { openNewsletterEditor } from '../ui/hubFill.js';
import { CELL, KIND_HE, TONE_CLASS, fmtDate, isImage, isVideo, kb } from '../core/format.js';
import { refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { openGeneric } from '../ui/dialog.js';
import { confirmDialog } from '../core/confirm.js';
import { openImport } from '../ui/importDialog.js';
import { acceptAttr, progressList, uploadBulk, uploadFiles } from '../core/upload.js';
import { inferPeriod } from '../core/period.js';

/* ========================= ניוזלטר ========================= */

/** מחווט פעם אחת מ-app.js — סגירת דיאלוג התצוגה המקדימה */
export function wireMailPreview() {
  $('#previewClose').addEventListener('click', () => $('#previewDlg').close());
}

/* ========================= קמפיינים ותוכן ========================= */

export async function renderPlan() {
  persistView(); // הדרילדאון (נקודת קצה/קמפיין) נשמר ב-hash — שורד רענון
  const [{ campaigns }, { content }] = await Promise.all([
    api('/campaigns'), api('/content'),
  ]);
  state.campaigns = campaigns;

  // הקמפיין שנבחר מכתיב גם את נקודת הקצה, כדי שפירורי הלחם תמיד יהיו עקביים
  const campaign = campaigns.find((c) => c.id === state.planCampaign) ?? null;
  if (campaign) state.planEndpoint = campaign.endpoint_id;
  const endpointId = state.planEndpoint;
  const endpoint = state.endpoints.find((e) => e.id === endpointId) ?? null;

  const crumbs = `
    <div class="crumbs">
      <button data-crumb="root" class="${!endpointId ? 'on' : ''}">כל נקודות הקצה</button>
      ${endpoint ? `<span>›</span>
        <button data-crumb="endpoint" class="${!campaign && !state.planBackground ? 'on' : ''}">${esc(endpoint.name)}</button>` : ''}
      ${campaign ? `<span>›</span>
        <button data-crumb="campaign" class="on">${esc(campaign.name)}</button>` : ''}
      ${state.planBackground && !campaign ? '<span>›</span><button class="on">תוכן שוטף</button>' : ''}
    </div>`;

  let body;
  if (campaign) body = campaignGrid(campaign);
  else if (endpoint && state.planBackground) body = backgroundGrid(endpoint, content);
  else if (endpoint) body = campaignList(endpoint, campaigns, content);
  else body = endpointList(campaigns, content);

  $('#plan').innerHTML = crumbs + body;
  wirePlan(campaign, endpointId, content);
}

/** התוכן השוטף של נקודת קצה: לא שייך לקמפיין, רץ ברקע לאורך זמן */
const backgroundOf = (content, endpointId) =>
  content.filter((c) => !c.campaign_id && c.endpoint_id === endpointId);

/**
 * רשת התוכן השוטף. אין כאן תאריכים ואין מספר נדרש — זו ספרייה שהמנוע
 * שולף ממנה כשנשאר שטח, ולא תוכנית עם לוח זמנים.
 */
function backgroundGrid(endpoint, content) {
  const mine = backgroundOf(content, endpoint.id);
  const channels = state.channels.filter((c) => c.active);

  const head = channels.map((ch) => `<th>${esc(ch.name)}</th>`).join('');

  const rows = mine.map((item) => {
    const cells = channels.map((ch) => {
      const v = item.variants.find((x) => x.channel_id === ch.id) ?? null;
      const state_ = v ? v.status : 'empty';
      const st = CELL[state_];
      return `<td class="cell ${st.cls}" ${can('content')
        ? `data-bg-cell="${item.id}" data-ch="${ch.id}"` : ''}
        data-tt="${esc(ch.name)} · ${esc(st.label)}"><span>${st.label || '—'}</span></td>`;
    }).join('');

    const ready = item.variants.filter((v) => v.status === 'ready').length;
    return `<tr>
      <td class="angle" ${can('content') ? `data-bg-angle="${item.id}"` : ''}>
        <div class="aname">${esc(item.title)}</div>
        <div class="ameta">${esc(KIND_HE[item.kind])}
          ${item.evergreen ? `· ♻ כל ${item.reuse_after_days ?? '—'} ימים` : '· חד-פעמי'}
          ${item.placements ? `· שובץ ${item.placements}×` : ''}
          · מוכן ב-${ready} מדיות</div>
      </td>${cells}</tr>`;
  }).join('');

  return `
    <div class="cbhead">
      <div>
        <h2>תוכן ערך שוטף — ${esc(endpoint.name)}</h2>
        <p class="sub">רץ ברקע לאורך זמן, בלי קמפיין ובלי תאריכים.
          המנוע שולף ממנו כשנשאר שטח פנוי, ומכבד את המרווח בין חזרות.</p>
      </div>
      <div class="spacer"></div>
      ${can('content') ? '<button class="btn primary" id="addBackground">＋ זווית שוטפת</button>' : ''}
    </div>

    ${mine.length ? `<div class="board panel">
      <table class="grid cgrid">
        <thead><tr><th class="angle">זווית</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="sumline">כל שורה היא מסר קבוע, וכל עמודה הניסוח שלו למדיה.</div>`
    : '<div class="empty">אין עדיין תוכן שוטף לנקודה הזו.</div>'}`;
}

/** רמה 1: נקודות הקצה, עם סיכום הקמפיינים של כל אחת */
function endpointList(campaigns) {
  if (!state.endpoints.length) {
    return '<div class="empty">אין נקודות קצה. מוסיפים אותן בטאב "ניהול".</div>';
  }
  const cards = state.endpoints.map((e) => {
    const mine = campaigns.filter((c) => c.endpoint_id === e.id);
    // בקמפיין מוכן אין משבצות ריקות — מה שלא מוכן בו הוא טיוטות, לא חוסר
    const missing = mine.filter((c) => !c.complete).reduce((s, c) => s + c.missing_content, 0);
    const drafts = mine.filter((c) => c.complete).reduce((s, c) => s + c.missing_content, 0);
    const draftsLabel = drafts === 1 ? 'טיוטה אחת' : `${drafts} טיוטות`;
    const chip = missing
      ? `<span class="chip bad">חסרים ${missing}${drafts ? ` · ${draftsLabel}` : ''}</span>`
      : drafts ? `<span class="chip">${draftsLabel}</span>` : '<span class="chip on">מלא</span>';
    return `<button class="epick" data-pick-endpoint="${e.id}">
      <span class="nm"><i class="dot" style="background:${epColor(e.id)}"></i>${esc(e.name)}</span>
      <span class="sub">${mine.length} קמפיינים · חשיבות ${e.importance}</span>
      ${chip}
    </button>`;
  }).join('');
  return `<div class="eplist">${cards}</div>`;
}

/** רמה 2: הקמפיינים של נקודת הקצה */
function campaignList(endpoint, campaigns, content) {
  const mine = campaigns.filter((c) => c.endpoint_id === endpoint.id);
  const bg = backgroundOf(content, endpoint.id);
  const bgReady = bg.filter((c) => c.variants.some((v) => v.status === 'ready')).length;
  const group = (title, list, extra = '') => list.length || extra ? `
    <div class="setgroup" style="max-width:none">
      <h2>${esc(title)}</h2>
      <div class="panel">${extra}${list.map(campaignItem).join('')}</div>
    </div>` : '';

  // תוכן ערך שוטף מופיע רק אם נבחר ביצירת קמפיין ויש בו זוויות.
  // הוא תמיד רץ, ולכן יושב עם הקמפיינים שרצים עכשיו.
  const bgRow = bg.length ? `
    <div class="crow2" data-open-background>
      <div class="cinfo">
        <b>תוכן ערך שוטף</b>
        <span class="d">ללא תאריכים · ${bg.length} זוויות · ${bgReady} מוכנות לפחות במדיה אחת</span>
      </div>
      <span class="chip on">פעיל</span>
    </div>` : '';

  return `
    <div class="toolbar">
      <div class="legend">
        <span><b>${mine.filter((c) => c.phase === 'running').length}</b> רצים</span>
        <span>·</span>
        <span><b>${mine.filter((c) => c.phase === 'upcoming').length}</b> מתוכננים</span>
      </div>
      <div class="spacer"></div>
      ${can('settings') ? '<button class="btn primary" id="addCampaign">＋ קמפיין חדש</button>' : ''}
    </div>
    ${mine.length || bg.length ? '' : '<div class="empty">אין קמפיינים לנקודה הזו עדיין.</div>'}
    ${group('רצים עכשיו', mine.filter((c) => c.phase === 'running'), bgRow)}
    ${group('מתוכננים', mine.filter((c) => c.phase === 'upcoming'))}
    ${group('מושהים', mine.filter((c) => c.phase === 'paused'))}
    ${group('הסתיימו', mine.filter((c) => c.phase === 'ended' || c.phase === 'inactive'))}`;
}

function campaignItem(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';
  const pct = c.required ? Math.min(100, Math.round((c.ready / c.required) * 100)) : 0;

  return `<div class="crow2${c.paused_at ? ' paused' : ''}" data-open-campaign="${c.id}">
    <div class="cinfo">
      <b>${c.paused_at ? '⏸ ' : c.urgent ? '⚡ ' : ''}${esc(c.name)}</b>
      <span class="d">${esc(range)} · ${c.structure === 'general' ? 'כללי' : 'לפי זוויות'}</span>
    </div>
    <button class="chanpick" data-pick-channels="${c.id}"
      data-tt="לחיצה לבחירת המדיות של הקמפיין">
      ${c.channels.length
        ? c.channels.map((x) => `<i>${esc(x.name)}</i>`).join('')
        : '<i class="none">בחר מדיות</i>'}
    </button>
    <div class="abar" style="max-width:150px" data-tt="${c.ready} מתוך ${c.required} מוכנים">
      <div class="actual" style="width:${pct}%"></div>
    </div>
    <span class="chip ${TONE_CLASS[c.status.tone]}">${esc(c.status.label)}</span>
    ${can('settings') ? kebab('פעולות על הקמפיין', [
      `<button type="button" data-edit-campaign="${c.id}">ערוך</button>`,
      `<button type="button" data-toggle-pause="${c.id}" data-paused="${!!c.paused_at}">${
        c.paused_at ? 'חזרה לחיים' : 'השהה'}</button>`,
      `<button type="button" data-duplicate-campaign="${c.id}">שכפל</button>`,
    ]) : ''}
  </div>`;
}

/** כפתור שלוש נקודות ותפריט שנפתח ממנו למטה. items = כפתורים מוכנים. */
function kebab(label, items) {
  if (!items.length) return '';
  return `<span class="pmore">
    <button class="btn small kebab" data-kebab aria-label="${esc(label)}"
      aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" width="16" height="16"
      fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle
      cx="12" cy="19" r="1.6"/></svg></button>
    <div class="pmenu down" role="menu" hidden>${items.join('')}</div>
  </span>`;
}

/** פתיחה וסגירה של כל תפריטי שלוש הנקודות בתוך #plan — אחד פתוח בכל רגע */
function wireKebabs() {
  const closeAll = () => $$('#plan [data-kebab]').forEach((b) => {
    b.nextElementSibling.hidden = true;
    b.setAttribute('aria-expanded', 'false');
  });
  $$('#plan [data-kebab]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const open = menu.hidden;
      closeAll();
      if (!open) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // לחיצה בכל מקום אחר (כולל על פריט בתפריט) סוגרת אותו
      document.addEventListener('click', closeAll, { once: true });
    }));
  // פריט בתפריט שבתוך שורה לא פותח את השורה עצמה
  $$('#plan .pmenu').forEach((m) => m.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAll();
  }));
}

function wirePlan(campaign, endpointId, content) {
  const reload = run(async () => {
    await Promise.all([renderPlan(), refreshBoard(), refreshAlerts()]);
  });

  $$('#plan [data-crumb]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (b.dataset.crumb === 'root') { state.planEndpoint = null; state.planCampaign = null; }
      state.planCampaign = b.dataset.crumb === 'campaign' ? state.planCampaign : null;
      state.planBackground = false;
      await renderPlan();
    })));

  $('#plan [data-open-background]')?.addEventListener('click', run(async () => {
    state.planBackground = true;
    state.planCampaign = null;
    await renderPlan();
  }));

  $('#addBackground')?.addEventListener('click', () =>
    openAngleForm({ background: { endpoint_id: endpointId } }, reload));

  $$('#plan [data-bg-angle]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = content.find((x) => x.id === Number(b.dataset.bgAngle));
      openAngleForm({ item, background: { endpoint_id: endpointId } }, reload);
    }));

  $$('#plan [data-bg-cell]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = content.find((x) => x.id === Number(b.dataset.bgCell));
      openVariantForm({ item, channelId: Number(b.dataset.ch) }, reload);
    }));

  $$('#plan [data-pick-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      state.planEndpoint = Number(b.dataset.pickEndpoint);
      state.planCampaign = null;
      await renderPlan();
    })));

  $$('#plan [data-open-campaign]').forEach((el) =>
    el.addEventListener('click', run(async (e) => {
      if (e.target.closest('.pmore')) return;
      state.planCampaign = Number(el.dataset.openCampaign);
      await renderPlan();
    })));

  $$('#plan [data-edit-campaign]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.editCampaign));
      openCampaignForm(c, reload);
    }));

  $$('#plan [data-duplicate-campaign]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.duplicateCampaign));
      openCampaignForm(c, reload, null, { duplicate: true });
    }));

  wireKebabs();

  // בחירת מדיות ישירות מהשורה. קודם היא הייתה שדה אחד מתוך 14 בטופס העריכה.
  $$('#plan [data-pick-channels]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.pickChannels));
      openChannelPicker(c, reload);
    }));

  $$('#plan [data-toggle-pause]').forEach((b) =>
    b.addEventListener('click', run(async (e) => {
      e.stopPropagation();
      const paused = b.dataset.paused === 'true';
      // לפני הפעולה — כמה פוסטים זה מזיז, ובהחזרה גם כמה נמחקים
      const id = b.dataset.togglePause;
      const name = state.campaigns.find((x) => x.id === Number(id))?.name ?? 'הקמפיין';
      const imp = await api(`/campaigns/${id}/pause-impact`);
      const ok = paused
        ? await confirmDialog(`להחזיר את "${name}" לפעילות?\n` +
            (imp.resume.cleared
              ? `${imp.resume.cleared} פוסטים עתידיים שלא אושרו יימחקו, והמנוע ישבץ את הקמפיין מחדש במקומות פנויים.`
              : 'המנוע ישבץ את הקמפיין מחדש במקומות פנויים.') +
            (imp.resume.kept_approved
              ? `\n${imp.resume.kept_approved} פוסטים שאושרו לפרסום אוטומטי נשארים במקומם.` : ''),
            { okLabel: 'החזר לפעילות', danger: imp.resume.cleared > 0 })
        : await confirmDialog(`להשהות את "${name}"?\n` +
            (imp.pause.hidden
              ? `${imp.pause.hidden} פוסטים עתידיים יירדו מהלוח עד שהקמפיין יחזור לפעילות` +
                (imp.pause.approved ? ` (מתוכם ${imp.pause.approved} שאושרו לפרסום אוטומטי).` : '.')
              : 'אין לו פוסטים עתידיים על הלוח — המנוע פשוט יפסיק לשבץ ממנו.'),
            { okLabel: 'השהה' });
      if (!ok) return;
      const res = await api(`/campaigns/${id}/${paused ? 'resume' : 'pause'}`,
        { method: 'POST', body: { week: state.week } });
      if (paused) await import('../ui/engineDialog.js').then(({ engineToast }) => engineToast(res, 'הקמפיין חזר לפעול.' + (res.cleared ? ` ${res.cleared} פוסטים ישנים נוקו.` : '') + (res.engine?.placed || res.engine?.attached ? '' : ' המנוע ימקם אותו מחדש בפעם הבאה שיש מקום.')));
      else toast(`הקמפיין הושהה${res.held ? ` · ${res.held} שיבוצים ירדו מהלוח` : ''}.`);
      await reload();
    })));

  $('#addCampaign')?.addEventListener('click', () =>
    openCampaignForm(null, reload, endpointId));

  if (campaign) wireCampaignGrid(campaign, reload);
}

/**
 * עדכון קמפיין עם אזהרה שאפשר לאשר (הסרת מדיה שיש לה פוסטים בקמפיין
 * כללי). ביטול באישור משאיר את הטופס פתוח, בלי "נשמר".
 */
async function patchCampaign(id, body) {
  const res = await postWithGapCheck(`/campaigns/${id}`, body, 'PATCH', 'לשמור בכל זאת?');
  if (!res) throw new Error('השינוי לא נשמר');
  return res;
}

/** בחירת המדיות של קמפיין, בטופס אחד קצר במקום בתוך טופס העריכה המלא */
function openChannelPicker(campaign, reload) {
  if (!can('settings')) return toast('אין לך הרשאה לשנות את המדיות', true);

  openGeneric({
    title: `מדיות — ${campaign.name}`,
    fields: [
      { name: 'channel_ids', label: 'על אילו מדיות הקמפיין יושב', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: campaign.channels?.map((c) => c.id) },
    ],
    onSave: async (v) => {
      if (!v.channel_ids?.length) throw new Error('צריך לבחור לפחות מדיה אחת');
      v.week = state.week;
      await patchCampaign(campaign.id, v);
      await reload();
    },
  });
}

/**
 * duplicate: הטופס נפתח עם ההגדרות של campaign, והשמירה יוצרת קמפיין חדש
 * עם אותו תוכן (זוויות, ניסוחים וקבצים) — משנים רק את מה שצריך.
 */
function openCampaignForm(campaign, reload, defaultEndpoint, { duplicate = false } = {}) {
  const source = campaign;
  if (duplicate) campaign = { ...source, name: `${source.name} (עותק)` };
  const structure = campaign?.structure ?? 'general';
  // המבנה נקבע ברגע שנכנס תוכן — זוויות לא עוברות לרשימות של "כללי" ולהפך.
  // בשכפול המבנה תמיד של המקור (השרת לא מקבל אחר).
  const structureLocked = duplicate || !!campaign?.content?.length;
  // קמפיין מלפני השדה: התקופה מוסקת מהתאריכים (שבועות שלמים / חודש / ידני).
  // קמפיין ישן עם התחלה ובלי סוף נשאר "בלי תאריך סיום" — אחרת שמירה בלי
  // שינוי הייתה ממציאה לו סוף בשקט.
  const period = campaign?.period
    ?? (campaign?.starts_on && campaign?.ends_on
      ? inferPeriod(campaign.starts_on, campaign.ends_on)
      : campaign?.starts_on && structure !== 'general' ? 'open' : '1m');

  openGeneric({
    title: duplicate ? `שכפול: ${source.name}` : campaign ? 'עריכת קמפיין' : 'קמפיין חדש',
    saveLabel: duplicate ? 'שכפל' : undefined,
    fields: [
      // תוכן ערך שוטף אינו קמפיין אמיתי — זווית בלי קמפיין שהמנוע שולף ממנה
      // כשנשאר שטח. נבחר כאן רק כדי שיהיה מקום אחד ליצירה של שני הסוגים.
      ...(campaign ? [] : [{ name: 'ctype', label: 'סוג', type: 'select',
        options: [['dated', 'קמפיין עם תאריכים'],
          ['background', 'תוכן ערך שוטף — בלי תאריכים, רץ ברקע כשנשאר שטח']],
        value: 'dated' }]),
      { name: 'name', label: 'שם הקמפיין', type: 'text', value: campaign?.name },
      { name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]),
        value: campaign?.endpoint_id ?? defaultEndpoint },
      { name: 'goal', label: 'מה המטרה', type: 'text', value: campaign?.goal },
      { name: 'starts_on', label: 'תאריך יעד לפוסט הראשון', type: 'date',
        value: campaign?.starts_on },
      { name: 'period', label: 'תקופת הקמפיין', type: 'period', start: 'starts_on',
        value: period, ends_on: campaign?.ends_on },
      { name: 'channel_ids', label: 'על אילו מדיות הקמפיין יושב', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: campaign?.channels?.map((c) => c.id) },
      { name: 'structure', label: 'מבנה התוכן', type: 'radio', value: structure,
        options: [['general', 'כללי'], ['angles', 'לפי זוויות']],
        disabled: structureLocked,
        hint: structureLocked
          ? 'כבר יש לקמפיין תוכן, ולכן המבנה קבוע. אפשר לשנות אותו רק כשהקמפיין ריק.'
          : 'כללי — לכל מדיה רשימת פוסטים משלה. לפי זוויות — כל מסר נכתב בניסוח לכל אחת מהמדיות.' },
      { name: 'importance', label: 'חשיבות (1–10)', type: 'number',
        value: campaign?.importance ?? 5,
        hint: 'זה מה שקובע כמה שטח מגיע לקמפיין. השאר את הנתח על "אוטומטי".' },
      { name: 'share_pct', label: 'נתח מהשטח', type: 'auto',
        value: campaign?.share_pct,
        auto: campaign?.share_auto != null ? `${campaign.share_auto}%` : 'לפי החשיבות',
        placeholder: '%',
        hint: 'אוטומטי מחלק את השטח לפי החשיבות מול הקמפיינים שרצים במקביל. ' +
              'קבוע נועד למקרה שהובטח לקמפיין נתח מסוים בלי קשר לשאר.' },
      // רלוונטי רק בזוויות — בכללי כל מדיה מקבלת את מספר הפוסטים שלה
      { name: 'target_posts', label: 'מספר זוויות', type: 'auto',
        value: campaign?.target_posts, hidden: structure === 'general',
        auto: campaign?.angles_auto != null ? String(campaign.angles_auto) : 'לפי המדיות',
        hint: 'אוטומטי נגזר מהקצב של המדיות שנבחרו ומאורך הקמפיין.' },
      { name: 'urgent', label: 'קמפיין דחוף', type: 'checkbox', value: campaign?.urgent },
    ],
    extraActions: campaign && !duplicate && can('settings')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק קמפיין</button>'
      : '',
    onSave: async (v) => {
      if (v.ctype === 'background') {
        if (!v.endpoint_id) throw new Error('צריך לבחור נקודת קצה');
        state.planEndpoint = v.endpoint_id;
        state.planCampaign = null;
        state.planBackground = true;
        await reload();
        return 'מוסיפים זוויות בכפתור "＋ זווית שוטפת".';
      }
      delete v.ctype;
      if ((v.structure ?? structure) === 'general' && !v.starts_on) {
        throw new Error('בקמפיין כללי צריך תאריך יעד לפוסט הראשון — ממנו נפרסים הפוסטים');
      }
      // בלי תאריך לפוסט הראשון אין ממה לחשב סיום — הקמפיין נשמר בלי תאריכים
      if (!v.starts_on && v.period !== 'custom') delete v.period;
      if (v.period !== 'custom') delete v.ends_on;
      v.week = state.week;
      if (duplicate) {
        const res = await api(`/campaigns/${source.id}/duplicate`, { method: 'POST', body: v });
        state.planCampaign = res.campaign.id;
        await reload();
        return `הקמפיין שוכפל עם ${res.copied.items} ${structure === 'general' ? 'פוסטים' : 'זוויות'}.`;
      }
      if (campaign) await patchCampaign(campaign.id, v);
      else await api('/campaigns', { method: 'POST', body: v });
      await reload();
    },
    onOpen: () => {
      $$('#genBody [name="gen_structure"]').forEach((r) =>
        r.addEventListener('change', () => {
          $('#genBody [data-field="target_posts"]').hidden = r.value === 'general';
        }));
      $('#genDelete')?.addEventListener('click', run(async () => {
        if (await deleteCampaign(campaign, reload)) $('#genDlg').close();
      }));
      // בתוכן שוטף אין שם, תאריכים או נתח — נשארת רק נקודת הקצה
      const type = $('#gen_ctype');
      type?.addEventListener('change', () => {
        const bg = type.value === 'background';
        $$('#genBody .frow').forEach((row) => {
          if (row.contains(type) || row.contains($('#gen_endpoint_id'))) return;
          row.hidden = bg;
        });
      });
    },
  });
}

/* ========================= תוכן ========================= */


/** כותרת הקמפיין במסך התוכן — משותפת לזוויות, לכללי ולמצבים הריקים */
function campaignHead(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';
  return `
    <div class="cbhead">
      <div>
        <div class="ctitle">
          <h2>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</h2>
          ${c.complete ? `<span class="gst ok" data-tt="סומן מוכן: רק התוכן שנכתב, פרוס על התקופה">
            <i></i>מוכן</span>` : ''}
        </div>
        <p class="sub">${esc(c.endpoint_name)} · ${esc(range)}
          · נתח ${c.share_pct != null ? c.share_pct + '%' : 'נגזר מהמשקל'}
          ${c.goal ? `· ${esc(c.goal)}` : ''}</p>
      </div>
      <div class="spacer"></div>
      ${campaignMenu(c)}
      ${c.required ? fillLine(c) : ''}
    </div>`;
}

/**
 * מצב המילוי בכותרת: מוכנים · טיוטות · לא נכתבו, מתוך הנדרש. אותן הגדרות
 * בשני המבנים — טיוטה היא עוד לא מוכנה, ו"לא נכתבו" הם תאים/משבצות ריקים.
 */
function fillLine(c) {
  const empty = c.missing_content - (c.drafts ?? 0);
  return `<div class="fill hstats">
    <span class="gst ok"><i></i>${c.ready} מוכנים</span>
    ${c.drafts ? `<span class="gst draft"><i></i>${c.drafts} טיוטות</span>` : ''}
    ${empty > 0 ? `<span class="gst gap"><i></i>${empty} לא נכתבו</span>` : ''}
    <span class="of">מתוך ${c.required}</span>
  </div>`;
}

function campaignGrid(c) {
  if (!c.channels.length) {
    return `${campaignHead(c)}<div class="panel"><div class="empty">
      לקמפיין הזה לא נבחרו מדיות, ולכן אין ממה לגזור כמה תוכן הוא צריך.
      ${can('settings') ? `<div style="margin-top:14px">
        <button class="btn primary" data-pick-channels="${c.id}">בחירת מדיות</button></div>` : ''}
    </div></div>`;
  }
  const empty = c.structure === 'general' ? !c.slots.length : !c.grid.length;
  if (empty) {
    return `${campaignHead(c)}<div class="panel"><div class="empty">
      לקמפיין אין תאריכים, ולכן אין ממה לגזור כמה תוכן הוא צריך.
      ${can('settings') ? 'קובעים אותם ב"ערוך קמפיין" — תאריך לפוסט הראשון ותקופה.' : ''}
    </div></div>`;
  }
  if (c.structure === 'general') return generalBoard(c);

  const head = c.channels.map((ch) =>
    `<th>${esc(ch.name)}<div class="need">${c.needs[ch.id] ?? 0} פוסטים</div></th>`).join('');

  const rows = c.grid.map((row) => {
    const item = row.content;
    const angle = item
      ? `<div class="aname">${esc(item.title)}</div>
         <div class="ameta">${esc(KIND_HE[item.kind])}${
           item.evergreen ? ' · ♻' : ''}${
           item.assets.length ? ` · 📎${item.assets.length}` : ''}</div>`
      : `<div class="aname muted">${row.past ? 'זווית שלא נכתבה' : 'זווית חדשה'}</div>`;

    const cells = c.channels.map((ch) => {
      const cell = row.cells.find((x) => x.channel_id === ch.id);
      const st = CELL[cell.state];
      // בקמפיין מוכן תא בלי גרסה לא נדרש, אבל אפשר לפתוח אותו ולהוסיף גרסה
      const clickable = can('content') && (cell.state !== 'not_needed' || c.complete);
      return `<td class="cell ${st.cls}"
        ${clickable ? `data-cell="${row.index}" data-ch="${ch.id}"` : ''}
        ${clickable ? `data-tt="${esc(ch.name)} · ${esc(st.label)}"` : ''}>
        <span>${st.label || '—'}</span></td>`;
    }).join('');

    return `<tr class="${row.past ? 'past' : ''}">
      <td class="angle" ${can('content') ? `data-angle="${row.index}"` : ''}>
        <div class="anum">${row.index}<span>${fmtDate(row.date)}</span></div>
        ${angle}
      </td>${cells}</tr>`;
  }).join('');

  return `
    ${campaignHead(c)}

    <div class="board panel">
      <table class="grid cgrid">
        <thead><tr><th class="angle">זווית</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${completeLine(c)}
    <div class="sumline">
      כל שורה היא מסר אחד, וכל עמודה היא הניסוח שלו למדיה. לחיצה על תא פותחת את הטקסט לאותה מדיה.
    </div>`;
}


/** שורת הסבר מתחת לרשת של קמפיין שסומן מוכן */
function completeLine(c) {
  if (!c.complete) return '';
  return `<div class="sumline">הקמפיין סומן מוכן: רק מה שנכתב, פרוס על התקופה.
    תוכן שנוסף עכשיו נכנס בסוף ומגדיל אותו. ${can('settings')
      ? 'להחזרת המשבצות הריקות — "פתח מחדש להשלמת תוכן" בתפריט.' : ''}</div>`;
}

/* ---------- קמפיין כללי: רשימת פוסטים לכל מדיה, בלי זוויות ---------- */

/* ---------- משבצות מקושרות: שתי מדיות, תוכן אחד (src/links.js) ---------- */

/** אייקון קו של קישור — הסימן של משבצת מקושרת */
const LINK_ICON = `<svg class="lnk" viewBox="0 0 24 24" width="13" height="13" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="m10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/>
  <path d="m14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>`;

/**
 * מצב "בחירת משבצת לקישור" על הלוח של קמפיין כללי, או null.
 * {campaignId, itemId (המשבצת שנלחצה), rootId, rootChannelId, title, label}
 */
let linkMode = null;

/** המשבצות שחולקות תוכן עם item (בלי item עצמו), לפי סדר המדיות בקמפיין */
function linkPartners(c, item) {
  if (!item) return [];
  const rootId = item.linked_to_id ?? item.id;
  const order = (x) => c.channels.findIndex((ch) => ch.id === x.slot_channel_id);
  return c.content
    .filter((x) => x.id !== item.id && (x.id === rootId || x.linked_to_id === rootId))
    .sort((a, b) => order(a) - order(b));
}

const channelName = (id) => state.channels.find((ch) => ch.id === id)?.name ?? 'מדיה';
/** "יוטיוב שורטס #2" — משבצת בקמפיין כללי */
const slotLabel = (x) => `${channelName(x.slot_channel_id)} #${x.sort_order}`;

/** שורת "מקושר ל:" מתחת לכותרת המשבצת בלוח */
function linkLine(c, item) {
  const partners = linkPartners(c, item);
  if (!partners.length) return '';
  const names = partners.map(slotLabel).join(', ');
  return `<span class="glink" data-tt="${esc(`התוכן משותף עם ${names}`)}">${LINK_ICON}
    <span>מקושר ל: ${esc(names)}</span></span>`;
}

/**
 * במצב קישור: האם אפשר לבחור את המשבצת הזו כיעד, ואם לא — למה (לעמודה).
 * מדיה של המקור, ניוזלטר ומדיה שכבר יש בה משבצת מקושרת למקור — כל העמודה
 * סגורה. בעמודה פתוחה: משבצת ריקה, או משבצת עם תוכן שלא מקושרת לשום דבר.
 */
function columnBlock(c, channelId) {
  if (channelId === linkMode.rootChannelId) return 'המדיה של הפוסט';
  const ch = state.channels.find((x) => x.id === channelId);
  if (ch?.platform === 'newsletter') return 'ניוזלטר לא מתקשר';
  const sibling = c.content.find((x) =>
    x.linked_to_id === linkMode.rootId && x.slot_channel_id === channelId);
  return sibling ? `כבר מקושר: #${sibling.sort_order}` : null;
}
const slotPickable = (c, item) => !item ||
  (!item.linked_to_id && !c.content.some((x) => x.linked_to_id === item.id));

function exitLinkMode() {
  linkMode = null;
  linkReload = null;
  document.removeEventListener('keydown', onLinkKey);
}

/** יציאה ממסך התוכן (מעבר טאב) — מצב הקישור לא נשאר תלוי ברקע */
export function leavePlanView() {
  if (linkMode) exitLinkMode();
}

/** מצב הקישור, רק כשעדיין עומדים על הקמפיין שבו התחיל; אחרת הוא מתבטל */
function activeLinkMode() {
  if (linkMode && (state.tab !== 'plan' || state.planCampaign !== linkMode.campaignId)) {
    exitLinkMode();
  }
  return linkMode;
}

let linkReload = null;
function onLinkKey(e) {
  if (!activeLinkMode()) return;
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  const reload = linkReload;
  exitLinkMode();
  reload?.();
}

/** נכנסים למצב קישור מטופס המשבצת: הטופס נסגר והלוח מסמן את היעדים */
function enterLinkMode(campaign, item, reload) {
  const rootId = item.linked_to_id ?? item.id;
  const root = campaign.content.find((x) => x.id === rootId) ?? item;
  linkMode = {
    campaignId: campaign.id, itemId: item.id, rootId, rootChannelId: root.slot_channel_id,
    title: root.title, label: slotLabel(root),
  };
  linkReload = reload;
  document.addEventListener('keydown', onLinkKey);
  reload();
}

/** הקישור עצמו, אחרי לחיצה על משבצת יעד בלוח */
async function linkTo(campaign, channelId, index, item, reload) {
  const body = { target_campaign_slot: { channel_id: channelId, sort_order: index }, week: state.week };
  // משבצת חד-פעמית שכבר פורסמה לא תשובץ שוב — התוכן המקושר לא ייצא בה
  const published = item && !item.evergreen && item.posts?.some((p) => p.status === 'published');
  const replaceQuestion = `התוכן הקיים במשבצת יוחלף בתוכן של "${linkMode.title}" ` +
    `(${linkMode.label}) — הטקסט, הקבצים והמצב.` +
    (published ? ' המשבצת הזו כבר פורסמה — התוכן המקושר לא ישובץ בה שוב.' : '') + ' להמשיך?';
  if (item) {
    if (!(await confirmDialog(replaceQuestion, { okLabel: 'קשר והחלף', danger: true }))) return;
    body.replace = true;
  }
  const path = `/content/${linkMode.itemId}/link`;
  try {
    await api(path, { method: 'POST', body });
  } catch (e) {
    // מישהו מילא את המשבצת בינתיים — אותה שאלה, ושוב עם אישור
    if (e.status !== 409 || !e.payload?.needs_confirm) throw e;
    if (!(await confirmDialog(replaceQuestion, { okLabel: 'קשר והחלף', danger: true }))) return;
    await api(path, { method: 'POST', body: { ...body, replace: true } });
  }
  const done = `${linkMode.label} ו${channelName(channelId)} #${index} מקושרות — תוכן אחד, כל אחת במועד של המדיה שלה.`;
  exitLinkMode();
  toast(done);
  await reload();
}

/** הבר שמעל הלוח במצב קישור — הסבר וביטול (לא כפתור צף) */
const linkBar = () => `
  <div class="linkbar panel" role="status">
    ${LINK_ICON}
    <div>
      <b>בוחרים משבצת במדיה אחרת</b>
      <span class="d">היא תחלוק עם ${esc(linkMode.label)} את הטקסט, הקבצים והמצב.
        כל משבצת תצא במועד של המדיה שלה. Esc לביטול.</span>
    </div>
    <button class="btn small" id="linkCancel">ביטול</button>
  </div>`;

/**
 * עמודה לכל מדיה, ובה שורה לכל פוסט שהמדיה צריכה. כל שורה עומדת בפני
 * עצמה: אין זווית משותפת ואין ניסוח למדיה אחרת. במסך צר העמודות נערמות.
 */
function generalBoard(c) {
  // מצב קישור שייך לקמפיין שבו התחיל; מעבר לקמפיין או לטאב אחר מבטל אותו
  const linking = !!activeLinkMode() && linkMode.campaignId === c.id && can('content');

  const cols = c.slots.map((col) => {
    const blocked = linking ? columnBlock(c, col.channel_id) : null;
    // משבצת מעבר לצורך מוצגת רק כשיש בה פוסט — ריקה כזו לא חסרה לאף אחד
    const rows = col.slots.filter((s) => !s.extra || s.content).map((s) => {
      const st = CELL[s.state];
      const item = s.content;
      const pick = linking ? (!blocked && slotPickable(c, item) ? ' pick' : ' nopick') : '';
      return `<li class="gslot${s.past ? ' past' : ''}${s.extra ? ' extra' : ''}${
          can('content') ? '' : ' ro'}${pick}"
        ${can('content') ? `data-gslot="${s.index}" data-ch="${col.channel_id}"` : ''}>
        <span class="gnum">${s.index}</span>
        <span class="gdate">${s.date ? fmtDate(s.date) : 'נוסף'}</span>
        <span class="gttl${item ? '' : ' none'}">${item
          ? `<span class="gt">${esc(item.title)}${item.assets.length
              ? ` <span class="gclip">📎${item.assets.length}</span>` : ''}</span>${linkLine(c, item)}`
          : (s.past ? 'לא נכתב' : 'לכתוב')}</span>
        <span class="gst ${st.cls}"><i></i>${esc(st.label)}</span>
      </li>`;
    }).join('');

    return `<section class="gcol panel${blocked ? ' blocked' : ''}">
      <div class="gcol-head">
        <div>
          <b>${esc(col.channel_name)}</b>
          <span class="d">${blocked ? esc(blocked) : `${col.ready} מתוך ${col.required} מוכנים`}</span>
        </div>
        ${can('content') && !linking
          ? `<button class="btn small" data-gbulk="${col.channel_id}">העלאה מרוכזת</button>` : ''}
      </div>
      <ol class="gslots">${rows}</ol>
    </section>`;
  }).join('');

  return `
    ${campaignHead(c)}
    ${linking ? linkBar() : ''}
    <div class="gboard${linking ? ' linking' : ''}">${cols}</div>
    ${completeLine(c)}
    ${c.orphaned ? `<div class="sumline">
      <span class="off">${c.orphaned === 1 ? 'פוסט אחד' : `${c.orphaned} פוסטים`} במדיות שהוסרו מהקמפיין</span> —
      נשמרים ולא משובצים. החזרת המדיה לקמפיין מחזירה אותם.</div>` : ''}
    <div class="sumline">
      כל עמודה היא מדיה, וכל שורה בה פוסט אחד שעומד בפני עצמו. לחיצה על שורה פותחת את התוכן שלה.
      ייבוא מטבלה זמין בקמפיין לפי זוויות.
    </div>`;
}

function wireGeneralBoard(selected, reload) {
  $$('#plan [data-gslot]').forEach((b) =>
    b.addEventListener('click', () => {
      const channelId = Number(b.dataset.ch);
      const index = Number(b.dataset.gslot);
      const item = selected.content.find((x) =>
        x.slot_channel_id === channelId && x.sort_order === index) ?? null;
      // במצב קישור הלחיצה בוחרת יעד; משבצת שלא אפשרית — לא עושה כלום
      if (activeLinkMode()) {
        if (b.classList.contains('pick')) run(() => linkTo(selected, channelId, index, item, reload))();
        else toast('בוחרים אחת מהמשבצות המסומנות — במדיה אחרת, ריקה או לא מקושרת.');
        return;
      }
      openSlotForm({ campaign: selected, channelId, index, item }, reload);
    }));

  $('#linkCancel')?.addEventListener('click', () => {
    exitLinkMode();
    reload();
  });

  $$('#plan [data-gbulk]').forEach((b) =>
    b.addEventListener('click', () => {
      const channel = selected.channels.find((x) => x.id === Number(b.dataset.gbulk));
      openChannelBulk(selected, channel, reload);
    }));
}

/**
 * פוסט במשבצת של קמפיין כללי: טופס אחד פשוט. מתחת לפני השטח — פריט תוכן
 * וגרסה אחת שלו לאותה מדיה (השרת שומר את הטקסט והמצב על שניהם).
 */
function openSlotForm({ campaign, channelId, index, item }, reload) {
  const channel = state.channels.find((c) => c.id === channelId);
  const v = item?.variants.find((x) => x.channel_id === channelId) ?? null;
  // ניוזלטר: הנושא, התבנית והתוכן נערכים בעורך המייל הקיים (בלעדיהם אי אפשר
  // לשלוח). כאן רק הכותרת והסוג — והשמירה ממשיכה ישר לעורך.
  const mail = channel?.platform === 'newsletter';
  // לפריט של מדיה אחת אין "משותף" מול "של המדיה" — כל הקבצים שלו, וכולם ניתנים להסרה
  const files = [...(item?.assets ?? []), ...(item?.variant_assets ?? [])]
    .map((a) => assetLine(a, true, false)).join('');
  // משבצת מקושרת: שורת "מקושר ל:" בראש הטופס, עם ניתוק לכל משבצת
  const partners = linkPartners(campaign, item);
  // אפשר לקשר כשיש בקמפיין עוד מדיה שאינה ניוזלטר
  const canLink = item && !mail && can('content') && campaign.channels.some((ch) =>
    ch.id !== channelId && ch.platform !== 'newsletter');

  openGeneric({
    title: `${channel?.name ?? ''} · פוסט ${index}${item ? '' : ' — חדש'}`,
    saveLabel: mail ? 'שמור והמשך לעריכת המייל' : undefined,
    fields: [
      ...(partners.length ? [{ name: '__link', type: 'html', html: linkInfo(item, partners) }] : []),
      { name: 'title', label: mail ? 'כותרת (פנימית — הנושא נכתב בעורך המייל)' : 'כותרת',
        type: 'text', value: item?.title },
      { name: 'kind', label: 'סוג', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']],
        value: item?.kind },
      ...(mail ? [] : [
        { name: 'body', label: `הטקסט כפי שהוא ייצא ב${channel?.name ?? 'מדיה'}`,
          type: 'textarea', value: v?.body ?? item?.body },
        { name: '__files', label: 'תמונות, סרטונים ומסמכים', type: 'files', existing: files },
        { name: 'status', label: 'מצב', type: 'radio',
          options: [['draft', 'טיוטה'], ['ready', 'מוכן לפרסום']],
          value: v?.status === 'ready' ? 'ready' : 'draft' },
      ]),
    ],
    extraActions: (item && can('content')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק פוסט</button>'
      : '') + (canLink ? '<button class="btn" id="genLink">קשר למשבצת אחרת</button>' : ''),
    onSave: async (val) => {
      if (!val.title) throw new Error('צריך כותרת');
      const body = mail
        ? { title: val.title, kind: val.kind, week: state.week }
        : { title: val.title, kind: val.kind, body: val.body ?? '',
            status: val.status, week: state.week };
      const saved = item
        ? (await api(`/content/${item.id}`, { method: 'PATCH', body })).content
        : (await api('/content', { method: 'POST', body: {
          ...body, campaign_id: campaign.id, slot_channel_id: channelId, sort_order: index,
        } })).content;

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        await uploadFiles(saved.id, picked, {
          onProgress: progressList($('#gen___files_progress'), picked),
        });
      }
      await reload();
      if (mail) {
        // הפריט הטרי (עם הגרסה שלו) — אחרי הרענון. העורך נפתח רק אחרי שהטופס
        // הזה נסגר: שניהם משתמשים באותו דיאלוג.
        const fresh = state.campaigns.find((c) => c.id === campaign.id);
        const freshItem = fresh?.content.find((x) => x.id === saved.id);
        if (freshItem) {
          setTimeout(() => openVariantForm({ item: freshItem, channelId, campaign: fresh }, reload));
        }
        return 'נשמר — ממשיכים לנושא ולתוכן של המייל.';
      }
    },
    onOpen: () => {
      wireCopyLinks($('#genBody'));
      $$('#genBody [data-del-asset]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/assets/${b.dataset.delAsset}`, { method: 'DELETE' });
          b.closest('.fileline').remove();
          toast('הקובץ הוסר.');
        })));
      $('#genDelete')?.addEventListener('click', run(async () => {
        const names = partners.map(slotLabel).join(', ');
        const question = !partners.length ? 'למחוק את הפוסט הזה?'
          : item.linked_to_id
            ? `למחוק את הפוסט הזה? רק המשבצת הזו נמחקת — התוכן נשאר ב${names}.`
            : `למחוק את הפוסט הזה? המשבצות המקושרות (${names}) יישארו עם עותק משלהן של התוכן.`;
        if (!(await confirmDialog(question, { danger: true }))) return;
        await api(`/content/${item.id}`, { method: 'DELETE', body: { week: state.week } });
        $('#genDlg').close();
        await reload();
      }));
      $('#genLink')?.addEventListener('click', () => {
        $('#genDlg').close();
        enterLinkMode(campaign, item, reload);
      });
      $$('#genBody [data-unlink]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/content/${b.dataset.unlink}/unlink`, { method: 'POST', body: { week: state.week } });
          $('#genDlg').close();
          toast('הקישור נותק — לכל משבצת עותק משלה של התוכן.');
          await reload();
        })));
    },
  });
}

/**
 * ראש טופס המשבצת כשהיא מקושרת: עם מי, מה זה אומר, וניתוק לכל משבצת.
 * ניתוק של עוקבת = היא בלבד; כשהטופס הוא של עוקבת, השורה של המקור מנתקת
 * אותה עצמה.
 */
function linkInfo(item, partners) {
  const names = partners.map(slotLabel).join(', ');
  const rows = partners.map((p) => `
    <div class="li-row">
      <span>${esc(channelName(p.slot_channel_id))} · פוסט ${p.sort_order}</span>
      ${can('content') ? `<button type="button" class="btn small"
        data-unlink="${p.linked_to_id ? p.id : item.id}">נתק קישור</button>` : ''}
    </div>`).join('');
  return `<div class="linkinfo">
    <div class="li-head">${LINK_ICON}<b>מקושר ל: ${esc(names)}</b></div>
    <p class="d">הטקסט, הקבצים והמצב משותפים — שמירה כאן מעדכנת גם את ${esc(names)}.
      כל משבצת יוצאת במועד של המדיה שלה.</p>
    ${rows}
  </div>`;
}

/** העלאה מרוכזת לעמודה של מדיה אחת: כל קובץ ממלא את הפוסט הפנוי הבא שלה */
function openChannelBulk(campaign, channel, reload) {
  openGeneric({
    title: `העלאה מרוכזת · ${channel.name}`,
    saveLabel: 'העלה',
    fields: [
      { name: 'kind', label: 'סוג הפוסטים', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']], value: 'value' },
      { name: '__files', label: `קבצים — כל קובץ ממלא את הפוסט הפנוי הבא ב${channel.name}, כטיוטה`,
        type: 'files' },
    ],
    onSave: async (v) => {
      const files = [...($('#gen___files')?.files ?? [])];
      if (!files.length) throw new Error('צריך לבחור לפחות קובץ אחד');
      const data = await uploadBulk(campaign.id, files, {
        kind: v.kind, channelId: channel.id,
        onProgress: progressList($('#gen___files_progress'), files),
      });
      await reload();
      return data.overflow
        ? `נוספו ${data.created.length} פוסטים — ${data.overflow} מעבר למה שהמדיה צריכה.`
        : `נוספו ${data.created.length} פוסטים.`;
    },
  });
}

function wireCampaignGrid(selected, reload) {
  // תפריט הכותרת משותף לשני המבנים — מחווטים לפני הפיצול
  const actions = {
    edit: () => openCampaignForm(selected, reload),
    bulk: () => openBulkUpload(selected, reload),
    import: () => openImport(selected, reload),
    complete: run(() => completeCampaign(selected, reload)),
    reopen: run(() => reopenCampaign(selected, reload)),
    delete: run(() => deleteCampaign(selected, reload)),
  };
  $$('#plan .cbhead [data-act]').forEach((b) =>
    b.addEventListener('click', () => actions[b.dataset.act]()));

  if (selected.structure === 'general') return wireGeneralBoard(selected, reload);

  // לחיצה על הזווית עצמה — עריכת המסר, הסוג והקבצים
  $$('#plan [data-angle]').forEach((b) =>
    b.addEventListener('click', () => {
      const idx = Number(b.dataset.angle);
      const item = selected.content.find((x) => x.sort_order === idx) ?? null;
      openAngleForm({ item, campaign: selected, slot: idx }, reload);
    }));

  // לחיצה על תא — הניסוח של הזווית הזו למדיה הזו
  $$('#plan [data-cell]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(b.dataset.cell);
      const channelId = Number(b.dataset.ch);
      const item = selected.content.find((x) => x.sort_order === idx) ?? null;
      if (!item) {
        toast('צריך קודם לכתוב את הזווית — לוחצים על העמודה הראשונה.', true);
        return;
      }
      openVariantForm({ item, channelId, campaign: selected }, reload);
    }));

}

/** תפריט שלוש הנקודות בכותרת הקמפיין — כל הפעולות על הקמפיין עצמו */
function campaignMenu(c) {
  // בקמפיין כללי ההעלאה המרוכזת היא לכל מדיה (בראש העמודה), וייבוא מטבלה לא נתמך
  const angles = c.structure !== 'general';
  const items = [
    can('settings') && '<button type="button" data-act="edit">ערוך קמפיין</button>',
    angles && can('content') && '<button type="button" data-act="bulk">העלאה מרוכזת</button>',
    angles && can('content') && '<button type="button" data-act="import">ייבוא מטבלה</button>',
    // "קמפיין מוכן": רק כשיש מה להשאיר ועל מה לפרוס
    can('settings') && !c.content_complete_at && c.content.length && c.starts_on && c.ends_on &&
      '<button type="button" data-act="complete">קמפיין מוכן</button>',
    can('settings') && c.content_complete_at &&
      '<button type="button" data-act="reopen">פתח מחדש להשלמת תוכן</button>',
    can('settings') && '<div class="sep"></div><button type="button" data-act="delete" data-danger>מחק קמפיין</button>',
  ].filter(Boolean);
  return kebab('פעולות על הקמפיין', items);
}

/**
 * "קמפיין מוכן": הקמפיין מצטמצם לתוכן שקיים (גם טיוטות) והפוסטים נפרסים
 * על אותה תקופה. קודם תקציר מהשרת — מה יורד ומה נשאר — ורק אז הסימון.
 */
async function completeCampaign(campaign, reload) {
  const { summary: s } = await api(`/campaigns/${campaign.id}/complete-preview`);
  const perChannel = campaign.channels
    .filter((ch) => s.kept_by_channel[ch.id])
    .map((ch) => `${ch.name} ${s.kept_by_channel[ch.id]}`).join(' · ');
  const lines = [
    s.removed_empty === 0 ? 'אין משבצות ריקות להסיר.'
      : s.removed_empty === 1 ? 'תוסר משבצת ריקה אחת.'
      : `יוסרו ${s.removed_empty} משבצות ריקות.`,
    `${s.posts === 1 ? 'פוסט אחד ייפרס' : `${s.posts} פוסטים ייפרסו`} על התקופה ` +
      `(${fmtDate(s.starts_on)}–${fmtDate(s.ends_on)}): ${perChannel}.`,
    s.drafts === 1 ? 'אחד מהם טיוטה — הוא ייצא רק אחרי שיסומן מוכן.'
      : s.drafts > 1 ? `${s.drafts} מהם טיוטות — הם ייצאו רק אחרי שיסומנו מוכנים.` : '',
  ].filter(Boolean);
  const ok = await confirmDialog(`לסמן את "${campaign.name}" כמוכן?\n\n${lines.join('\n')}`,
    { okLabel: 'קמפיין מוכן' });
  if (!ok) return;
  await api(`/campaigns/${campaign.id}/complete`, { method: 'POST', body: { week: state.week } });
  toast('הקמפיין סומן מוכן — הפוסטים נפרסו על התקופה.');
  await reload();
}

/** חזרה להקצאה לפי הקצב: המשבצות הריקות חוזרות, התוכן לא משתנה */
async function reopenCampaign(campaign, reload) {
  await api(`/campaigns/${campaign.id}/reopen`, { method: 'POST', body: { week: state.week } });
  toast('הקמפיין נפתח מחדש — המשבצות הריקות חזרו.');
  await reload();
}

async function deleteCampaign(campaign, reload) {
  if (!(await confirmDialog('למחוק את הקמפיין? התוכן שלו יישאר, רק ינותק ממנו.', { danger: true }))) return false;
  await api(`/campaigns/${campaign.id}`, { method: 'DELETE', body: { week: state.week } });
  state.planCampaign = null;
  await reload();
  return true;
}

/** העלאה מרוכזת: כל קובץ הופך לזווית, ונפתחות לה טיוטות לכל מדיה של הקמפיין */
function openBulkUpload(campaign, reload) {
  openGeneric({
    title: `העלאה מרוכזת · ${campaign.name}`,
    saveLabel: 'העלה',
    fields: [
      { name: 'kind', label: 'סוג הזוויות', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']], value: 'value' },
      { name: '__files', label: 'קבצים — כל קובץ הופך לזווית חדשה, עם טיוטה לכל מדיה של הקמפיין',
        type: 'files' },
    ],
    onSave: async (v) => {
      const files = [...($('#gen___files')?.files ?? [])];
      if (!files.length) throw new Error('צריך לבחור לפחות קובץ אחד');
      const data = await uploadBulk(campaign.id, files, {
        kind: v.kind,
        onProgress: progressList($('#gen___files_progress'), files),
      });
      await reload();
      return `נוצרו ${data.created.length} זוויות.`;
    },
  });
}

/** הזווית: המסר עצמו, הסוג, הקבצים המשותפים */
function openAngleForm({ item, campaign, slot, background }, reload) {
  // קמפיין כללי לא מקבל זוויות — אין להן מקום ברשימות שלו
  const campaignOptions = [['', 'ללא קמפיין — תוכן שוטף'],
    ...state.campaigns
      .filter((c) => c.structure !== 'general' || c.id === item?.campaign_id)
      .map((c) => [c.id, c.name])];
  const inCampaign = !!(campaign?.id ?? item?.campaign_id);
  const owner = state.campaigns.find((c) => c.id === (campaign?.id ?? item?.campaign_id));
  // תוכן שוטף: אין קמפיין לרשת ממנו נקודת קצה, אז היא נלקחת מההקשר
  const bgEndpoint = background?.endpoint_id;

  const existingFiles = (item?.assets ?? []).map((a) => assetLine(a, true, false)).join('');

  openGeneric({
    title: (item ? `זווית ${item.sort_order}` : `זווית חדשה${slot ? ` — מקום ${slot}` : ''}`)
      + (owner ? ` · ${owner.endpoint_name}` : ''),
    fields: [
      { name: 'title', label: 'המסר בקצרה', type: 'text', value: item?.title },
      { name: 'campaign_id', label: 'קמפיין', type: 'select', options: campaignOptions,
        value: item?.campaign_id ?? campaign?.id ?? '' },
      // נקודת הקצה מגיעה מהקמפיין. נשאלת רק לתוכן שוטף שאין לו קמפיין.
      ...(inCampaign ? [] : [{
        name: 'endpoint_id', label: 'נקודת קצה', type: 'select',
        options: state.endpoints.map((e) => [e.id, e.name]),
        value: item?.endpoint_id ?? bgEndpoint,
      }]),
      ...(background && !item ? [{
        name: 'channel_ids', label: 'לאילו מדיות לפתוח טיוטה', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: state.channels.filter((c) => c.active).map((c) => c.id),
      }] : []),
      { name: 'kind', label: 'סוג', type: 'select',
        options: [['value', 'ערך'], ['hybrid', 'משולב'], ['promo', 'מכירתי']],
        value: item?.kind },
      { name: 'evergreen', label: 'Evergreen — אפשר לפרסם שוב ושוב', type: 'checkbox',
        value: item ? item.evergreen : !!background },
      { name: 'reuse_after_days', label: 'מרווח בין חזרות (ימים) — ריק = ברירת המחדל',
        type: 'number', value: item ? item.reuse_after_days : (background ? 30 : null) },
      { name: '__files', label: 'תמונות, סרטונים ומסמכים (משותפים לכל המדיות)',
        type: 'files', existing: existingFiles },
    ],
    extraActions: item && can('content')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק זווית</button>'
      : '',
    onSave: async (v) => {
      const body = { ...v };
      delete body.__files;
      body.week = state.week;
      if (slot && !item) {
        body.sort_order = slot;
        // זווית חדשה נפתחת עם טיוטה לכל מדיה של הקמפיין
        body.channel_ids = campaign?.channels?.map((c) => c.id) ?? [];
      }

      const saved = item
        ? (await api(`/content/${item.id}`, { method: 'PATCH', body })).content
        : (await api('/content', { method: 'POST', body })).content;

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        await uploadFiles(saved.id, picked, {
          onProgress: progressList($('#gen___files_progress'), picked),
        });
      }
      await reload();
    },
    onOpen: () => {
      wireCopyLinks($('#genBody'));
      $$('#genBody [data-del-asset]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/assets/${b.dataset.delAsset}`, { method: 'DELETE' });
          b.closest('.fileline').remove();
          toast('הקובץ הוסר.');
        })));
      $('#genDelete')?.addEventListener('click', run(async () => {
        if (!(await confirmDialog('למחוק את הזווית וכל הגרסאות שלה?', { danger: true }))) return;
        await api(`/content/${item.id}`, { method: 'DELETE', body: { week: state.week } });
        $('#genDlg').close();
        await reload();
      }));
    },
  });
}

/** הגרסה: הניסוח של זווית מסוימת למדיה מסוימת */
async function openVariantForm({ item, channelId, campaign }, reload) {
  const channel = state.channels.find((c) => c.id === channelId);
  // ניוזלטר: עורך משלו מול ה-HUB — עורך המייל של ה-HUB, תצוגה ממנו, "העבר ל-HUB"
  if (channel?.platform === 'newsletter') return openNewsletterEditor({ item, channelId, reload });
  const v = item.variants.find((x) => x.channel_id === channelId) ?? null;

  // הקבצים של המדיה הזו בלבד, ולצידם מה שמשותף לכל המדיות של הזווית
  const mine = (item.variant_assets ?? []).filter((a) => a.variant_id === v?.id);
  const shared = item.assets ?? [];

  const files = [
    ...mine.map((a) => assetLine(a, true)),
    ...shared.map((a) => assetLine(a, false)),
  ].join('') || '';

  openGeneric({
    title: `${item.title} — ${channel?.name ?? ''}`,
    fields: [
      { name: 'body', label: 'הטקסט כפי שהוא ייצא במדיה הזו', type: 'textarea', value: v?.body },
      { name: 'status', label: 'מצב', type: 'select', value: v?.status ?? 'draft',
        options: [['draft', 'טיוטה'], ['ready', 'מוכן לפרסום'],
                  ['not_relevant', 'לא רלוונטי למדיה הזו']] },
      { name: '__files', label: `תמונות וסרטונים ל${channel?.name ?? 'מדיה הזו'}`,
        type: 'files', existing: files },
    ],
    // כפתור קיצור משמאל: "מוכן לשליחה"
    extraActions: (() => {
      const btns = [];
      if (v?.status !== 'ready') {
        btns.push('<button type="button" class="btn small" id="markReady" style="color:var(--st-good)">⚡ מוכן לשליחה</button>');
      }
      return btns.length
        ? `<span style="margin-inline-end:auto;display:flex;gap:8px">${btns.join('')}</span>`
        : '';
    })(),
    onSave: async (val) => {
      const body = { ...val };
      delete body.__files;
      body.week = state.week;
      await api(`/content/${item.id}/variants/${channelId}`, { method: 'PUT', body });

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        await uploadFiles(item.id, picked, {
          channelId,
          onProgress: progressList($('#gen___files_progress'), picked),
        });
      }
      await reload();
    },
    onOpen: () => {
      wireCopyLinks($('#genBody'));
      $$('#genBody [data-del-asset]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/assets/${b.dataset.delAsset}`, { method: 'DELETE' });
          b.closest('.fileline').remove();
          toast('הקובץ הוסר.');
        })));
      // "מוכן לשליחה" — מעביר את שדה המצב ל"מוכן" ומפעיל את השמירה הרגילה,
      // כך שכל הלוגיקה (קבצים) רצה כמו בשמירה ידנית.
      $('#markReady')?.addEventListener('click', () => {
        $('#gen_status').value = 'ready';
        $('#genSave').click();
      });
    },
  });
}


/**
 * שורת קובץ בטופס. ownOnly מבדיל בין קובץ של המדיה לקובץ משותף לזווית
 * (רק את שלה אפשר להסיר מכאן); sharedNote מוסיף "משותף לזווית" לצד הגודל.
 * קובץ ב-R2 מוצג ישירות מהקישור הציבורי, ולידו "העתק קישור".
 */
function assetLine(a, ownOnly, sharedNote = !ownOnly) {
  const src = a.url ?? `/api/assets/${a.id}`;
  const thumb = isImage(a.mime) ? `<img src="${esc(src)}" alt="">`
              : isVideo(a.mime) ? '<span class="ic">🎬</span>'
              : '<span class="ic">📄</span>';
  return `<div class="fileline">
    ${thumb}
    <a href="${esc(src)}" target="_blank" rel="noopener">${esc(a.filename)}</a>
    <span class="d">${kb(a.size_bytes)}${sharedNote ? ' · משותף לזווית' : ''}</span>
    <span class="fl-acts">
      ${copyLinkButton(a.url)}
      ${ownOnly ? `<button type="button" class="btn small" data-del-asset="${a.id}"
         style="color:var(--st-crit)">הסר</button>` : ''}
    </span>
  </div>`;
}
