import { $, esc, run, toast } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { api } from '../core/api.js';
import { can, epColor, state } from '../core/state.js';
import { goToTab, refreshAfterPostChange } from '../ui/refresh.js';
import { isImage, isVideo } from '../core/format.js';

/* ========================= תצוגת פוסט מהלוח ========================= */

let previewPost = null;

export function wirePostDialog() {
  $('#pClose').addEventListener('click', () => $('#postDlg').close());

  $('#pDelete').addEventListener('click', run(async () => {
    if (!previewPost) return;
    if (!(await confirmDialog('להסיר את השיבוץ מהלוח? התוכן עצמו יישאר.', { danger: true }))) return;
    const res = await api(`/posts/${previewPost.id}`, { method: 'DELETE', body: { week: state.week } });
    $('#postDlg').close();
    toast('השיבוץ הוסר.' + (res.engine?.placed ? ` המנוע מילא את המקום שהתפנה.` : ''));
    await refreshAfterPostChange();
  }));

  // כפתור יחיד שמתנהג לפי מצב הפוסט: מתוכנן → מסמן פורסם, פורסם → מבטל
  $('#pPublish').addEventListener('click', run(async () => {
    if (!previewPost) return;
    const wasPublished = previewPost.status === 'published';
    const path = wasPublished ? 'unpublish' : 'publish';
    await api(`/posts/${previewPost.id}/${path}`, { method: 'POST' });
    $('#postDlg').close();
    toast(wasPublished ? 'הפרסום בוטל, השיבוץ חזר למתוכנן.' : 'סומן כפורסם.');
    await refreshAfterPostChange();
  }));

  // אישור/ביטול שליחה אוטומטית — פר-פוסט, הרשאת approve
  $('#pApprove').addEventListener('click', run(async () => {
    if (!previewPost) return;
    const approving = previewPost.status !== 'approved';
    const path = approving ? 'approve-publish' : 'unapprove-publish';
    await api(`/posts/${previewPost.id}/${path}`, { method: 'POST' });
    $('#postDlg').close();
    toast(approving
      ? 'אושר — הפוסט יישלח אוטומטית במועד שנקבע. ⚡'
      : 'האישור בוטל — הפוסט חזר למתוכנן ולא יישלח.');
    await refreshAfterPostChange();
  }));

  // שליחה מיידית — בלי לחכות לשעה המתוזמנת
  $('#pPublishNow').addEventListener('click', run(async () => {
    if (!previewPost) return;
    if (!(await confirmDialog('לפרסם את הפוסט עכשיו, ישירות לערוץ? הפעולה מיידית.'))) return;
    const btn = $('#pPublishNow');
    btn.disabled = true;
    btn.textContent = 'שולח…';
    try {
      const res = await api(`/posts/${previewPost.id}/publish-now`, { method: 'POST' });
      $('#postDlg').close();
      // ניוזלטר: ה-HUB קיבל ושולח אצלו — הפוסט ייסגר ל"פורסם" כשהשליחה תושלם
      toast(res.pending ? 'נשלח ל-HUB ✓ — הפוסט יסומן "פורסם" כשהשליחה תושלם שם.' : 'פורסם! ✓');
      await refreshAfterPostChange();
    } finally {
      btn.disabled = false;
      btn.textContent = 'פרסם עכשיו';
    }
  }));

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

  // מהלוח אל התוכן — שם עורכים את הטקסט, ולא בלוח
  $('#pOpenContent').addEventListener('click', run(async () => {
    if (!previewPost?.content_id) return toast('לשיבוץ הזה אין תוכן משויך.', true);
    $('#postDlg').close();
    const { content } = await api('/content');
    const item = content.find((c) => c.id === previewPost.content_id);
    state.planCampaign = item?.campaign_id ?? null;
    state.planEndpoint = item?.endpoint_id ?? null;
    state.planBackground = !item?.campaign_id;
    await goToTab('plan');
  }));
}

/** מה שאמור לצאת: הטקסט של המדיה הזו והקבצים שלה */
export async function openPostPreview(postId) {
  $('#postDlgTitle').textContent = 'טוען…';
  $('#postPreview').innerHTML = '';
  $('#pPublish').hidden = true;
  $('#pResults').hidden = true;
  $('#postDlg').showModal();

  const { post, variant, assets, results } = await api(`/posts/${postId}/preview`);
  previewPost = post;

  const pubBtn = $('#pPublish');
  pubBtn.hidden = !(can('content') && ['scheduled', 'failed', 'published'].includes(post.status));
  pubBtn.textContent = post.status === 'published' ? 'בטל פרסום' : 'סמן כפורסם';

  // מסלול השליחה האוטומטית — ערוץ מטא מחובר או ערוץ מייל (HUB), הרשאת approve
  const autoCapable = ['facebook', 'instagram', 'newsletter'].includes(post.platform)
    && post.autopub_connected;
  const approveBtn = $('#pApprove');
  approveBtn.hidden = !(can('approve') && autoCapable
    && ['scheduled', 'failed', 'approved'].includes(post.status));
  approveBtn.textContent = post.status === 'approved'
    ? 'בטל אישור שליחה' : 'אשר לשליחה אוטומטית ⚡';
  approveBtn.style.color = post.status === 'approved' ? 'var(--st-crit)' : 'var(--st-good)';
  $('#pPublishNow').hidden = !(can('approve') && autoCapable
    && ['scheduled', 'failed', 'approved'].includes(post.status));

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

  const media = assets.map((a) => {
    if (isImage(a.mime)) {
      return `<img class="pv" src="/api/assets/${a.id}" alt="${esc(a.filename)}">`;
    }
    if (isVideo(a.mime)) {
      return `<video class="pv" src="/api/assets/${a.id}" controls></video>`;
    }
    return `<a class="pvfile" href="/api/assets/${a.id}" target="_blank" rel="noopener">
      📄 ${esc(a.filename)}</a>`;
  }).join('');

  const body = variant?.body?.trim();

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

    ${media ? `<div class="pvmedia">${media}</div>` : ''}

    ${body ? `<div class="pvbody">${esc(body)}</div>`
            : '<div class="pvempty">אין עדיין טקסט לגרסה של המדיה הזו.</div>'}

    ${variant && variant.status !== 'ready'
      ? `<div class="pvwarn">הגרסה הזו במצב "${variant.status === 'draft' ? 'טיוטה' : 'לא רלוונטי'}" —
         היא לא נחשבת מוכנה לפרסום.</div>` : ''}

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
}
