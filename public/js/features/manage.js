import { api } from '../core/api.js';
import { can, rebuildEpColors, state } from '../core/state.js';
import { $, $$, esc, run, toast } from '../core/dom.js';
import { HE_DAYS, KIND_VAR, fmtDate, ymd } from '../core/format.js';
import { refreshBoard } from '../ui/refresh.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from '../ui/dialog.js';

/* ========================= ניהול ========================= */

export async function renderManage() {
  const [{ endpoints }, { channels }, { settings }, { users }, backupsRes] = await Promise.all([
    api('/endpoints'), api('/channels'), api('/settings'), api('/users'),
    can('settings') ? api('/backups') : Promise.resolve(null),
  ]);
  state.endpoints = endpoints;
  rebuildEpColors();
  state.channels = channels;
  state.users = users;

  const ro = !can('settings'); // read-only

  $('#manage').innerHTML = `
    <div class="setgroup">
      <h2>נקודות קצה</h2>
      <p class="sub">כל נקודה מרכזת אצלה הכול: הגדרות, קמפיינים, ותוכן.</p>
      <div class="panel">${endpoints.map((e) => endpointItem(e, channels, ro)).join('')
        || '<div class="empty">אין עדיין נקודות קצה.</div>'}</div>
      ${ro ? '' : '<div style="margin-top:10px"><button class="btn" id="addEndpoint">＋ הוסף נקודת קצה</button></div>'}
    </div>

    <div class="setgroup">
      <h2>ערוצי פרסום</h2>
      <p class="sub">כמה שטח יש בכל ערוץ ומה הכללים שלו.</p>
      <div class="panel">${channels.map((c) => channelItem(c, ro)).join('')
        || '<div class="empty">אין עדיין ערוצים.</div>'}</div>
      ${ro ? '' : '<div style="margin-top:10px"><button class="btn" id="addChannel">＋ הוסף ערוץ</button></div>'}
    </div>

    ${can('users') ? systemGroup(users, settings, backupsRes?.backups ?? null) : ''}`;

  wireManage(ro);
}

