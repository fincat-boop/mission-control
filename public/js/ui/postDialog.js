import { $, copyLinkButton, esc, run, toast, wireCopyLinks } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { api } from '../core/api.js';
import { can, epColor, state } from '../core/state.js';
import { goToTab, refreshAfterPostChange } from '../ui/refresh.js';
import { isImage, isVideo } from '../core/format.js';

/* ========================= תצוגת פוסט מהלוח ========================= */

let previewPost = null;

/* פעולות הפוסט — פונקציות במפה אחת; הפוטר בוחר מי ראשית, מי משנית ומה בתפריט */
const ACT = {
  approve: {
    label: 'אשר לשליחה אוטומטית ⚡',
    run: async (post) => {
      await api(`/posts/${post.id}/approve-publish`, { method: 'POST' });
      toast('אושר — הפוסט יישלח אוטומטית במועד שנקבע. ⚡');
    },
  },
  unapprove: {
    label: 'בטל אישור שליחה',
    run: async (post) => {
      await api(`/posts/${post.id}/unapprove-publish`, { method: 'POST' });
      toast('האישור בוטל — הפוסט חזר למתוכנן ולא יישלח.');
    },
  },
  publishNow: {
    label: 'פרסם עכשיו',
    run: async (post) => {
      if (!(await confirmDialog('לפרסם את הפוסט עכשיו, ישירות לערוץ? הפעולה מיידית.'))) return false;
      const res = await api(`/posts/${post.id}/publish-now`, { method: 'POST' });
      toast(res.pending ? 'נשלח ל-HUB ✓ — הפוסט יסומן "פורסם" כשהשליחה תושלם שם.' : 'פורסם! ✓');
    },
  },
  markPublished: {
    label: 'סמן כפורסם',
    run: async (post) => {
      await api(`/posts/${post.id}/publish`, { method: 'POST' });
      toast('סומן כפורסם.');
    },
  },
  unpublish: {
    label: 'בטל סימון פורסם',
    run: async (post) => {
      await api(`/posts/${post.id}/unpublish`, { method: 'POST' });
      toast('הפרסום בוטל, השיבוץ חזר למתוכנן.');
    },
  },
  openContent: {
    label: '✏️ פתח בתוכן',
    keepOpen: true,
    run: async (post) => {
      if (!post.content_id) return toast('לשיבוץ הזה אין תוכן משויך.', true);
      $('#postDlg').close();
      const { content } = await api('/content');
      const item = content.find((c) => c.id === post.content_id);
      state.planCampaign = item?.campaign_id ?? null;
      state.planEndpoint = item?.endpoint_id ?? null;
      state.planBackground = !item?.campaign_id;
      await goToTab('plan');
      return false; // הניווט כבר קרה — בלי רענון לוח מיותר
    },
  },
  remove: {
    label: 'הסר מהלוח',
    danger: true,
    run: async (post) => {
      if (!(await confirmDialog('להסיר את השיבוץ מהלוח? התוכן עצמו יישאר.', { danger: true }))) return false;
      const res = await api(`/posts/${post.id}`, { method: 'DELETE', body: { week: state.week } });
      toast('השיבוץ הוסר.' + (res.engine?.placed ? ' המנוע מילא את המקום שהתפנה.' : ''));
    },
  },
};

async function runAction(key) {
  if (!previewPost) return;
  const done = await ACT[key].run(previewPost);
  if (done === false) return;
  $('#postDlg').close();
  $('#pMenu').hidden = true;
  await refreshAfterPostChange();
}

