import { api } from '../core/api.js';
import { $, $$, copyText, esc, run, toast } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from './dialog.js';

/**
 * מפתחות API לסוכנים — חלק נפתח ב"ניהול ← מערכת", לבעלים בלבד.
 * הועתק מ-Backbone (הגדרות ← מפתחות API): הנפקה עם הרשאות, הסוד מוצג
 * פעם אחת, ביטול, סוד חדש לאותו מפתח, ומחיקה רק אחרי ביטול.
 */

const whenHe = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dateHe = (d) => new Date(d).toLocaleDateString('he-IL');

function keyStatus(k) {
  if (k.revoked_at) return { tone: 'muted', text: 'מבוטל' };
  if (k.expires_at && new Date(k.expires_at) <= new Date()) return { tone: 'warn', text: 'פג תוקף' };
  return { tone: 'good', text: k.expires_at ? `פעיל עד ${dateHe(k.expires_at)}` : 'פעיל' };
}

function keyRow(k) {
  const st = keyStatus(k);
  const active = st.tone === 'good';
  const renewLabel = k.revoked_at ? 'הפעל עם סוד חדש' : active ? 'סוד חדש' : 'חדש';
  return `<tr data-key="${k.id}">
    <td><b>${esc(k.name)}</b>${k.env === 'test' ? ' <span class="owner-tag">בדיקה</span>' : ''}
      <div class="akprefix" dir="ltr">${esc(k.key_prefix)}…</div></td>
    <td><span class="akstatus"><span class="dot bk-${st.tone}"></span>${esc(st.text)}</span></td>
    <td><button class="btn small" data-ak-scopes="${k.id}">${k.scopes.length} הרשאות</button></td>
    <td><button class="btn small" data-ak-requests="${k.id}">${k.requests_24h}</button></td>
    <td>${esc(whenHe(k.last_used_at))}</td>
    <td class="akactions">
      <button class="btn small" data-ak-renew="${k.id}">${renewLabel}</button>
      ${k.revoked_at
        ? `<button class="btn small danger" data-ak-delete="${k.id}">מחק</button>`
        : `<button class="btn small danger" data-ak-revoke="${k.id}">בטל</button>`}
    </td>
  </tr>`;
}

/** החלק ב"מערכת". data = תשובת GET /api-keys */
export function apiKeysItem(data) {
  const active = data.keys.filter((k) => keyStatus(k).tone === 'good').length;
  const info = data.keys.length ? `${active} פעילים` : 'אין מפתחות';
  return `<details class="item" data-open-id="apikeys">
    <summary><b>מפתחות API לסוכנים</b><span class="info">${esc(info)}</span></summary>
    <div class="ibody">
      <p class="sub">מפתח נותן לסוכן חיצוני (בוט, אוטומציה) גישה למערכת — רק למה שסימנתם בו.
        סוכן לא מוחק, לא מאשר ולא מפרסם: אלה נשארים בידי אדם. כל פעולה שלו נרשמת ביומן
        הפעולות בשם המפתח.</p>
      ${data.keys.length ? `<div class="tablewrap"><table class="utable aktable">
        <thead><tr><th>מפתח</th><th>מצב</th><th>הרשאות</th><th title="ב-24 השעות האחרונות">בקשות (24ש׳)</th>
          <th>שימוש אחרון</th><th></th></tr></thead>
        <tbody>${data.keys.map(keyRow).join('')}</tbody>
      </table></div>` : ''}
      <div class="akbar">
        <button class="btn small primary" id="akNew">＋ מפתח חדש</button>
        <button class="btn small" id="akHandbook">העתק הוראות חיבור לסוכן</button>
      </div>
    </div>
  </details>`;
}

/** בחירת הרשאות: שתי קבוצות, כל הרשאה עם ההסבר שלה. בלי סימון מראש */
function scopePickerHtml(scopes, chosen = []) {
  const on = new Set(chosen);
  const group = (g, title) => `<div class="akgroup"><div class="akgtitle">${title}</div>${
    scopes.filter((s) => s.group === g).map((s) => `<label class="akscope">
      <input type="checkbox" data-scope="${esc(s.scope)}" ${on.has(s.scope) ? 'checked' : ''}>
      <span><b>${esc(s.label)}</b> <code dir="ltr">${esc(s.scope)}</code>
        <span class="fhint">${esc(s.description)}${s.implies?.length
          ? ` · כולל אוטומטית: ${esc(s.implies.join(', '))}` : ''}</span></span>
    </label>`).join('')}</div>`;
  return `<div class="akpicker">${group('read', 'קריאה — לשאול ולדווח')}${group('write', 'כתיבה — לשנות דברים')}</div>`;
}