function endpointItem(e, channels, ro) {
  // הקמפיינים והתוכן עברו לטאבים משלהם. כאן נשארו רק ההגדרות של הנקודה עצמה.
  const hasContent = e.content.length > 0;

  return `<details class="item">
    <summary>
      <b>${esc(e.name)}</b>
      <span class="info">חשיבות ${e.importance} · ${e.campaigns.length} קמפיינים</span>
      <span class="chip ${hasContent ? 'on' : 'bad'}">${hasContent ? 'פעילה' : 'חסר תוכן'}</span>
    </summary>
    <div class="ibody">
      <div class="prow">
        <label>חשיבות (1–10) — כמה שטח מגיע לה</label>
        <input type="number" min="1" max="10" value="${e.importance}"
               data-ep-field="importance" data-id="${e.id}" ${ro ? 'disabled' : ''}>
      </div>
      <div class="prow">
        <label>לפרסם לפחות פעם ב־ (ימים)</label>
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
        <div class="fhint">אוטומטי מחשב קצב לפי החשיבות — חשיבות גבוהה יותר, קצב תכוף יותר.
          קבוע נועד למקרה שיש צורך ספציפי בקצב מסוים, בלי קשר לחשיבות.</div>
      </div>

      <div class="subsec">
        <h4>סיכום</h4>
        <div class="contentline">${e.campaigns.length} קמפיינים · ${e.content.length} פריטי תוכן
          <span style="color:var(--muted)">— לניהול שלהם: הטאבים "קמפיינים" ו"תוכן"</span></div>
      </div>

      ${ro ? '' : `<div style="margin-top:14px">
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

function channelItem(c, ro) {
  const num = (label, field, value, note = '', max = '') => `
    <div class="prow">
      <label>${note}${label}</label>
      <input type="number" min="0" ${max ? `max="${max}"` : ''} value="${value ?? ''}" placeholder="ללא"
             data-ch-field="${field}" data-id="${c.id}" ${ro ? 'disabled' : ''}>
    </div>`;
  const sw = (kind) =>
    `<span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:3px;` +
    `background:${KIND_VAR[kind]};margin-inline-end:6px;vertical-align:-1px"></span>`;

  return `<details class="item">
    <summary>
      <b>${esc(c.name)}</b>
      <span class="info">קצב ${c.target_per_week ?? c.max_per_week} · תקרה ${c.max_per_week} בשבוע</span>
      <span class="chip ${c.active ? 'on' : 'bad'}">${c.active ? 'פעיל' : 'מושבת'}</span>
    </summary>
    <div class="ibody">
      ${num('קצב רצוי בשבוע — ממנו נגזר כמה מגיע לכל קמפיין', 'target_per_week', c.target_per_week)}
      ${num('תקרה — מקסימום פוסטים בשבוע', 'max_per_week', c.max_per_week)}
      ${num('מזה — מכירתיים מקסימום', 'max_promo_per_week', c.max_promo_per_week, sw('promo'))}
      ${num('מזה — משולבים מקסימום', 'max_hybrid_per_week', c.max_hybrid_per_week, sw('hybrid'))}
      ${num('מזה — ערך מקסימום', 'max_value_per_week', c.max_value_per_week, sw('value'))}
      ${num('שטח ששמור לדברים דחופים (%)', 'urgent_reserve_pct', c.urgent_reserve_pct)}
      ${num('יעילות פרסום במדיה הזו (1–10) — אופציונלי', 'efficiency', c.efficiency, '', 10)}
      <div class="fhint" style="margin-top:-8px">
        ריק = ניטרלי. כשמוגדר, המנוע מנסה למלא קודם משבצות במדיות עם יעילות גבוהה יותר,
        כדי שתוכן חשוב יגיע לבמה הכי טובה קודם.
      </div>

      <div class="prow" style="align-items:flex-start">
        <label>ימים שבהם המדיה לא מקבלת תוכן</label>
        <div class="checks" style="justify-content:flex-end">
          ${HE_DAYS.map((d, i) => `<label>
            <input type="checkbox" data-blocked="${c.id}" value="${i}"
                   ${(c.blocked_days ?? []).includes(i) ? 'checked' : ''} ${ro ? 'disabled' : ''}>
            ${d}</label>`).join('')}
        </div>
      </div>
      ${ro ? '' : `<div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn small" data-toggle-channel="${c.id}" data-active="${c.active}">
          ${c.active ? 'השבת ערוץ' : 'הפעל ערוץ'}</button>
        <button class="btn small" style="color:var(--st-crit)" data-del-channel="${c.id}">מחק ערוץ</button>
      </div>`}
    </div>
  </details>`;
}

function systemGroup(users, settings, backups) {
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
  const eng = (label, field, value, step = '1') => `
    <div class="prow"><label>${label}</label>
      <input type="number" step="${step}" value="${value}" data-engine="${field}"></div>`;

  return `<div class="setgroup" id="ownerOnly">
    <h2>מערכת</h2>
    <div class="panel">
      <details class="item">
        <summary><b>משתמשים והרשאות</b>
          <span class="info">${users.length} משתמשים</span>
          <span class="owner-tag">בעלים בלבד</span></summary>
        <div class="ibody">
          <table class="utable">
            <thead><tr><th>משתמש</th><th>תוכן ושיבוץ</th><th>הגדרות</th>
              <th>אישור דחוף־דורס</th><th>ניהול משתמשים</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="margin-top:10px"><button class="btn small primary" id="addUser">＋ הוסף משתמש</button></div>
        </div>
      </details>
      <details class="item">
        <summary><b>מתקדם — כללי המנוע</b><span class="info">נוגעים בזה לעיתים רחוקות</span></summary>
        <div class="ibody">
          ${eng('מרווח מינימלי לאותה נקודה באותו ערוץ (ימים)', 'min_gap_days', s.min_gap_days)}
          ${eng('מקסימום מכירתיים ביום, בכל הערוצים', 'max_promo_per_day', s.max_promo_per_day)}
          <div class="prow">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="engRatioOn" ${s.min_value_per_promo > 0 ? 'checked' : ''}>
              לאכוף יחס ערך מול מכירתי
            </label>
            <input type="number" step="0.5" min="0.5" id="engRatioVal"
                   value="${s.min_value_per_promo > 0 ? s.min_value_per_promo : 3}"
                   data-engine="min_value_per_promo" ${s.min_value_per_promo > 0 ? '' : 'disabled'}>
          </div>
          ${eng('"משולב" נספר כמכירתי', 'hybrid_weight', s.hybrid_weight, '0.1')}
          ${eng('התראת "מחכה לתוכן" — שעות מראש', 'content_alert_hours', s.content_alert_hours)}
          <div class="prow">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="engUsePerf" ${s.use_performance ? 'checked' : ''}>
              לתת ליעילות הנמדדת להשפיע על השיבוץ
            </label>
          </div>
          <div class="fhint" style="margin-top:-8px">
            כבוי = המערכת רק אוספת ומציגה את התוצאות בטאב "נתונים", בלי לגעת בלוח.
            כדאי להדליק רק אחרי שיש מספיק מדידות והמספרים שם נראים לך הגיוניים.
          </div>
        </div>
      </details>
      ${backups ? `<details class="item">
        <summary><b>גיבויים אוטומטיים</b>
          <span class="info">${backups.length
            ? `${backups.length} שמורים · אחרון ${fmtDate(ymd(new Date(backups[0].created_at)))}`
            : 'עוד לא רץ גיבוי'}</span></summary>
        <div class="ibody">
          <p class="sub">רץ אוטומטית כל 24 שעות, שומר עותק של כל הטבלאות בתוך ה-DB עצמו
            (בלי קבצים מצורפים — הם כבר בטוחים ב-content_assets). מגן מפני טעות אפליקטיבית,
            לא מפני אובדן הדיסק עצמו — לזה יש את הגיבוי המובנה של Railway ל-Postgres.</p>
          ${backups.length ? `<table class="utable"><thead><tr><th>מתי</th><th>שורות</th></tr></thead>
            <tbody>${backups.slice(0, 10).map((b) => `<tr>
              <td>${esc(new Date(b.created_at).toLocaleString('he-IL'))}</td>
              <td>${b.row_count}</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
      </details>` : ''}
    </div>
  </div>`;
}

function wireManage(ro) {
  const reload = run(async () => { await renderManage(); await refreshBoard(); });

  const engineToast = (base, res) =>
    base + (res.engine?.placed ? ` המנוע מילא ${res.engine.placed} משבצות פנויות.` : '');

  // עריכת שדה בשדה — נשמר ביציאה מהשדה
  $$('#manage [data-ep-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api(`/endpoints/${inp.dataset.id}`,
        { method: 'PATCH', body: { [inp.dataset.epField]: Number(inp.value), week: state.week } });
      toast(engineToast('נשמר.', res));
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
        toast(engineToast('נשמר — הקצב יחושב אוטומטית לפי החשיבות.', res));
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
      toast(engineToast('נשמר.', res));
      await refreshBoard();
    })));

  $$('#manage [data-ch-field]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const raw = inp.value.trim();
      const res = await api(`/channels/${inp.dataset.id}`,
        { method: 'PATCH',
          body: { [inp.dataset.chField]: raw === '' ? null : Number(raw), week: state.week } });
      toast(engineToast('נשמר.', res));
      await refreshBoard();
    })));

  // הימים החסומים נשמרים כקבוצה, כי הם מערך אחד ולא שדה בודד
  $$('#manage [data-blocked]').forEach((cb) =>
    cb.addEventListener('change', run(async () => {
      const id = cb.dataset.blocked;
      const days = $$(`[data-blocked="${id}"]:checked`).map((i) => Number(i.value));
      const res = await api(`/channels/${id}`,
        { method: 'PATCH', body: { blocked_days: days, week: state.week } });
      toast(engineToast(days.length ? `נחסמו ימי ${days.map((d) => HE_DAYS[d]).join(', ')}.`
                        : 'כל הימים פתוחים.', res));
      await refreshBoard();
    })));

  $$('#manage [data-engine]').forEach((inp) =>
    inp.addEventListener('change', run(async () => {
      const res = await api('/settings',
        { method: 'PATCH', body: { [inp.dataset.engine]: Number(inp.value), week: state.week } });
      toast(engineToast('נשמר.', res));
      await refreshBoard();
    })));

  $('#engUsePerf')?.addEventListener('change', run(async (e) => {
    const on = e.target.checked;
    const res = await api('/settings',
      { method: 'PATCH', body: { use_performance: on, week: state.week } });
    toast(engineToast(on ? 'נשמר — היעילות הנמדדת משפיעה עכשיו על השיבוץ.'
                         : 'נשמר — היעילות רק נמדדת, בלי להשפיע על הלוח.', res));
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
    toast(engineToast(enforcing ? 'נשמר — היחס נאכף שוב.' : 'נשמר — היחס לא נאכף יותר.', res));
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

  $$('#manage [data-del-endpoint]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!(await confirmDialog('למחוק את נקודת הקצה? כל הקמפיינים והתוכן שלה יימחקו איתה.', { danger: true }))) return;
      await api(`/endpoints/${b.dataset.delEndpoint}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      if (!(await confirmDialog('למחוק את הערוץ? כל השיבוצים בו יימחקו.', { danger: true }))) return;
      await api(`/channels/${b.dataset.delChannel}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-toggle-channel]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/channels/${b.dataset.toggleChannel}`,
        { method: 'PATCH', body: { active: b.dataset.active !== 'true', week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-campaign]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/campaigns/${b.dataset.delCampaign}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  $$('#manage [data-del-content]').forEach((b) =>
    b.addEventListener('click', run(async () => {
      await api(`/content/${b.dataset.delContent}`,
        { method: 'DELETE', body: { week: state.week } });
      await reload();
    })));

  if (!ro) {
    $('#addEndpoint')?.addEventListener('click', () => openGeneric({
      title: 'נקודת קצה חדשה',
      fields: [
        { name: 'name', label: 'שם', type: 'text' },
        { name: 'importance', label: 'חשיבות (1–10)', type: 'number', value: 5 },
        { name: 'min_days_between', label: 'לפרסם לפחות פעם ב־ (ימים)', type: 'auto',
          value: null, auto: 'נגזר מהחשיבות',
          hint: 'אוטומטי מחשב קצב לפי החשיבות. קבוע נועד למקרה שיש צורך ספציפי בקצב מסוים, ' +
                'בלי קשר לחשיבות.' },
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
      { name: 'email', label: 'אימייל', type: 'email' },
      { name: 'password', label: 'סיסמה (ריק = התחברות דרך Google בלבד)', type: 'password' },
      { name: 'perm_content', label: 'תוכן ושיבוץ', type: 'checkbox', value: true },
      { name: 'perm_settings', label: 'הגדרות', type: 'checkbox' },
      { name: 'perm_approve', label: 'אישור דחוף־דורס', type: 'checkbox' },
      { name: 'perm_users', label: 'ניהול משתמשים', type: 'checkbox' },
    ],
    onSave: async (v) => { await api('/users', { method: 'POST', body: v }); await reload(); },
  }));
}
