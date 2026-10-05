import { api } from '../core/api.js';
import { $, esc, run, toast } from '../core/dom.js';
import { can, state } from '../core/state.js';
import { confirmDialog } from '../core/confirm.js';
import { openGeneric } from './dialog.js';
import { cleanFillValues, initMessage, newsletterHubTag, newsletterPostAction,
         readFillMessage, seedValues } from '../core/hubFill.js';

/**
 * ניוזלטר בלוח מול ה-HUB:
 *   - עורך המייל הוא של ה-HUB עצמו, בחלון חדש (openHubFill) — תמיד מעודכן
 *     ל-HUB, והערכים חוזרים ונשמרים כאן (meta של הגרסה).
 *   - התצוגה המקדימה מרונדרת ב-HUB (mountHubPreview) — מה שרואים הוא מה שיישלח.
 *   - "העבר ל-HUB" (transferToHub) — רק אז נוצרת שם טיוטה לאישור.
 * הכללים הטהורים (פרוטוקול ההודעות, תגיות מצב) ב-core/hubFill.js.
 */

/* ========================= הגדרות ה-HUB (תבנית, עורך) ========================= */

let setupCache = null; // { at, value }

/** תבנית הניוזלטר + כתובת העורך + המקורות המורשים. תקלת HUB → error, לא חריגה */
export async function hubNewsletterSetup() {
  const now = Date.now();
  if (setupCache && now - setupCache.at < 60000) return setupCache.value;
  try {
    const value = await api('/publish/newsletter-template');
    setupCache = { at: now, value };
    return value;
  } catch (e) {
    return { template: null, fill_url: null, hub_origins: [], error: e.message };
  }
}

/* ========================= עורך המייל של ה-HUB (חלון חדש) ========================= */

let session = null; // החלון הפתוח היחיד: { win, onMessage, poll, watchdog, ready, saved }

function endSession() {
  if (!session) return;
  window.removeEventListener('message', session.onMessage);
  clearInterval(session.poll);
  clearTimeout(session.watchdog);
  session = null;
}

/**
 * פותח את עורך המייל של ה-HUB בחלון חדש — לא iframe: עוגיות ההתחברות של
 * ה-HUB (sameSite=lax) לא נשלחות בתוך מסגרת חוצת-אתרים. החלון מדבר איתנו
 * בהודעות (ראו core/hubFill.js); מקבלים רק ממקורות ה-HUB ורק מהחלון הזה.
 *
 * onStatus: 'opening' | 'blocked' | 'ready' | 'silent' (לא יצר קשר) |
 *           'closed' | 'closed-saved'
 * @param {{fillUrl:string, origins:string[], values:()=>object,
 *          onSave:(values:object)=>void, onStatus?:(s:string)=>void}} o
 */
export function openHubFill({ fillUrl, origins, values, onSave, onStatus = () => {} }) {
  if (!fillUrl || !origins?.length) {
    toast('עורך המייל של ה-HUB לא מוגדר בשרת (HUB_API_URL).', true);
    return;
  }
  endSession();
  const win = window.open(fillUrl, 'mc-hub-fill', 'popup,width=1280,height=900');
  if (!win) {
    onStatus('blocked');
    return;
  }
  const s = { win, ready: false, saved: false };
  s.onMessage = (e) => {
    const msg = readFillMessage(e, { origins, source: win });
    if (!msg) return;
    if (msg.type === 'ready') {
      s.ready = true;
      clearTimeout(s.watchdog);
      // עונים למקור שאומת בלבד — לא '*'
      win.postMessage(initMessage(values()), e.origin);
      onStatus('ready');
    } else {
      s.saved = true;
      onSave(msg.values);
    }
  };
  window.addEventListener('message', s.onMessage);
  // התחברות ל-HUB באמצע לוקחת זמן — רק אחרי חצי דקה של שקט אומרים משהו
  s.watchdog = setTimeout(() => { if (!s.ready) onStatus('silent'); }, 30000);
  s.poll = setInterval(() => {
    if (!win.closed) return;
    const saved = s.saved;
    if (session === s) endSession();
    onStatus(saved ? 'closed-saved' : 'closed');
  }, 800);
  session = s;
  win.focus?.();
  onStatus('opening');
}

/* ========================= תצוגה מקדימה מה-HUB ========================= */

/**
 * תצוגה מקדימה שה-HUB מרנדר (newsletter-preview): iframe מבודד בלי
 * סקריפטים. input() מחזיר את גוף הבקשה, או null כשאין עדיין מה להציג.
 * מונה ריצות מגן מפני מרוץ — תשובה איטית ישנה לא דורסת חדשה.
 */