export function wirePostDialog() {
  $('#pClose').addEventListener('click', () => $('#postDlg').close());

  $('#pMoreBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#pMenu').hidden = !$('#pMenu').hidden;
  });
  // לחיצה בכל מקום אחר סוגרת את תפריט "עוד"
  document.addEventListener('click', () => { $('#pMenu').hidden = true; });

  // תוצאות בפועל — שדה ריק נשלח כ-null מפורש, לא כאפס
  $('#rSave').addEventListener('click', run(async () => {
    if (!previewPost) return;
    const val = (id) => {
      const raw = $(id).value.trim();
      return raw === '' ? null : Number(raw);
    };
    await api(`/posts/${previewPost.id}/results`, {
      method: 'PUT',
      body: {
        reach: val('#rReach'), engagement: val('#rEngagement'),
        clicks: val('#rClicks'), leads: val('#rLeads'),
        note: $('#rNote').value.trim() || null,
      },
    });
    $('#rClear').hidden = false;
    toast('התוצאות נשמרו.');
  }));

  $('#rClear').addEventListener('click', run(async () => {
    if (!previewPost) return;
    if (!(await confirmDialog('למחוק את המדידה של הפוסט הזה?', { danger: true }))) return;
    await api(`/posts/${previewPost.id}/results`, { method: 'DELETE' });
    for (const id of ['#rReach', '#rEngagement', '#rClicks', '#rLeads', '#rNote']) $(id).value = '';
    $('#rClear').hidden = true;
    toast('המדידה נמחקה.');
  }));
}

/** צ'יפ הסטטוס בכותרת */
const STATUS_CHIP = {
  scheduled: ['מתוכנן', ''],
  approved: ['⚡ מאושר לשליחה', 'good'],
  publishing: ['בשליחה…', 'good'],
  published: ['פורסם ✓', 'good'],
  failed: ['נכשל', 'crit'],
};