const pickedScopes = () => $$('#genBody [data-scope]:checked').map((i) => i.dataset.scope);

/**
 * הסוד — פעם אחת. החלון נשאר עד שלוחצים "העתקתי — סגור"; אחרי זה הסוד
 * לא קיים בשום מקום אצלנו (במסד רק גיבוב).
 */
function showSecretOnce(key, secret) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'choice-dlg aksecret';
    dlg.innerHTML = `<p class="choice-msg"></p>
      <div class="aksecretbox" dir="ltr"><code></code></div>
      <p class="fhint">המפתח מוצג רק עכשיו. אחרי הסגירה אי אפשר לראות אותו שוב — אם יאבד,
        מנפיקים לו סוד חדש. לא לשלוח במייל או בצ'אט פתוח.</p>
      <div class="dactions">
        <button class="btn" data-ak="copy">העתק מפתח</button>
        <button class="btn primary" data-ak="close">העתקתי — סגור</button>
      </div>`;
    dlg.querySelector('.choice-msg').textContent = `המפתח "${key.name}" מוכן.`;
    dlg.querySelector('code').textContent = secret;
    dlg.addEventListener('cancel', (e) => e.preventDefault());   // Esc לא סוגר בטעות
    dlg.addEventListener('click', run(async (e) => {
      const b = e.target.closest('[data-ak]');
      if (!b) return;
      if (b.dataset.ak === 'copy') {
        await copyText(secret, dlg);
        toast('המפתח הועתק.');
      } else {
        dlg.close();
      }
    }));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** חלון מידע עם כפתור סגירה אחד (confirmDialog תמיד מוסיף "ביטול") */
