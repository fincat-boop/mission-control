import { $, $$, esc, run, toast } from '../core/dom.js';
import { api } from '../core/api.js';
import { KIND_HE } from '../core/format.js';

/* ========================= ייבוא תוכן מטבלה ========================= */

let impCampaign = null;

export function wireImportDialog() {
  $('#impCancel').addEventListener('click', () => $('#importDlg').close());
  $('#impPick').addEventListener('click', () => $('#impFile').click());

  $('#impFile').addEventListener('change', run(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    // CSV כבר בפורמט שהמערכת מבינה, ואין טעם לשלם על ניתוח.
    // כל השאר — אקסל, וורד, PDF — עובר דרך המודל.
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      $('#impText').value = await file.text();
      return void await checkImport();
    }
    await analyzeFile(file);
  }));

  $('#impCheck').addEventListener('click', run(checkImport));
  // הדבקה היא הדרך הצפויה להגיע לכאן, ולכן היא בודקת מיד
  $('#impText').addEventListener('paste', () => setTimeout(run(checkImport), 60));
}

/**
 * @param {object} campaign
 * @param {Function} reload
 */
export function openImport(campaign, reload) {
  impCampaign = { campaign, reload };
  $('#impCampaign').textContent = `— ${campaign.name}`;
  $('#impText').value = '';
  $('#impResult').innerHTML = '';
  $('#impRun').disabled = true;

  const names = (campaign.channels ?? []).map((c) => c.name);
  $('#impHelp').innerHTML = `
    <b>המבנה שהמערכת מצפה לו</b>
    שורה לכל זווית, עמודה לכל מדיה. התא הוא הניסוח של אותה זווית באותה מדיה.
    <table class="imptable">
      <tr><th>כותרת</th><th>סוג</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>
      <tr><td>המסר הראשון</td><td>ערך</td>${names.map(() => '<td>הניסוח למדיה הזו…</td>').join('')}</tr>
    </table>
    <span>עמודת "סוג" מקבלת ערך / מכירתי / משולב, ואם היא חסרה הכול נחשב ערך.
    תא ריק פירושו שאין גרסה למדיה הזו. שורה שהכותרת שלה כבר קיימת בקמפיין מדולגת,
    כך שאפשר לייבא שוב אחרי תיקון בלי ליצור כפילויות.</span>
    <span><b style="display:inline">אין לך את המבנה הזה?</b>
    העלו את המסמך כמו שהוא — Excel, Word או PDF — והמערכת תפרק אותו לטבלה הזו.
    התוצאה תופיע כאן לעריכה, ורק אחרי שתאשרו היא תיכנס.</span>`;

  $('#impRun').onclick = run(async () => {
    const btn = $('#impRun');
    btn.disabled = true;
    try {
      const res = await api(`/campaigns/${campaign.id}/import`, {
        method: 'POST', body: { text: $('#impText').value },
      });
      $('#importDlg').close();
      toast(`יובאו ${res.created} זוויות · ${res.variants} ניסוחים.`);
      await reload();
    } finally {
      btn.disabled = false;
    }
  });

  $('#importDlg').showModal();
  $('#impText').focus();
}

/** מעלה מסמך לניתוח. התוצאה נוחתת בתיבה, ניתנת לעריכה, ואז נבדקת כרגיל. */
async function analyzeFile(file) {
  const out = $('#impResult');
  const btns = [$('#impPick'), $('#impCheck'), $('#impRun')];
  btns.forEach((b) => { b.disabled = true; });
  out.innerHTML = `<div class="impbox loading">
      <span class="spinner"></span>
      <span>קורא את "${esc(file.name)}" ומפרק אותו… מסמך ארוך יכול לקחת דקה.</span>
    </div>`;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/campaigns/${impCampaign.campaign.id}/import/analyze`,
      { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'הניתוח נכשל');

    $('#impText').value = data.tsv;
    const cost = data.usage?.usd
      ? ` · עלות הניתוח ${data.usage.usd < 0.01 ? '<$0.01' : `$${data.usage.usd.toFixed(2)}`}`
      : '';
    out.innerHTML = `<div class="impbox ok"><b>זוהו ${data.count} זוויות</b>
        ${esc(data.layout)}${esc(cost)}</div>` +
      (data.notes?.length
        ? `<div class="impbox warn"><b>מה שכדאי לבדוק</b>${
            data.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`
        : '');
  } catch (e) {
    out.innerHTML = `<div class="impbox bad">${esc(e.message)}</div>`;
    return;
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    $('#impRun').disabled = true;
  }
  // הטבלה בתיבה — עכשיו היא עוברת את אותה בדיקה כמו טבלה שהודבקה ביד
  const notes = $('#impResult').innerHTML;
  await checkImport();
  $('#impResult').innerHTML = notes + $('#impResult').innerHTML;
}

async function checkImport() {
  const text = $('#impText').value.trim();
  const out = $('#impResult');
  $('#impRun').disabled = true;
  if (!text) { out.innerHTML = ''; return; }

  let plan;
  try {
    plan = await api(`/campaigns/${impCampaign.campaign.id}/import/preview`,
      { method: 'POST', body: { text } });
  } catch (e) {
    out.innerHTML = `<div class="impbox bad">${esc(e.message)}</div>`;
    return;
  }

  const t = plan.totals;
  const list = (title, items, cls) => items.length
    ? `<div class="impbox ${cls}"><b>${esc(title)}</b>${
        items.slice(0, 6).map((x) => `<div>${esc(x)}</div>`).join('')}${
        items.length > 6 ? `<div>ועוד ${items.length - 6}…</div>` : ''}</div>`
    : '';

  const sample = plan.items.slice(0, 3).map((i) =>
    `<tr><td>${esc(i.title)}</td><td>${esc(KIND_HE[i.kind])}</td>
         <td>${i.variants.length ? esc(i.variants.map((v) => v.channel_name).join(', ')) : '—'}</td></tr>`
  ).join('');

  out.innerHTML = `
    <div class="impbox ${t.errors ? 'bad' : 'ok'}">
      <b>${t.errors ? 'יש שגיאות — שום דבר לא ייובא' : `ייווצרו ${t.to_create} זוויות ו-${t.variants} ניסוחים`}</b>
      זוהו ${t.rows} שורות · מדיות שזוהו: ${plan.columns.channels.join(', ') || 'אין'}
    </div>
    ${list('שגיאות', plan.errors, 'bad')}
    ${list('שורות שידולגו', plan.skipped, '')}
    ${list('שים לב', plan.warnings, 'warn')}
    ${sample ? `<table class="imptable"><tr><th>כותרת</th><th>סוג</th><th>ניסוחים</th></tr>${sample}</table>` : ''}`;

  $('#impRun').disabled = t.errors > 0 || t.to_create === 0;
}
