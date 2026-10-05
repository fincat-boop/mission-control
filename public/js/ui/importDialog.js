import { $, esc, run, toast, toastAction } from '../core/dom.js';
import { api } from '../core/api.js';
import { KIND_HE } from '../core/format.js';
import { state } from '../core/state.js';

/* ========================= ייבוא תוכן מטבלה ========================= */

let impCampaign = null;
// הטקסט שהתצוגה המקדימה בדקה — "ייבא" פתוח רק כשזה בדיוק מה שבתיבה
let checkedText = null;

const markReady = () => !!$('#impReady')?.checked;

/** התצוגה המקדימה כבר לא מתארת את מה שבתיבה — בודקים שוב לפני ייבוא */
function invalidate() {
  if (checkedText === null) return;
  checkedText = null;
  $('#impRun').disabled = true;
  const out = $('#impResult');
  if (out.innerHTML.trim()) {
    out.innerHTML = `<div class="impbox warn"><b>הטבלה השתנתה</b>
      לוחצים "בדוק" כדי לראות מה ייובא עכשיו.</div>`;
  }
}

/** "לסמן כמוכן" — נשתל פעם אחת מעל כפתורי הדיאלוג (הדיאלוג עצמו ב-index.html) */
function ensureReadyOption() {
  if ($('#impReady')) return;
  const row = document.createElement('label');
  row.className = 'cbline imp-ready';
  row.innerHTML = `<input type="checkbox" id="impReady">
    <span>לסמן את הניסוחים כמוכנים לפרסום — רק מה שעובר את בדיקת הערוץ
      (אינסטגרם בלי תמונה, למשל, יישאר טיוטה)</span>`;
  $('#importDlg .dactions').before(row);
  $('#impReady').addEventListener('change', () => {
    // מה ייכנס כמוכן משתנה — אם כבר נבדק, בודקים שוב מיד
    const had = checkedText !== null;
    invalidate();
    if (had) run(checkImport)();
  });
}

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
  // כל שינוי בתיבה מבטל את הבדיקה הקודמת — לא מייבאים לפי תצוגה ישנה
  $('#impText').addEventListener('input', invalidate);
  // הדבקה היא הדרך הצפויה להגיע לכאן, ולכן היא בודקת מיד
  $('#impText').addEventListener('paste', () => setTimeout(run(checkImport), 60));
}

/**
 * @param {object} campaign
 * @param {Function} reload
 */
export function openImport(campaign, reload) {
  impCampaign = { campaign, reload };
  checkedText = null;
  ensureReadyOption();
  $('#impReady').checked = false;
  $('#impCampaign').textContent = `— ${campaign.name}`;
  $('#impText').value = '';
  $('#impResult').innerHTML = '';
  $('#impRun').disabled = true;

  const names = (campaign.channels ?? []).map((c) => c.name);
  $('#impHelp').innerHTML = `
    <b>המבנה שהמערכת מצפה לו</b>
    שורה לכל זווית, עמודה לכל ערוץ. התא הוא הניסוח של אותה זווית באותו ערוץ.
    <table class="imptable">
      <tr><th>כותרת</th><th>סוג</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>
      <tr><td>המסר הראשון</td><td>ערך</td>${names.map(() => '<td>הניסוח לערוץ הזה…</td>').join('')}</tr>
    </table>
    <span>עמודת "סוג" מקבלת ערך / מכירתי / משולב, ואם היא חסרה הכול נחשב ערך.
    עמודת "טקסט" כללית נכנסת לכל ערוץ שאין לו עמודה משלו.
    תא ריק פירושו שאין גרסה לערוץ הזה. הכול נכנס כטיוטה, אלא אם מסמנים "מוכנים" למטה.
    שורה שהכותרת שלה כבר קיימת בקמפיין מדולגת, כך שאפשר לייבא שוב אחרי תיקון
    בלי ליצור כפילויות.</span>
    <span><b style="display:inline">אין לך את המבנה הזה?</b>
    העלו את המסמך כמו שהוא — Excel, Word או PDF — והמערכת תפרק אותו לטבלה הזו.
    התוצאה תופיע כאן לעריכה, ורק אחרי שתאשרו היא תיכנס.</span>`;

  $('#impRun').onclick = run(async () => {
    const btn = $('#impRun');
    const text = $('#impText').value.trim();
    // ביטחון כפול: הכפתור כבוי כשהטקסט השתנה, וגם כאן לא מייבאים בלי בדיקה
    if (text !== checkedText) {
      invalidate();
      throw new Error('הטבלה השתנתה מאז הבדיקה — לוחצים "בדוק" שוב');
    }
    btn.disabled = true;
    let res;
    try {
      res = await api(`/campaigns/${campaign.id}/import`, {
        method: 'POST', body: { text, mark_ready: markReady(), week: state.week },
      });
    } catch (e) {
      btn.disabled = false;
      throw e;
    }
    $('#importDlg').close();
    importedToast(campaign, res, reload);
    await reload();
  });

  $('#importDlg').showModal();
  $('#impText').focus();
}