/** מה שאמור לצאת: הטקסט של המדיה הזו והקבצים שלה */
export async function openPostPreview(postId) {
  $('#postDlgTitle').textContent = 'טוען…';
  $('#postPreview').innerHTML = '';
  $('#pMoreBtn').hidden = true;
  $('#pResults').hidden = true;
  $('#postDlg').showModal();

  const { post, variant, assets, results } = await api(`/posts/${postId}/preview`);
  previewPost = post;

  /*
   * כל הפעולות הרלוונטיות למצב — בתפריט "פעולות" אחד. הסדר: קודם מה
   * שהמצב מזמין, עריכה באמצע, הסרה אחרונה אחרי מפריד.
   */
  const autoCapable = ['facebook', 'instagram', 'newsletter'].includes(post.platform)
    && post.autopub_connected;
  const menu = [];

  if (['scheduled', 'failed'].includes(post.status)) {
    if (can('approve') && autoCapable) menu.push('approve', 'publishNow');
    if (can('content')) menu.push('markPublished');
  } else if (post.status === 'approved') {
    if (can('approve')) menu.push('unapprove', 'publishNow');
    if (can('content')) menu.push('markPublished');
  } else if (post.status === 'published') {
    if (can('content')) menu.push('unpublish');
  }
  menu.push('openContent');
  if (can('content') && post.status !== 'publishing') menu.push('remove');

  const menuEl = $('#pMenu');
  menuEl.hidden = true;
  $('#pMoreBtn').hidden = menu.length === 0;
  menuEl.innerHTML = menu.map((key, i) => `${
    ACT[key].danger && i > 0 ? '<div class="sep"></div>' : ''
  }<button type="button" data-act="${key}"${ACT[key].danger ? ' data-danger' : ''}>${esc(ACT[key].label)}</button>`).join('');
  menuEl.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', run(() => runAction(b.dataset.act))));

  const chip = $('#pStatusChip');
  const [chipLabel, chipTone] = STATUS_CHIP[post.status] ?? [null, ''];
  chip.hidden = !chipLabel;
  chip.textContent = chipLabel ?? '';
  chip.dataset.tone = chipTone;

  // תוצאות נמדדות רק למה שכבר יצא לאוויר
  const showResults = can('content') && post.status === 'published';
  $('#pResults').hidden = !showResults;
  if (showResults) {
    const set = (id, v) => { $(id).value = v ?? ''; };
    set('#rReach', results?.reach);
    set('#rEngagement', results?.engagement);
    set('#rClicks', results?.clicks);
    set('#rLeads', results?.leads);
    set('#rNote', results?.note);
    $('#rClear').hidden = !results;
  }

  const when = new Date(post.scheduled_at)
    .toLocaleString('he-IL', { dateStyle: 'full', timeStyle: 'short' });

  // קובץ ב-R2 מוצג ישירות מהקישור הציבורי הקבוע, ולצידו "העתק קישור"
  const media = assets.map((a) => {
    const src = esc(a.url ?? `/api/assets/${a.id}`);
    const el = isImage(a.mime) ? `<img class="pv" src="${src}" alt="${esc(a.filename)}">`
      : isVideo(a.mime) ? `<video class="pv" src="${src}" controls></video>`
      : `<a class="pvfile" href="${src}" target="_blank" rel="noopener">📄 ${esc(a.filename)}</a>`;
    return a.url ? `<div class="pvitem">${el}${copyLinkButton(a.url)}</div>` : el;
  }).join('');

  // ניוזלטר עם תבנית: התוכן חי ב-meta.field_values (ממלא התבניות),
  // לא בגוף הגרסה — מציגים אותו משם, יחד עם הנושא.
  const vMeta = variant?.meta ?? {};
  const filledContent = ['תוכן', 'גוף הגיליון', 'גוף ההודעה']
    .map((k) => String(vMeta.field_values?.[k] ?? '').trim()).find(Boolean);
  const body = variant?.body?.trim() || filledContent;
  const subjectLine = post.platform === 'newsletter' && vMeta.subject
    ? `<div class="pvmeta" style="margin-top:10px">✉️ נושא: <b>${esc(vMeta.subject)}</b></div>` : '';

  $('#postDlgTitle').textContent = post.title;
  $('#postPreview').innerHTML = `
    <div class="pvmeta">
      <span class="sw" style="background:${epColor(post.endpoint_id)}"></span>
      ${esc(post.endpoint_name ?? 'ללא נקודת קצה')} · ${esc(post.channel_name ?? '')}
      ${post.campaign_name ? ` · ${esc(post.campaign_name)}` : ''}
      ${post.evergreen ? ' · ♻' : ''}
    </div>
    <div class="pvwhen">${esc(when)}${
      post.assignee_name ? ` · אחראי: ${esc(post.assignee_name)}` : ''}</div>

    ${subjectLine}
    ${media ? `<div class="pvmedia">${media}</div>` : ''}

    ${body ? `<div class="pvbody">${esc(body)}</div>`
            : `<div class="pvempty">${post.platform === 'newsletter'
                ? 'אין עדיין תוכן לניוזלטר — ממלאים דרך "פתח בתוכן".'
                : 'אין עדיין טקסט לגרסה של המדיה הזו.'}</div>`}

    ${body && variant && variant.status !== 'ready' && post.status !== 'published'
      ? `<div class="pvwarn">הגרסה במצב "${variant.status === 'draft' ? 'טיוטה' : 'לא רלוונטי'}" —
         מסמנים "מוכן" בעריכת התוכן לפני פרסום.</div>` : ''}

    ${post.status === 'approved'
      ? `<div class="pvauto">⚡ מאושר לשליחה אוטומטית${
          post.approved_by_name ? ` — אישר: ${esc(post.approved_by_name)}` : ''}.
          יישלח ב-${esc(when)}.</div>` : ''}
    ${post.status === 'publishing'
      ? (post.platform === 'newsletter'
          ? '<div class="pvauto">📧 התקבל ב-HUB — הניוזלטר בשליחה. הפוסט יסומן "פורסם" אוטומטית כשתושלם.</div>'
          : '<div class="pvauto">🚀 נשלח לערוץ ממש עכשיו…</div>') : ''}
    ${post.status === 'failed'
      ? `<div class="pvwarn"><b>הפרסום האוטומטי נכשל:</b> ${esc(post.publish_error ?? 'ללא פירוט')}
         <br>אפשר לתקן ולאשר שוב, לפרסם עכשיו, או לפרסם ידנית ולסמן "פורסם".</div>` : ''}
    ${post.status === 'published' && post.external_url
      ? `<div class="pvauto">✓ פורסם אוטומטית —
         <a href="${esc(post.external_url)}" target="_blank" rel="noopener">לצפייה בפוסט</a></div>` : ''}`;
  wireCopyLinks($('#postPreview'));
}