export function mountHubPreview(host, input, { head = 'תצוגה מקדימה — כך ייראה המייל אצל הנמען' } = {}) {
  host.classList.add('hubpv');
  host.innerHTML = `<div class="lp-head">${esc(head)}</div>
    <div class="lp-warn" hidden></div><div class="lp-frame"></div>`;
  const warn = host.querySelector('.lp-warn');
  const wrap = host.querySelector('.lp-frame');
  let seq = 0;
  let timer = null;

  const refresh = async () => {
    const my = ++seq;
    const body = input();
    if (!body) {
      wrap.replaceChildren();
      warn.hidden = false;
      warn.textContent = 'אין עדיין תוכן להצגה.';
      return;
    }
    try {
      const preview = await api('/publish/newsletter-preview', { method: 'POST', body });
      if (my !== seq) return;
      warn.hidden = true;
      // iframe חדש בכל רענון: ניווט של iframe קיים נערם בהיסטוריית הדפדפן
      const frame = document.createElement('iframe');
      frame.title = 'תצוגה מקדימה של המייל';
      // allow-same-origin בלבד: בלעדיו המקור אטום וקוקי ה-session לא נשלח (401);
      // סקריפטים חסומים גם כאן וגם ב-CSP של הנתיב
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.src = `/api/publish/newsletter-frame/${preview.frame_token}`;
      wrap.replaceChildren(frame);
    } catch (e) {
      if (my !== seq) return;
      warn.hidden = false;
      warn.textContent = `התצוגה לא נטענה: ${e.message}`;
    }
  };
  refresh();
  return {
    refresh,
    queue: () => { clearTimeout(timer); timer = setTimeout(refresh, 600); },
  };
}

/** גוף בקשת התצוגה לפוסט/גרסה — אותו מה שיישלח ב"העבר ל-HUB" */
export function previewInput({ subject, body, title, scheduledAt, templateId, fieldValues }) {
  const values = cleanFillValues(fieldValues);
  if (!String(body ?? '').trim() && !Object.keys(values).length && !templateId) return null;
  return {
    subject: subject ?? '', htmlBody: body ?? '', name: title,
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(templateId ? { templateId } : {}),
    fieldValues: values,
  };
}

/* ========================= העבר ל-HUB ========================= */

