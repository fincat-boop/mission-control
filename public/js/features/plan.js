import { api } from '../core/api.js';
import { can, epColor, state } from '../core/state.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { CELL, KIND_HE, TONE_CLASS, fmtDate, isImage, isVideo, kb } from '../core/format.js';
import { refreshAlerts, refreshBoard } from '../ui/refresh.js';
import { openGeneric } from '../ui/dialog.js';
import { confirmDialog } from '../core/confirm.js';
import { openImport } from '../ui/importDialog.js';

/* ========================= קמפיינים ותוכן ========================= */

export async function renderPlan() {
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
  const group = (title, list) => list.length ? `
    <div class="setgroup" style="max-width:none">
      <h2>${esc(title)}</h2>
      <div class="panel">${list.map(campaignItem).join('')}</div>
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
    <div class="setgroup" style="max-width:none">
      <h2>תוכן שוטף</h2>
      <p class="sub">רץ ברקע כל הזמן, בלי תאריכים. המנוע שולף ממנו כשנשאר שטח.</p>
      <div class="panel">
        <div class="crow2" data-open-background>
          <div class="cinfo">
            <b>תוכן ערך שוטף</b>
            <span class="d">${bg.length} זוויות · ${bgReady} מהן מוכנות לפחות במדיה אחת</span>
          </div>
          <span class="chip ${bg.length ? 'on' : 'bad'}">${
            bg.length ? 'פעיל' : 'ריק'}</span>
        </div>
      </div>
    </div>

    ${mine.length ? '' : '<div class="empty">אין קמפיינים לנקודה הזו עדיין.</div>'}
    ${group('רצים עכשיו', mine.filter((c) => c.phase === 'running'))}
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
    ${can('settings') ? `
      <button class="btn small${c.paused_at ? ' primary' : ''}"
        data-toggle-pause="${c.id}" data-paused="${!!c.paused_at}">
        ${c.paused_at ? '▶ חזרה לחיים' : '⏸ השהה'}</button>
      <button class="btn small" data-edit-campaign="${c.id}">ערוך</button>` : ''}
  </div>`;
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
      if (e.target.closest('[data-edit-campaign]')) return;
      state.planCampaign = Number(el.dataset.openCampaign);
      await renderPlan();
    })));

  $$('#plan [data-edit-campaign]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = state.campaigns.find((x) => x.id === Number(b.dataset.editCampaign));
      openCampaignForm(c, reload);
    }));

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

