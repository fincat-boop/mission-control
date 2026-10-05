import { api } from '../core/api.js';
import { can, epColor, state, persistView } from '../core/state.js';
import { $, $$, copyLinkButton, esc, run, toast, wireCopyLinks } from '../core/dom.js';
import { openTemplateFiller } from '../ui/templateFiller.js';
import { CELL, KIND_HE, TONE_CLASS, fmtDate, isImage, isVideo, kb } from '../core/format.js';
import { refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { openGeneric } from '../ui/dialog.js';
import { confirmDialog } from '../core/confirm.js';
import { openImport } from '../ui/importDialog.js';
import { progressList, uploadBulk, uploadFiles } from '../core/upload.js';

/* ========================= ניוזלטר: תבנית המילוי ========================= */

// תבנית המילוי של ה-HUB, בקאש קצר כדי לא לשאול בכל פתיחת טופס
let tplCache = null; // { at:number, value }
async function newsletterTemplate() {
  const now = Date.now();
  if (tplCache && now - tplCache.at < 60000) return tplCache.value;
  try {
    const { template, fill_url } = await api('/publish/newsletter-template');
    const value = template ? { ...template, fill_url } : template;
    tplCache = { at: now, value };
    return value;
  } catch {
    return null; // תקלת HUB לא תשבור את טופס העריכה — נופלים לממשק הבסיסי
  }
}

// שדות שהמילוי האוטומטי של ה-HUB מכסה (תוכן/תאריך) — לא מציגים בטופס.
// "כותרת" בכוונה לא כאן: ממלאים אותה ידנית בטופס (הוחלט 30.8.2026) —
// הערך שנשלח ב-field_values גובר על ברירת המחדל של ה-HUB (שם הפוסט).
const AUTO_FILLED = new Set(
  ['תוכן', 'גוף הגיליון', 'גוף ההודעה', 'תאריך',
   'content', 'body', 'subject', 'date'].map((s) => s.toLowerCase()));
const isAutoFilled = (f) =>
  AUTO_FILLED.has((f.label ?? '').trim().toLowerCase()) ||
  AUTO_FILLED.has((f.name ?? '').trim().toLowerCase());

/** מחווט פעם אחת מ-app.js — סגירת דיאלוג התצוגה המקדימה */
export function wireMailPreview() {
  $('#previewClose').addEventListener('click', () => $('#previewDlg').close());
}

/** מציג את ה-HTML שה-HUB רינדר ב-iframe מבודד (בלי סקריפטים) */
/**
 * עמודת התצוגה החיה בדיאלוג גרסת המייל: iframe מבודד (בלי סקריפטים)
 * שמתרענן ~600 מ"ש אחרי ההקלדה האחרונה. מונה ריצות מגן מפני מרוץ —
 * תשובה איטית של בקשה ישנה לא דורסת חדשה.
 */
function mountLivePreview({ tplFields, title, values }) {
  const dlg = $('#genDlg');
  dlg.classList.add('with-live-preview');

  const pane = document.createElement('div');
  pane.id = 'livePreviewPane';
  pane.innerHTML = `
    <div class="lp-head">תצוגה חיה — כך ייראה המייל אצל הנמען</div>
    <div class="lp-warn" id="lpWarn" hidden></div>
    <div id="lpFrameWrap"></div>`;
  dlg.insertBefore(pane, dlg.querySelector('.dactions'));

  let seq = 0;
  let timer = null;

  const refresh = async () => {
    const my = ++seq;
    // הערכים מהממלא של ה-HUB (values), או משדות fv_ מקומיים אם קיימים
    const fieldValues = { ...(values ? values() : {}) };
    for (const f of tplFields) {
      const el = $(`#gen_fv_${f.name}`);
      if (el) fieldValues[f.name] = el.value;
    }
    try {
      const preview = await api('/publish/newsletter-preview', {
        method: 'POST',
        body: {
          subject: $('#gen_subject')?.value ?? '',
          htmlBody: $('#gen_body')?.value ?? '',
          name: title,
          fieldValues,
        },
      });
      if (my !== seq) return;
      $('#lpWarn').hidden = true;
      // iframe חדש בכל רענון (במקום להחליף src): ניווט של iframe קיים
      // נערם בהיסטוריית הדפדפן, וכפתור "אחורה" היה מדפדף בין תצוגות.
      const frame = document.createElement('iframe');
      frame.id = 'lpFrame';
      frame.title = 'תצוגה מקדימה של המייל';
      // allow-same-origin בלבד (בלי allow-scripts): sandbox ריק = מקור
      // אטום, והדפדפן לא שולח את קוקי ה-session — הנתיב מחזיר 401.
      // סקריפטים נשארים חסומים, וה-CSP של העמוד חוסם אותם גם כך.
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.src = `/api/publish/newsletter-frame/${preview.frame_token}`;
      $('#lpFrameWrap').replaceChildren(frame);
    } catch (e) {
      if (my !== seq) return;
      const warn = $('#lpWarn');
      warn.hidden = false;
      warn.textContent = `התצוגה לא נטענה: ${e.message}`;
    }
  };
  const queue = () => { clearTimeout(timer); timer = setTimeout(refresh, 600); };

  ['#gen_subject', '#gen_body', ...tplFields.map((f) => `#gen_fv_${f.name}`)]
    .forEach((sel) => $(sel)?.addEventListener('input', queue));
  refresh();
  return { refresh };
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
    const missing = mine.reduce((s, c) => s + c.missing_content, 0);
    return `<button class="epick" data-pick-endpoint="${e.id}">
      <span class="nm"><i class="dot" style="background:${epColor(e.id)}"></i>${esc(e.name)}</span>
      <span class="sub">${mine.length} קמפיינים · חשיבות ${e.importance}</span>
      <span class="chip ${missing ? 'bad' : 'on'}">${missing ? `חסרים ${missing}` : 'מלא'}</span>
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
      <span class="d">${esc(range)}</span>
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
      const res = await api(`/campaigns/${b.dataset.togglePause}/${paused ? 'resume' : 'pause'}`,
        { method: 'POST', body: { week: state.week } });
      toast(paused
        ? 'הקמפיין חזר לפעול.' +
          (res.cleared ? ` ${res.cleared} שיבוצים ישנים נוקו —` : '') +
          (res.engine?.placed ? ` המנוע שיבץ ${res.engine.placed} מחדש.` : ' המנוע ימקם אותו מחדש בפעם הבאה שיש מקום.')
        : `הקמפיין הושהה${res.held ? ` · ${res.held} שיבוצים ירדו מהלוח` : ''}.`);
      await reload();
    })));

  $('#addCampaign')?.addEventListener('click', () =>
    openCampaignForm(null, reload, endpointId));

  if (campaign) wireCampaignGrid(campaign, reload);
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
      await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
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
      { name: 'starts_on', label: 'מתאריך', type: 'date', value: campaign?.starts_on },
      { name: 'ends_on', label: 'עד תאריך', type: 'date', value: campaign?.ends_on },
      { name: 'channel_ids', label: 'על אילו מדיות הקמפיין יושב', type: 'multicheck',
        options: state.channels.filter((c) => c.active).map((c) => [c.id, c.name]),
        value: campaign?.channels?.map((c) => c.id) },
      { name: 'importance', label: 'חשיבות (1–10)', type: 'number',
        value: campaign?.importance ?? 5,
        hint: 'זה מה שקובע כמה שטח מגיע לקמפיין. השאר את שני השדות הבאים על "אוטומטי".' },
      { name: 'share_pct', label: 'נתח מהשטח', type: 'auto',
        value: campaign?.share_pct,
        auto: campaign?.share_auto != null ? `${campaign.share_auto}%` : 'לפי החשיבות',
        placeholder: '%',
        hint: 'אוטומטי מחלק את השטח לפי החשיבות מול הקמפיינים שרצים במקביל. ' +
              'קבוע נועד למקרה שהובטח לקמפיין נתח מסוים בלי קשר לשאר.' },
      { name: 'target_posts', label: 'מספר זוויות', type: 'auto',
        value: campaign?.target_posts,
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
      v.week = state.week;
      if (duplicate) {
        const res = await api(`/campaigns/${source.id}/duplicate`, { method: 'POST', body: v });
        state.planCampaign = res.campaign.id;
        await reload();
        return `הקמפיין שוכפל עם ${res.copied.items} זוויות.`;
      }
      if (campaign) await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
      else await api('/campaigns', { method: 'POST', body: v });
      await reload();
    },
    onOpen: () => {
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


function campaignGrid(c) {
  const range = c.starts_on && c.ends_on
    ? `${fmtDate(c.starts_on)}–${fmtDate(c.ends_on)}` : 'ללא תאריכים';

  if (!c.channels.length) {
    return `<div class="panel"><div class="empty">
      לקמפיין הזה לא נבחרו מדיות. בוחרים אותן בעריכת הקמפיין בטאב "אסטרטגיה".
    </div></div>`;
  }
  if (!c.grid.length) {
    return `<div class="panel"><div class="empty">
      לקמפיין אין תאריכים, ולכן אין ממה לגזור כמה תוכן הוא צריך.
    </div></div>`;
  }

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
      const clickable = can('content') && cell.state !== 'not_needed';
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
    <div class="cbhead">
      <div>
        <h2>${c.urgent ? '⚡ ' : ''}${esc(c.name)}</h2>
        <p class="sub">${esc(c.endpoint_name)} · ${esc(range)}
          · נתח ${c.share_pct != null ? c.share_pct + '%' : 'נגזר מהמשקל'}
          ${c.goal ? `· ${esc(c.goal)}` : ''}</p>
      </div>
      <div class="spacer"></div>
      <div class="fill">
        <b>${c.ready}</b> מתוך <b>${c.required}</b> פוסטים מוכנים
        ${c.missing_content ? `<span class="off">— חסרים ${c.missing_content}</span>`
                            : '<span class="ok">✓</span>'}
      </div>
      ${campaignMenu()}
    </div>

    <div class="board panel">
      <table class="grid cgrid">
        <thead><tr><th class="angle">זווית</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="sumline">
      כל שורה היא מסר אחד, וכל עמודה היא הניסוח שלו למדיה. לחיצה על תא פותחת את הטקסט לאותה מדיה.
    </div>`;
}


function wireCampaignGrid(selected, reload) {
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

  const actions = {
    edit: () => openCampaignForm(selected, reload),
    bulk: () => openBulkUpload(selected, reload),
    import: () => openImport(selected, reload),
    delete: run(() => deleteCampaign(selected, reload)),
  };
  $$('#plan .cbhead [data-act]').forEach((b) =>
    b.addEventListener('click', () => actions[b.dataset.act]()));
}

/** תפריט שלוש הנקודות בכותרת הקמפיין — כל הפעולות על הקמפיין עצמו */
function campaignMenu() {
  const items = [
    can('settings') && '<button type="button" data-act="edit">ערוך קמפיין</button>',
    can('content') && '<button type="button" data-act="bulk">העלאה מרוכזת</button>',
    can('content') && '<button type="button" data-act="import">ייבוא מטבלה</button>',
    can('settings') && '<div class="sep"></div><button type="button" data-act="delete" data-danger>מחק קמפיין</button>',
  ].filter(Boolean);
  return kebab('פעולות על הקמפיין', items);
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
  const campaignOptions = [['', 'ללא קמפיין — תוכן שוטף'],
    ...state.campaigns.map((c) => [c.id, c.name])];
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
  const v = item.variants.find((x) => x.channel_id === channelId) ?? null;

  // ערוץ מייל (HUB): נושא + גוף HTML + רשימות יעד. הרשימות מגיעות מה-HUB —
  // אם הוא לא זמין, הטופס נפתח בלי הבורר עם הסבר, והבחירה הקיימת נשמרת.
  const isMail = channel?.platform === 'newsletter';
  const vMeta = v?.meta ?? {};

  // תבנית המילוי של ה-HUB: אם יש, מוסיפים טופס שדות. אין תבנית (null) —
  // הממשק הבסיסי בלבד. שדות שהמילוי האוטומטי מכסה מסוננים החוצה.
  const template = isMail ? await newsletterTemplate() : null;
  const tplFields = template ? (template.fields ?? []).filter((f) => !isAutoFilled(f)) : [];

  // הערכים חיים אצלנו; המילוי עצמו נעשה בממלא של ה-HUB (טאב + postMessage).
  // תאימות אחורה: גוף שנכתב לפני המעבר נזרע לשדה התוכן של התבנית.
  const externalValues = { ...(vMeta.field_values ?? {}) };
  if (template && v?.body?.trim()) {
    const contentField = (template.fields ?? []).find((f) =>
      ['תוכן', 'גוף הגיליון', 'גוף ההודעה'].includes(f.name));
    if (contentField && !String(externalValues[contentField.name] ?? '').trim()) {
      externalValues[contentField.name] = v.body;
    }
  }

  // ניוזלטר עם תבנית: ממלא התבניות הוא המסך — נפתח ישר, בלי דיאלוג
  // ביניים. הרשימה תמיד רשימת העל (ברירת המחדל של ה-HUB) — אין בורר.
  if (isMail && template?.html) {
    openTemplateFiller({
      html: template.html,
      fields: template.fields ?? [],
      values: externalValues,
      subject: vMeta.subject ?? '',
      readyButton: v?.status !== 'ready',
      title: `מילוי תוכן — ${item.title}`,
      onSave: (vals, { subject, ready }) => {
        const cleaned = {};
        for (const [k, val] of Object.entries(vals)) {
          if (String(val ?? '').trim()) cleaned[k] = val;
        }
        (async () => {
          try {
            await api(`/content/${item.id}/variants/${channelId}`, {
              method: 'PUT',
              body: {
                body: v?.body ?? null,
                status: ready ? 'ready' : (v?.status ?? 'draft'),
                meta: { ...vMeta, subject: subject || null, field_values: cleaned },
                week: state.week,
              },
            });
            toast(ready ? 'נשמר וסומן מוכן לשליחה.' : 'התוכן נשמר.');
            await reload();
          } catch (e) {
            toast(`השמירה נכשלה: ${e.message}`);
          }
        })();
      },
    });
    return;
  }

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
      ...(isMail ? [{ name: 'subject', label: 'נושא המייל', type: 'text',
                      value: vMeta.subject,
                      hint: 'הניוזלטר נשלח לרשימה הכללית (רשימת העל) ב-HUB' }] : []),
      // עם תבנית — כל התוכן ממולא בממלא של ה-HUB (הכפתור למטה); בלי
      // תבנית — כותבים גוף חופשי כאן.
      ...(template ? [] : [{
        name: 'body',
        label: isMail ? 'גוף המייל (HTML)' : 'הטקסט כפי שהוא ייצא במדיה הזו',
        type: 'textarea', value: v?.body,
      }]),
      { name: 'status', label: 'מצב', type: 'select', value: v?.status ?? 'draft',
        options: [['draft', 'טיוטה'], ['ready', 'מוכן לפרסום'],
                  ['not_relevant', 'לא רלוונטי למדיה הזו']] },
      { name: '__files', label: `תמונות וסרטונים ל${channel?.name ?? 'מדיה הזו'}`,
        type: 'files', existing: files },
    ],
    // כפתורי קיצור משמאל: "מוכן לשליחה" (כל מדיה) ו"תצוגה מקדימה" (מייל)
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
      if (isMail) {
        // meta נשלח רק כשיש מה לעדכן — כך כשל טעינת רשימות לא מוחק בחירה קיימת
        body.meta = { ...vMeta, subject: val.subject ?? null };
        delete body.subject;
      }
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
      // כך שכל הלוגיקה (קבצים, meta של מייל) רצה כמו בשמירה ידנית.
      $('#markReady')?.addEventListener('click', () => {
        $('#gen_status').value = 'ready';
        $('#genSave').click();
      });
      // תצוגה חיה — עמודה צמודה משמאל שמתעדכנת תוך כדי הקלדה. הרינדור
      // כולו ב-HUB (newsletter-preview); כאן רק debounce ותצוגת התוצאה.
      const preview = isMail
        ? mountLivePreview({ tplFields, title: item.title, values: () => externalValues })
        : null;


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