const shortWhen = (d) => new Date(d).toLocaleString('he-IL',
  { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * "העבר ל-HUB" לפוסט אחד — אחרי אישור בחלון. מחזיר את תשובת השרת, או null
 * אם המשתמש ביטל. שגיאה (חסר נושא, ה-HUB סירב) עולה למעלה עם ההודעה שלה.
 */
export async function transferToHub(post) {
  const ok = await confirmDialog(
    `להעביר את הניוזלטר ל-HUB? תיווצר שם טיוטה עם המועד ${shortWhen(post.scheduled_at)}, ` +
    'ובעל העסק יאשר אותה שם. אחרי ההעברה שינויים כאן כבר לא יגיעו ל-HUB.',
    { okLabel: 'העבר ל-HUB' });
  if (!ok) return null;
  const r = await api(`/posts/${post.id}/newsletter/transfer`, { method: 'POST' });
  toast(r.idempotent ? 'הניוזלטר כבר הועבר ל-HUB — ממתין לאישור שם.'
    : r.reused ? 'חובר מחדש לקמפיין שכבר היה ב-HUB — ממתין לאישור שם. שינויים מאז ההעברה הקודמת לא הגיעו אליו.'
      : 'הועבר ל-HUB ✓ — ממתין לאישור שם.');
  return r;
}

/** הקישור למסך האישור ב-HUB — בחלון חדש, בלי גישה חזרה אלינו */
export const openInHub = (url) => { if (url) window.open(url, '_blank', 'noopener'); };

/**
 * שורות המצב של ניוזלטר בחלון הפוסט (HTML מוכן). null — לא ניוזלטר.
 * transferred: ממתין לאישור / אושר / נשלח + קישור, ואזהרה אם השתנה משהו
 * בלוח אחרי ההעברה. לא הועבר: מה הצעד הבא.
 */
export function newsletterPostNotes(post) {
  if (post.platform !== 'newsletter') return null;
  const tag = newsletterHubTag(post);
  if (tag) {
    const link = post.external_url
      ? ` <a href="${esc(post.external_url)}" target="_blank" rel="noopener">פתח ב-HUB</a>` : '';
    return `<div class="${tag.tone === 'warn' ? 'pvwarn' : 'pvauto'}">${esc(tag.text)}${link}</div>
      ${post.hub_stale ? `<div class="pvwarn">שינויים שנשמרו בלוח אחרי ההעברה לא הגיעו ל-HUB —
        משנים אותם שם, במסך האישור.</div>` : ''}`;
  }
  if (['scheduled', 'approved'].includes(post.status) && new Date(post.scheduled_at) > new Date()) {
    return `<div class="pvnote">הניוזלטר נשמר בלוח ועוד לא נשלח לשום מקום. סמוך למועד לוחצים
      "העבר ל-HUB" — שם נוצרת טיוטה עם המועד הזה, ובעל העסק מאשר אותה.</div>`;
  }
  return '';
}

/* ========================= עורך הניוזלטר ========================= */

/** מה כותבים ליד "ערוך מייל ב-HUB" בכל שלב של חלון העורך */
const STATUS_NOTE = {
  opening: 'העורך נפתח בחלון חדש…',
  ready: 'העורך של ה-HUB פתוח. בסיום לוחצים שם "שמור וחזור ללוח".',
  silent: 'העורך של ה-HUB לא יצר קשר עם הלוח. אם התבקשת להתחבר שם — מתחברים ולוחצים שוב "ערוך מייל ב-HUB".',
  blocked: 'הדפדפן חסם את החלון החדש — מאשרים חלונות קופצים לאתר הזה ולוחצים שוב.',
  closed: 'העורך נסגר בלי שמירה.',
  'closed-saved': 'התוכן מה-HUB נשמר בלוח ✓',
};


const VARIANT_STATUS = [['draft', 'טיוטה'], ['ready', 'מוכן לשליחה'], ['not_relevant', 'לא רלוונטי למדיה הזו']];

/** שורת מצב: נקודה + טקסט (בלי קפסולה) */
const dotLine = (cls, text, title = '') =>
  `<span class="sdot-line ${cls}"${title ? ` title="${esc(title)}"` : ''}><i></i>${esc(text)}</span>`;

function postStateLine(p) {
  const tag = newsletterHubTag(p);
  if (tag) return dotLine(tag.tone === 'warn' ? 'warn' : 'on', tag.label);
  if (p.status === 'published') return dotLine('on', 'נשלח ✓');
  if (p.status === 'failed') return dotLine('bad', 'נכשל', p.publish_error ?? '');
  return dotLine('', 'עוד לא הועבר ל-HUB');
}

/**
 * עורך הניוזלטר של גרסה (תוכן × ערוץ מייל): נושא, מצב, עורך המייל של
 * ה-HUB (או גוף HTML חופשי כשאין תבנית), תצוגה מה-HUB, והפוסטים המשובצים
 * עם "העבר ל-HUB" / "ממתין לאישור ב-HUB".
 * נקודת הכניסה היחידה מהלוח (plan.js) — כל עריכה של גרסת ניוזלטר עוברת כאן.
 * @param {{item:object, channelId:number, reload:()=>Promise<void>}} o
 */
export async function openNewsletterEditor({ item, channelId, reload }) {
  const channel = state.channels.find((c) => c.id === channelId);
  let v = item.variants?.find((x) => x.channel_id === channelId) ?? null;
  const setup = await hubNewsletterSetup();
  const template = setup.template;
  const fields = template?.fields ?? [];

  // מה ששמור בשרת — הבסיס לכל שמירה, ולזיהוי "יש שינויים שלא נשמרו"
  let saved = { meta: { ...(v?.meta ?? {}) }, status: v?.status ?? 'draft', body: v?.body ?? '' };
  let values = seedValues(saved.meta.field_values, saved.body, fields);

  const filledCount = () => Object.keys(cleanFillValues(values)).length;
  // החלון הזה עדיין מוצג (ולא עורך אחר שנפתח מאז בדיאלוג המשותף)
  const token = String(Math.random()).slice(2);
  const alive = () => $('#hfPosts')?.dataset.hf === token;
  const firstPostAt = { value: null }; // המועד של הפוסט הקרוב — ל-[[תאריך]] בתצוגה

  /** PUT לגרסה. partial: subject/status/body; values — מהזיכרון */
  async function saveVariant({ subject, status, body }) {
    const meta = {
      ...saved.meta,
      subject: (subject ?? saved.meta.subject ?? '') || null,
      ...(template ? { field_values: cleanFillValues(values), template_id: template.id } : {}),
    };
    const r = await api(`/content/${item.id}/variants/${channelId}`, {
      method: 'PUT',
      body: {
        body: body ?? saved.body ?? null,
        status: status ?? saved.status,
        meta,
        week: state.week,
        // נעילה אופטימית (כשהשרת תומך) — שמירה מחלון ישן לא דורסת חדשה
        ...(v?.updated_at ? { base_updated_at: v.updated_at } : {}),
      },
    });
    v = r.variant ?? v;
    saved = { meta: { ...(v?.meta ?? meta) }, status: v?.status ?? status, body: v?.body ?? body ?? '' };
  }

  const formState = () => ({
    subject: $('#gen_subject')?.value.trim() ?? '',
    status: $('#gen_status')?.value ?? saved.status,
    body: template ? saved.body : ($('#gen_body')?.value ?? ''),
  });
  const dirty = () => {
    const f = formState();
    return f.subject !== (saved.meta.subject ?? '') || f.status !== saved.status ||
      (!template && f.body.trim() !== (saved.body ?? '').trim());
  };

  const hubBlock = () => {
    if (setup.error) {
      return `<div class="hubfill"><div class="pvwarn">ה-HUB לא זמין כרגע (${esc(setup.error)}) —
        אפשר לשמור נושא ומצב, ולערוך את המייל כשהחיבור יחזור.</div></div>`;
    }
    return `<div class="hubfill" id="hfBox">
      <div class="hubfill-head"><b>תוכן המייל</b>
        <span class="d" id="hfCount">${filledCount() ? `${filledCount()} שדות מולאו` : 'עוד לא מולא'}</span></div>
      <div class="fhint">המייל נכתב בעורך של ה-HUB, על התבנית "${esc(template.name ?? '')}". הוא נפתח
        בחלון חדש, ו"שמור וחזור ללוח" שם שומר את התוכן כאן.</div>
      <div class="hubfill-acts">
        <button type="button" class="btn small primary" id="hfOpen">ערוך מייל ב-HUB</button>
        <span class="hubfill-note" id="hfNote" aria-live="polite"></span>
      </div></div>`;
  };

  let preview = null;
  const previewBody = () => {
    const f = formState();
    return previewInput({
      subject: f.subject, body: f.body, title: item.title, scheduledAt: firstPostAt.value,
      templateId: template?.id ?? saved.meta.template_id ?? null, fieldValues: template ? values : {},
    });
  };

  const setNote = (text, bad = false) => {
    const el = alive() ? $('#hfNote') : null;
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', bad);
  };

  const loadPosts = () => api(`/publish/newsletter-posts?content_id=${item.id}&channel_id=${channelId}`)
    .then((r) => r.posts);
  /** המועד של הפוסט הקרוב — ל-[[תאריך]] בתצוגה, כמו שיישלח */
  const notePostAt = (posts) => {
    const upcoming = posts.find((p) => new Date(p.scheduled_at) > new Date()) ?? posts.at(-1);
    if (!upcoming || firstPostAt.value === upcoming.scheduled_at) return false;
    firstPostAt.value = upcoming.scheduled_at;
    return true;
  };

  async function renderPosts(preloaded = null) {
    if (!alive()) return;
    const box = $('#hfPosts');
    let posts = preloaded;
    try {
      posts ??= await loadPosts();
    } catch (e) {
      box.innerHTML = `<div class="pvwarn">לא הצלחנו לטעון את מצב השליחה: ${esc(e.message)}</div>`;
      return;
    }
    if (!alive()) return;
    if (notePostAt(posts)) preview?.queue();
    const transferred = posts.some((p) => p.status === 'publishing' && p.external_id);
    const intro = transferred
      ? '<div class="pvwarn">הניוזלטר כבר הועבר ל-HUB — שינויים שתשמור כאן לא יגיעו לשם. משנים במסך האישור ב-HUB.</div>'
      : '<div class="fhint">שום דבר לא נשלח ולא נוצר ב-HUB עד "העבר ל-HUB". לוחצים סמוך למועד — שם נוצרת טיוטה עם המועד של הפוסט, ובעל העסק מאשר אותה.</div>';
    if (!posts.length) {
      box.innerHTML = `<div class="hubposts-head"><b>שליחה דרך ה-HUB</b></div>
        <div class="fhint">הניוזלטר עוד לא משובץ בלוח. אחרי שהוא משובץ, מעבירים אותו מכאן ל-HUB לאישור.</div>`;
      return;
    }
    box.innerHTML = `<div class="hubposts-head"><b>שליחה דרך ה-HUB</b></div>${intro}
      ${posts.map((p) => {
        const act = newsletterPostAction(p, { ready: saved.status === 'ready', subject: saved.meta.subject ?? '' });
        const btn = act.action === 'open'
          ? `<a class="btn small" href="${esc(p.external_url)}" target="_blank" rel="noopener">פתח ב-HUB</a>`
          : act.action === 'transfer' && can('approve')
            ? `<button type="button" class="btn small primary" data-hf-transfer="${p.id}">העבר ל-HUB</button>`
            : `<span class="d">${esc(act.action === 'transfer' ? 'העברה ל-HUB דורשת הרשאת אישור' : act.reason ?? '')}</span>`;
        return `<div class="hubpost">
          <span class="when">${esc(shortWhen(p.scheduled_at))}</span>
          ${postStateLine(p)}
          <span class="act">${btn}</span>
          ${p.hub_stale && p.status === 'publishing'
            ? '<div class="pvwarn">השתנה כאן משהו אחרי ההעברה — השינוי לא הגיע ל-HUB.</div>' : ''}
        </div>`;
      }).join('')}`;
    for (const b of box.querySelectorAll('[data-hf-transfer]')) {
      b.addEventListener('click', run(async () => {
        if (dirty()) return toast('יש שינויים שלא נשמרו — שומרים קודם, ואז מעבירים ל-HUB.', true);
        const post = posts.find((p) => p.id === Number(b.dataset.hfTransfer));
        b.disabled = true;
        try {
          if (await transferToHub(post)) await renderPosts();
        } finally {
          b.disabled = false;
        }
      }));
    }
  }

  /** ערכים שחזרו מעורך ה-HUB — נשמרים מיד בגרסה (נושא מהטופס, מצב כמו ששמור) */
  async function onFillSave(newValues) {
    values = newValues;
    try {
      await saveVariant({ subject: alive() ? formState().subject : undefined });
      if (alive()) {
        $('#hfCount').textContent = filledCount() ? `${filledCount()} שדות מולאו` : 'עוד לא מולא';
        setNote('התוכן מה-HUB נשמר בלוח ✓');
        preview?.queue();
        renderPosts();
      }
      toast('התוכן מעורך ה-HUB נשמר בלוח.');
      await reload();
    } catch (e) {
      if (alive()) setNote(`השמירה נכשלה: ${e.message}`, true);
      toast(`שמירת התוכן מה-HUB נכשלה: ${e.message}`, true);
    }
  }


  // הפוסטים נטענים לפני הפתיחה — כדי שהתצוגה הראשונה כבר תהיה עם המועד שלהם
  const firstPosts = await loadPosts().catch(() => null);
  if (firstPosts) notePostAt(firstPosts);

  openGeneric({
    title: `${item.title} — ${channel?.name ?? 'ניוזלטר'}`,
    fields: [
      { name: 'subject', label: 'נושא המייל', type: 'text', value: saved.meta.subject,
        hint: 'הניוזלטר נשלח לרשימה הכללית (רשימת העל) ב-HUB' },
      ...(template || setup.error
        ? [{ name: 'hubfill', type: 'html', html: hubBlock() }]
        : [{ name: 'body', label: 'גוף המייל (HTML)', type: 'textarea', value: saved.body }]),
      { name: 'status', label: 'מצב', type: 'select', value: saved.status, options: VARIANT_STATUS },
      { name: 'hubposts', type: 'html', html: `<div class="hubposts" id="hfPosts" data-hf="${token}"><div class="fhint">טוען…</div></div>` },
    ],
    onSave: async (val) => {
      await saveVariant({ subject: val.subject ?? '', status: val.status, body: template ? undefined : val.body ?? '' });
      await reload();
      return val.status === 'ready' ? 'נשמר ומסומן מוכן — סמוך למועד מעבירים ל-HUB.' : 'נשמר.';
    },
    onOpen: () => {
      // עמודת התצוגה מה-HUB, משמאל לטופס (אותה פריסה כמו עריכת גרסה)
      const dlg = $('#genDlg');
      dlg.classList.add('with-live-preview');
      const pane = document.createElement('div');
      pane.id = 'livePreviewPane';
      dlg.insertBefore(pane, dlg.querySelector('.dactions'));
      preview = mountHubPreview(pane, previewBody);
      for (const sel of ['#gen_subject', '#gen_body']) $(sel)?.addEventListener('input', () => preview.queue());

      $('#hfOpen')?.addEventListener('click', () => openHubFill({
        fillUrl: setup.fill_url,
        origins: setup.hub_origins,
        values: () => values,
        onSave: (vals) => { onFillSave(vals); },
        onStatus: (s) => setNote(STATUS_NOTE[s] ?? '', ['silent', 'blocked'].includes(s)),
      }));
      renderPosts(firstPosts);
    },
  });
}