function openCampaignForm(campaign, reload, defaultEndpoint) {
  openGeneric({
    title: campaign ? 'עריכת קמפיין' : 'קמפיין חדש',
    fields: [
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
    extraActions: campaign && can('settings')
      ? '<button class="btn" id="genDelete" style="color:var(--st-crit);margin-inline-end:auto">מחק קמפיין</button>'
      : '',
    onSave: async (v) => {
      v.week = state.week;
      if (campaign) await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: v });
      else await api('/campaigns', { method: 'POST', body: v });
      await reload();
    },
    onOpen: () => {
      $('#genDelete')?.addEventListener('click', run(async () => {
        if (!(await confirmDialog('למחוק את הקמפיין? התוכן שלו יישאר, רק ינותק ממנו.', { danger: true }))) return;
        await api(`/campaigns/${campaign.id}`, { method: 'DELETE', body: { week: state.week } });
        $('#genDlg').close();
        state.planCampaign = null;
        await reload();
      }));
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
      ${can('settings') ? `<button class="btn small" data-edit-campaign="${c.id}">✎ ערוך קמפיין</button>` : ''}
      <div class="fill">
        <b>${c.ready}</b> מתוך <b>${c.required}</b> פוסטים מוכנים
        ${c.missing_content ? `<span class="off">— חסרים ${c.missing_content}</span>`
                            : '<span class="ok">✓</span>'}
      </div>
    </div>

    ${can('content') ? `<div class="bulk" id="bulkZone">
      <div>
        <b>העלאה מרוכזת</b>
        <span>כל קובץ הופך לזווית חדשה, ונפתחות לה טיוטות לכל מדיה של הקמפיין.</span>
      </div>
      <div class="spacer"></div>
      <select id="bulkKind">
        <option value="value">ערך</option>
        <option value="hybrid">משולב</option>
        <option value="promo">מכירתי</option>
      </select>
      <button class="btn primary" id="bulkPick">בחר קבצים</button>
      <input type="file" id="bulkInput" multiple hidden>
      <button class="btn" id="importSheet">ייבוא מטבלה</button>
    </div>` : ''}

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

  $('#importSheet')?.addEventListener('click', () => openImport(selected, reload));

  const input = $('#bulkInput');
  $('#bulkPick')?.addEventListener('click', () => input.click());
  input?.addEventListener('change', run(async () => {
    if (!input.files?.length) return;
    const fd = new FormData();
    for (const f of input.files) fd.append('files', f);
    fd.append('kind', $('#bulkKind').value);

    toast(`מעלה ${input.files.length} קבצים…`);
    const res = await fetch(`/api/campaigns/${selected.id}/bulk`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ההעלאה נכשלה');
    toast(`נוצרו ${data.created.length} זוויות.`);
    input.value = '';
    await reload();
  }));
}

/** הזווית: המסר עצמו, הסוג, הקבצים המשותפים */
function openAngleForm({ item, campaign, slot, background }, reload) {
  const campaignOptions = [['', 'ללא קמפיין — תוכן שוטף'],
    ...state.campaigns.map((c) => [c.id, c.name])];
  const inCampaign = !!(campaign?.id ?? item?.campaign_id);
  const owner = state.campaigns.find((c) => c.id === (campaign?.id ?? item?.campaign_id));
  // תוכן שוטף: אין קמפיין לרשת ממנו נקודת קצה, אז היא נלקחת מההקשר
  const bgEndpoint = background?.endpoint_id;

  const existingFiles = (item?.assets ?? []).map((a) => `
    <div class="fileline">
      ${isImage(a.mime) ? `<img src="/api/assets/${a.id}" alt="">` : '<span class="ic">📄</span>'}
      <a href="/api/assets/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
      <span class="d">${kb(a.size_bytes)}</span>
      <button type="button" class="btn small" data-del-asset="${a.id}"
              style="color:var(--st-crit);margin-inline-start:auto">הסר</button>
    </div>`).join('');

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
      { name: '__files', label: 'תמונות ומסמכים (משותפים לכל המדיות)',
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
        const fd = new FormData();
        for (const f of picked) fd.append('files', f);
        const res = await fetch(`/api/content/${saved.id}/assets`, { method: 'POST', body: fd });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || 'הקבצים לא נשמרו');
        }
      }
      await reload();
    },
    onOpen: () => {
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
function openVariantForm({ item, channelId, campaign }, reload) {
  const channel = state.channels.find((c) => c.id === channelId);
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
      { name: 'body', label: 'הטקסט כפי שהוא ייצא במדיה הזו', type: 'textarea',
        value: v?.body },
      { name: 'status', label: 'מצב', type: 'select', value: v?.status ?? 'draft',
        options: [['draft', 'טיוטה'], ['ready', 'מוכן לפרסום'],
                  ['not_relevant', 'לא רלוונטי למדיה הזו']] },
      { name: '__files', label: `תמונות וסרטונים ל${channel?.name ?? 'מדיה הזו'}`,
        type: 'files', existing: files },
    ],
    onSave: async (val) => {
      const body = { ...val };
      delete body.__files;
      body.week = state.week;
      await api(`/content/${item.id}/variants/${channelId}`, { method: 'PUT', body });

      const picked = $('#gen___files')?.files;
      if (picked?.length) {
        const fd = new FormData();
        for (const f of picked) fd.append('files', f);
        const res = await fetch(`/api/content/${item.id}/variants/${channelId}/assets`,
          { method: 'POST', body: fd });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || 'הקבצים לא נשמרו');
        }
      }
      await reload();
    },
    onOpen: () => {
      $$('#genBody [data-del-asset]').forEach((b) =>
        b.addEventListener('click', run(async () => {
          await api(`/assets/${b.dataset.delAsset}`, { method: 'DELETE' });
          b.closest('.fileline').remove();
          toast('הקובץ הוסר.');
        })));
    },
  });
}


/** שורת קובץ בטופס. ownOnly מבדיל בין קובץ של המדיה לקובץ משותף לזווית. */
function assetLine(a, ownOnly) {
  const thumb = isImage(a.mime) ? `<img src="/api/assets/${a.id}" alt="">`
              : isVideo(a.mime) ? '<span class="ic">🎬</span>'
              : '<span class="ic">📄</span>';
  return `<div class="fileline">
    ${thumb}
    <a href="/api/assets/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>
    <span class="d">${kb(a.size_bytes)}${ownOnly ? '' : ' · משותף לזווית'}</span>
    ${ownOnly ? `<button type="button" class="btn small" data-del-asset="${a.id}"
       style="color:var(--st-crit);margin-inline-start:auto">הסר</button>` : ''}
  </div>`;
}