function infoDialog(title, html) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'choice-dlg akinfo';
    dlg.innerHTML = `<p class="choice-msg"></p>${html}
      <div class="dactions"><button class="btn primary" data-close>סגור</button></div>`;
    dlg.querySelector('.choice-msg').textContent = title;
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { dlg.remove(); resolve(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** תאריך ברירת מחדל לחידוש: אותו אורך חיים כמו המקורי, מהיום */
function suggestedExpiry(k) {
  if (!k.expires_at) return '';
  const life = new Date(k.expires_at) - new Date(k.created_at);
  if (!(life > 0)) return '';
  const d = new Date(Date.now() + life);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

export function wireApiKeys(data, reload) {
  if (!$('#akNew')) return;
  const byId = (id) => data.keys.find((k) => String(k.id) === String(id));
  const afterSecret = (out) => setTimeout(run(async () => {
    await showSecretOnce(out.key, out.secret);
    reload();
  }));

  $('#akNew').addEventListener('click', () => openGeneric({
    title: 'מפתח API חדש',
    saveLabel: 'צור מפתח',
    fields: [
      { name: 'name', label: 'שם — לזהות מי משתמש בו (למשל "בוט הכתיבה")', type: 'text' },
      { name: 'expires_on', label: 'תוקף עד (ריק = בלי תפוגה)', type: 'date' },
      { name: 'scopes_ui', type: 'html', html: `<label>הרשאות</label>${scopePickerHtml(data.scopes)}` },
    ],
    onSave: async (v) => {
      const out = await api('/api-keys', {
        method: 'POST', body: { name: v.name, expires_on: v.expires_on || null, scopes: pickedScopes() },
      });
      afterSecret(out);
      return false;
    },
  }));

  $('#akHandbook').addEventListener('click', run(async (e) => {
    const { text } = await api('/api-keys/handbook');
    await copyText(text, e.target.parentElement);
    toast('ההוראות הועתקו — מדביקים אותן בהנחיות של הסוכן, יחד עם המפתח.');
  }));

  $$('[data-ak-scopes]').forEach((b) => b.addEventListener('click', () => {
    const k = byId(b.dataset.akScopes);
    const editable = keyStatus(k).tone === 'good';
    const derived = k.derived?.length
      ? `<div class="fhint">נגזר אוטומטית: ${esc(k.derived.join(', '))}</div>` : '';
    openGeneric({
      title: `הרשאות — ${k.name}`,
      saveLabel: editable ? 'שמור הרשאות' : 'סגור',
      fields: [{ name: 'scopes_ui', type: 'html', html: `${scopePickerHtml(data.scopes, k.scopes)}${derived}${
        editable ? '<div class="fhint">שינוי חל מיד, בלי סוד חדש.</div>'
                 : '<div class="fhint">למפתח שאינו פעיל אי אפשר לשנות הרשאות.</div>'}` }],
      onOpen: () => { if (!editable) $$('#genBody [data-scope]').forEach((i) => { i.disabled = true; }); },
      onSave: async () => {
        if (!editable) return false;
        await api(`/api-keys/${k.id}`, { method: 'PATCH', body: { scopes: pickedScopes() } });
        reload();
        return 'ההרשאות עודכנו.';
      },
    });
  }));

  $$('[data-ak-requests]').forEach((b) => b.addEventListener('click', run(async () => {
    const k = byId(b.dataset.akRequests);
    const { requests } = await api(`/api-keys/${k.id}/requests`);
    const html = requests.length ? `<div class="tablewrap"><table class="utable akreq">
      <thead><tr><th>מתי</th><th>בקשה</th><th>תוצאה</th><th>זמן</th><th>IP</th></tr></thead>
      <tbody>${requests.map((r) => `<tr>
        <td>${esc(whenHe(r.created_at))}</td>
        <td dir="ltr"><code>${esc(r.method)} ${esc(r.path)}</code></td>
        <td><span class="dot bk-${r.status == null ? 'muted' : r.status < 400 ? 'good' : 'crit'}"></span>${esc(r.status ?? '—')}</td>
        <td>${r.duration_ms != null ? `${r.duration_ms}ms` : '—'}</td>
        <td dir="ltr">${esc(r.ip ?? '—')}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">אין בקשות שנרשמו למפתח הזה.</div>';
    await infoDialog(`20 הבקשות האחרונות של "${k.name}"`, html);
  })));

  $$('[data-ak-renew]').forEach((b) => b.addEventListener('click', () => {
    const k = byId(b.dataset.akRenew);
    const what = k.revoked_at
      ? 'המפתח יחזור לפעולה עם סוד חדש. הסוד שבוטל לא יעבוד לעולם.'
      : 'הסוד הנוכחי יפסיק לעבוד מיד, וכל סוכן שמשתמש בו יצטרך את החדש. השם, ההרשאות והיומן נשמרים.';
    openGeneric({
      title: `סוד חדש — ${k.name}`,
      saveLabel: 'הנפק סוד חדש',
      fields: [
        { name: 'note', type: 'html', html: `<p class="sub">${esc(what)}</p>` },
        { name: 'expires_on', label: 'תוקף עד (ריק = בלי תפוגה)', type: 'date', value: suggestedExpiry(k) },
      ],
      onSave: async (v) => {
        const out = await api(`/api-keys/${k.id}/renew`, { method: 'POST', body: { expires_on: v.expires_on || null } });
        afterSecret(out);
        return false;
      },
    });
  }));

  $$('[data-ak-revoke]').forEach((b) => b.addEventListener('click', run(async () => {
    const k = byId(b.dataset.akRevoke);
    if (!await confirmDialog(`לבטל את "${k.name}"? כל סוכן שמשתמש בו ייחסם מיד. אפשר להחזיר אותו אחר כך רק עם סוד חדש.`,
      { okLabel: 'בטל מפתח', danger: true })) return;
    await api(`/api-keys/${k.id}/revoke`, { method: 'POST' });
    toast('המפתח בוטל.');
    reload();
  })));

  $$('[data-ak-delete]').forEach((b) => b.addEventListener('click', run(async () => {
    const k = byId(b.dataset.akDelete);
    if (!await confirmDialog(`למחוק את "${k.name}" לצמיתות? יומן הבקשות שלו יימחק איתו. הפעולות שעשה נשארות ביומן הפעולות.`,
      { okLabel: 'מחק מפתח', danger: true })) return;
    await api(`/api-keys/${k.id}`, { method: 'DELETE' });
    toast('המפתח נמחק.');
    reload();
  })));
}
