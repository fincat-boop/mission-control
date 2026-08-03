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
  pubBtn.hidden = !(can('content') && ['scheduled', 'published'].includes(post.status));
  pubBtn.textContent = post.status === 'published' ? 'בטל פרסום' : 'סמן כפורסם';

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
         היא לא נחשבת מוכנה לפרסום.</div>` : ''}`;
}