/**
 * ההודעה אחרי ייבוא: כמה נכנס, מה המנוע שיבץ מזה, ו"בטל ייבוא" — שמבטל
 * קודם את מה שהמנוע שיבץ (אותו מסלול כמו "בטל" של מילוי) ואז מוחק את
 * הזוויות של הייבוא שלא נערכו מאז.
 */
function importedToast(campaign, res, reload) {
  const fill = res.engine ?? {};
  const drafts = res.variants - (res.ready ?? 0);
  const parts = [`יובאו ${res.created} זוויות · ${res.variants} ניסוחים`];
  parts.push(res.ready ? `${res.ready} מוכנים, ${drafts} טיוטות` : 'כולם טיוטות');
  const placed = (fill.placed ?? 0) + (fill.attached ?? 0);
  const engine = placed ? ` המנוע שיבץ מהם ${placed} פוסטים.` : '';
  toastAction(`${parts.join(' — ')}.${engine}`, 'בטל ייבוא', run(async () => {
    if (fill.created_items?.length || fill.attached_items?.length) {
      await api('/engine/undo', { method: 'POST', body: {
        created: fill.created_items ?? [], attached: fill.attached_items ?? [] } });
    }
    const r = await api(`/campaigns/${campaign.id}/import/${res.batch}`, { method: 'DELETE' });
    toast(r.kept
      ? `הייבוא בוטל: ${r.removed} זוויות נמחקו, ${r.kept} נשארו — נערכו או שובצו מאז.`
      : `הייבוא בוטל — ${r.removed} זוויות נמחקו.`);
    await reload();
  }), 12000);
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
  checkedText = null;
  if (!text) { out.innerHTML = ''; return; }

  let plan;
  try {
    plan = await api(`/campaigns/${impCampaign.campaign.id}/import/preview`,
      { method: 'POST', body: { text, mark_ready: markReady() } });
  } catch (e) {
    out.innerHTML = `<div class="impbox bad">${esc(e.message)}</div>`;
    return;
  }
  // הטקסט השתנה בזמן שהבדיקה רצה — התשובה כבר לא שלו
  if ($('#impText').value.trim() !== text) return;

  const t = plan.totals;
  const list = (title, items, cls) => items.length
    ? `<div class="impbox ${cls}"><b>${esc(title)}</b>${
        items.slice(0, 6).map((x) => `<div>${esc(x)}</div>`).join('')}${
        items.length > 6 ? `<div>ועוד ${items.length - 6}…</div>` : ''}</div>`
    : '';

  // ערוץ שהניסוח שלו בא מעמודת הטקסט הכללית מסומן "(כללי)"
  const sample = plan.items.slice(0, 3).map((i) =>
    `<tr><td>${esc(i.title)}</td><td>${esc(KIND_HE[i.kind])}</td>
         <td>${i.variants.length ? esc(i.variants.map((v) =>
           `${v.channel_name}${v.from_general ? ' (כללי)' : ''}`).join(', ')) : '—'}</td></tr>`
  ).join('');
  const readyNote = t.ready ? `${t.ready} מוכנים, ${t.variants - t.ready} טיוטות` : 'כטיוטות';

  out.innerHTML = `
    <div class="impbox ${t.errors ? 'bad' : 'ok'}">
      <b>${t.errors ? 'יש שגיאות — שום דבר לא ייובא'
        : `ייווצרו ${t.to_create} זוויות ו-${t.variants} ניסוחים (${readyNote})`}</b>
      זוהו ${t.rows} שורות · ערוצים שזוהו: ${plan.columns.channels.join(', ') || 'אין'}
    </div>
    ${list('שגיאות', plan.errors, 'bad')}
    ${list('שורות שידולגו', plan.skipped, '')}
    ${list('שים לב', plan.warnings, 'warn')}
    ${sample ? `<table class="imptable"><tr><th>כותרת</th><th>סוג</th><th>ניסוחים</th></tr>${sample}</table>` : ''}`;

  checkedText = text;
  $('#impRun').disabled = t.errors > 0 || t.to_create === 0;
}
