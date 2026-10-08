import { $, $$, copyLinkButton, copyText, esc, fillSelect, run, toast, wireCopyLinks } from '../core/dom.js';
import { confirmDialog } from '../core/confirm.js';
import { api, postWithGapCheck } from '../core/api.js';
import { can, epColor, state } from '../core/state.js';
import { goToTab, openPostEditor, refreshAfterPostChange } from '../ui/refresh.js';
import { KIND_HE, hhmm, isImage, isVideo, ymd } from '../core/format.js';
import { candidateButtons, loadCandidates } from '../ui/contentPicker.js';
import { AUTO_PLATFORMS, choosePrimary, editPatch, isMissed, nextFreeSlot, postFacts,
         publishingStuck, rescheduleApproves } from '../core/postActions.js';
import { newsletterHubTag } from '../core/hubFill.js';
import { pickExtras } from '../core/socialRules.js';
import { mountHubPreview, newsletterPostNotes, openInHub, previewInput,
         transferToHub } from './hubFill.js';

/* ========================= תצוגת פוסט מהלוח ========================= */

let previewPost = null;
let previewFacts = null; // העובדות שהפעולה הראשית נבחרה לפיהן (postActions.js)

const perms = () => ({ content: can('content'), approve: can('approve') });

/** "פרסם/אושר" — שעה ותאריך קצרים להודעות */
const shortWhen = (d) => new Date(d).toLocaleString('he-IL',
  { weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

/*
 * פעולות הפוסט — פונקציות במפה אחת. choosePrimary (postActions.js) בוחר מי
 * ראשית ומי משנית בפוטר; כל השאר בתפריט "עוד". label יכול להיות פונקציה
 * כשהניסוח תלוי במצב (קבע מועד חדש / קבע מועד חדש ופרסם).
 */
const ACT = {
  approve: {
    label: 'אשר לפרסום אוטומטי ⚡',
    run: async (post) => {
      await api(`/posts/${post.id}/approve-publish`, { method: 'POST' });
      toast('אושר — הפוסט יתפרסם אוטומטית במועד שנקבע. ⚡');
    },
  },
  unapprove: {
    label: 'בטל אישור',
    run: async (post) => {
      await api(`/posts/${post.id}/unapprove-publish`, { method: 'POST' });
      toast('האישור בוטל — הפוסט חזר למתוכנן ולא יתפרסם אוטומטית.');
    },
  },
  publishNow: {
    label: 'פרסם עכשיו',
    run: async (post) => {
      if (!(await confirmDialog('לפרסם את הפוסט עכשיו, ישירות לערוץ? הפעולה מיידית.', { okLabel: 'פרסם עכשיו' }))) return false;
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
  // פוסט שתקוע ב"בפרסום" (פרסום שנקטע, ניוזלטר שה-HUB לא סגר) — עובר ל"נכשל"
  resetPublishing: {
    label: 'שחרר פרסום תקוע',
    run: async (post) => {
      const q = post.platform === 'newsletter'
        ? 'לשחרר את הניוזלטר? אם ה-HUB עוד שולח אותו, עדיף לחכות. אחרי השחרור הפוסט יסומן "נכשל" — בודקים ב-HUB אם נשלח, ואז מסמנים פורסם או מפרסמים שוב.'
        : 'לשחרר את הפוסט? הוא יסומן "נכשל" — בודקים בעמוד אם עלה, ואז מסמנים פורסם או מפרסמים שוב.';
      if (!(await confirmDialog(q, { okLabel: 'שחרר' }))) return false;
      await api(`/posts/${post.id}/reset-publishing`, { method: 'POST' });
      toast('הפוסט שוחרר וסומן "נכשל". אם הוא עלה בפועל — "סמן כפורסם".');
    },
  },
  // ניוזלטר: יוצר טיוטה לאישור ב-HUB עם המועד של הפוסט (ui/hubFill.js)
  transferHub: {
    label: 'העבר ל-HUB',
    keepOpen: true,
    run: async (post) => {
      if (await transferToHub(post)) await afterChange(post.id);
      return false; // החלון נשאר — עכשיו עם "ממתין לאישור ב-HUB" והקישור
    },
  },
  openHub: {
    label: 'פתח ב-HUB',
    keepOpen: true,
    run: async (post) => {
      openInHub(post.external_url);
      return false;
    },
  },
  // ממתין לאישור (מבצע דחוף של מי שאין לו הרשאת אישור)
  approvePending: {
    label: 'אשר',
    run: async (post) => {
      await api(`/posts/${post.id}/approve`, { method: 'POST' });
      toast('אושר — הפוסט על הלוח, ומשימת האישור נסגרה.');
    },
  },
  // כל הפוסטים של אותו מבצע דחוף שעוד ממתינים — משימת אישור אחת לכל ערוץ נסגרת
  approveGroup: {
    label: (post) => `אשר את כל המבצע (${post.group_pending})`,
    run: async (post) => {
      const r = await api(`/posts/${post.id}/approve-group`, { method: 'POST' });
      const skipped = r.skipped?.length
        ? ` ${r.skipped.length} לא אושרו כי המועד שלהם עבר — קובעים להם מועד חדש ואז מאשרים.` : '';
      toast(`אושרו ${r.approved} פוסטים של המבצע — על הלוח, ומשימות האישור שלהם נסגרו.${skipped}`,
        !!skipped);
    },
  },
  reject: {
    label: 'דחה',
    danger: true,
    run: async (post) => {
      if (!(await confirmDialog(`לדחות את "${post.title}"? הפוסט יימחק מהלוח, ומשימת האישור שלו תיסגר.`,
        { danger: true, okLabel: 'דחה ומחק' }))) return false;
      await api(`/posts/${post.id}/reject`, { method: 'POST' });
      // הדחייה לא ממלאת מחדש — המקום נשאר פנוי (עיקרון 1)
      toast('הפוסט נדחה והוסר מהלוח.');
    },
  },
  reschedule: {
    label: (post, f) => (rescheduleApproves(f, perms()) ? 'קבע מועד חדש ופרסם' : 'קבע מועד חדש'),
    keepOpen: true,
    run: async (post) => {
      await showReschedule(post);
      return false; // הבחירה קורית בתוך החלון
    },
  },
  attach: {
    label: 'שייך תוכן',
    keepOpen: true,
    run: async (post) => {
      await showAttachPicker(post);
      return false; // החלון נשאר פתוח — הבחירה קורית בתוכו
    },
  },
  openContent: {
    label: '✏️ פתח בתוכן',
    keepOpen: true,
    run: async (post) => {
      // פוסט חסר תוכן: אין לאן "לפתוח" — מציעים לשייך לו תוכן במקום
      if (!post.content_id) {
        await showAttachPicker(post);
        return false;
      }
      // העורך עצמו, כחלון מעל הלוח; בסגירה — חזרה לפוסט המעודכן (סעיף 17)
      if (await openPostEditor(post, { onChange: () => afterChange(post.id) })) return false;
      // לא נמצא העורך (התוכן נמחק בינתיים?) — לטאב התוכן, כמו קודם
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
      if (!(await confirmDialog('להסיר את הפוסט מהלוח? התוכן עצמו יישאר.', { danger: true, okLabel: 'הסר מהלוח' }))) return false;
      await api(`/posts/${post.id}`, { method: 'DELETE' });
      // המחיקה לא ממלאת מחדש — המקום נשאר פנוי (docs/ux-overhaul.md, עיקרון 1)
      toast('הפוסט הוסר.' + (post.content_id
        ? ' המקום נשאר פנוי, והמילוי האוטומטי לא יחזיר את התוכן הזה לשבוע הזה.' : ''));
    },
  },
};

const labelOf = (key) => {
  const l = ACT[key].label;
  return typeof l === 'function' ? l(previewPost, previewFacts) : l;
};

/**
 * "קבע מועד חדש" לפוסט שהמועד שלו עבר (או שנכשל): תאריך ושעה בתוך החלון,
 * ואז שתי קריאות — הזזה (עם אזהרת המרווח הרגילה) ואחריה אישור לפרסום
 * אוטומטי, כשאפשר. אישור שנכשל אחרי הזזה שהצליחה — אומרים בדיוק מה קרה.
 */
/**
 * השעה הפנויה הבאה בערוץ של הפוסט — לפי הלוח של השבוע הזה והבא. אם הלוח
 * לא נטען, רק השעה העגולה הבאה (השרת עדיין בודק התנגשויות ומרווח).
 */
async function defaultSlot(post) {
  const now = new Date();
  const weeks = [ymd(now), ymd(new Date(now.getTime() + 7 * 86400000))];
  const busy = [];
  try {
    const boards = await Promise.all(weeks.map((w) => api(`/board?week=${w}`)));
    for (const b of boards) {
      const ch = b.channels.find((c) => c.id === post.channel_id);
      for (const day of ch?.days ?? []) {
        for (const p of day.posts) {
          if (p.id !== post.id) busy.push({ at: p.scheduled_at, endpoint_id: p.endpoint_id });
        }
      }
    }
  } catch { /* בלי הלוח — רק השעה העגולה הבאה */ }
  const channel = state.channels.find((c) => c.id === post.channel_id);
  return nextFreeSlot({
    now, busy, blockedDays: channel?.blocked_days ?? [], endpointId: post.endpoint_id ?? null,
  });
}

async function showReschedule(post) {
  const box = $('#pReschedBox');
  if (!box) return;
  const f = previewFacts;
  const approves = rescheduleApproves(f, perms());
  box.hidden = false;
  box.innerHTML = '<div class="pvbox-title">מחפש מועד פנוי…</div>';
  const at = await defaultSlot(post);
  if (previewPost?.id !== post.id) return; // בינתיים נפתח פוסט אחר
  const hint = approves
    ? 'אחרי שהמועד יישמר הפוסט יאושר לפרסום אוטומטי, ויתפרסם במועד החדש.'
    : post.status === 'approved' && f.autoReady
      ? 'האישור לפרסום אוטומטי נשאר — הפוסט יתפרסם במועד החדש.'
    : post.status === 'approved'
      ? 'הפרסום האוטומטי כבוי לערוץ הזה — במועד החדש מפרסמים ידנית ומסמנים "פורסם".'
      : post.status === 'failed' && state.autopublish
        ? 'הפוסט יישאר מסומן "נכשל" עד שמישהו עם הרשאת אישור יאשר אותו שוב.'
        : post.status === 'failed' && post.maybe_out
          ? 'ייתכן שהפוסט כבר יצא — הוא יישאר מסומן "נכשל" גם במועד החדש. בודקים קודם, ואם הוא שם מסמנים "פורסם".'
        : post.status === 'failed'
          ? 'הפוסט יחזור למתוכנן במועד החדש — מפרסמים בעצמכם ומסמנים "פורסם".'
          : '';
  box.hidden = false;
  box.innerHTML = `
    <div class="pvbox-title">מועד חדש</div>
    <div class="frow frow2">
      <label>תאריך<input type="date" id="pRsDate" min="${ymd(new Date())}" value="${ymd(at)}"></label>
      <label>שעה<input type="time" id="pRsTime" value="${hhmm(at)}"></label>
    </div>
    ${hint ? `<div class="fhint">${esc(hint)}</div>` : ''}
    <div class="pvbox-acts">
      <button type="button" class="btn small" id="pRsCancel">ביטול</button>
      <button type="button" class="btn small primary" id="pRsGo">${approves ? 'קבע ופרסם במועד הזה' : 'קבע מועד'}</button>
    </div>`;
  $('#pRsCancel').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
  const go = $('#pRsGo');
  go.addEventListener('click', run(async () => {
    const when = new Date(`${$('#pRsDate').value}T${$('#pRsTime').value || '10:00'}:00`);
    if (Number.isNaN(when.getTime())) return toast('צריך תאריך ושעה', true);
    if (when <= new Date()) return toast('המועד שבחרת כבר עבר — בוחרים מועד עתידי', true);
    go.disabled = true;
    try {
      const moved = await postWithGapCheck(`/posts/${post.id}`, { scheduled_at: when.toISOString() });
      if (!moved) return; // ביטול אחרי אזהרת המרווח
      let msg = `המועד עודכן ל${shortWhen(when)}.`;
      if (approves) {
        try {
          await api(`/posts/${post.id}/approve-publish`, { method: 'POST' });
          msg += ' הפוסט אושר ויתפרסם אוטומטית במועד הזה. ⚡';
        } catch (e) {
          await afterChange(post.id);
          return toast(`המועד עודכן, אבל האישור לפרסום אוטומטי נכשל: ${e.message}`, true);
        }
      } else if (post.status === 'approved') {
        msg += ' האישור נשאר — הפוסט יתפרסם במועד החדש.';
      }
      toast(msg);
      await afterChange(post.id);
    } finally {
      go.disabled = false;
    }
  }));
}

/** אחרי שינוי שמשאיר את החלון פתוח: רענון הלוח וציור הפוסט מחדש במצבו החדש */
async function afterChange(postId) {
  await refreshAfterPostChange();
  if ($('#postDlg').open) await openPostPreview(postId);
}

/** מעבר ל"קמפיינים ותוכן" של הנקודה — כשאין עדיין מה לשייך */
async function goToEndpointContent(endpointId) {
  $('#postDlg').close();
  state.planEndpoint = endpointId ?? null;
  state.planCampaign = null;
  state.planBackground = false;
  await goToTab('plan');
}

/**
 * "שייך תוכן": התוכן שמתאים לנקודה ולערוץ של הפוסט, בתוך החלון — מוכן
 * קודם, אחר כך טיוטות. בחירה משייכת מיד (השרת בודק שוב את כל הכללים)
 * ומציגה את הפוסט מחדש, עכשיו עם התוכן. אין מה לשייך — כפתור ליצירת תוכן.
 */
async function showAttachPicker(post) {
  const box = $('#pAttachBox');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="empty">טוען…</div>';
  const list = await loadCandidates({
    endpointId: post.endpoint_id, channelId: post.channel_id,
    date: ymd(new Date(post.scheduled_at)),
  });

  // הקמפיין של הפוסט ידוע — משבצת חדשה בו, מעל הלוח, והתוכן משויך לפוסט
  // בשמירה הראשונה (סעיף 17). לא ידוע — לטאב התוכן של הנקודה, כמו קודם.
  const wireWrite = () => $('#pGoPlan').addEventListener('click', run(async () => {
    if (await openPostEditor(post, { onChange: () => afterChange(post.id) })) return;
    await goToEndpointContent(post.endpoint_id);
  }));

  if (list.length === 0) {
    box.innerHTML = `<div class="pick-empty">${post.endpoint_id
      ? 'אין תוכן לנקודה הזו בערוץ הזה.' : 'אין תוכן עם ניסוח לערוץ הזה.'}
      <div><button type="button" class="btn small primary" id="pGoPlan">לכתוב תוכן</button></div></div>`;
    wireWrite();
    return;
  }

  // גם כשיש מה לשייך — אפשר לכתוב תוכן חדש במקום
  box.innerHTML = `${candidateButtons(list, !post.endpoint_id)}
    <div class="pick-empty">או <button type="button" class="btn small" id="pGoPlan">לכתוב תוכן חדש</button></div>`;
  wireWrite();
  const buttons = [...box.querySelectorAll('[data-content-id]')];
  buttons.forEach((b) =>
    b.addEventListener('click', run(async () => {
      // לחיצה אחת בלבד — כפולה הייתה שולחת שני שיוכים (השני נכשל ב-409)
      buttons.forEach((x) => { x.disabled = true; });
      let r;
      try {
        // תוכן של קמפיין עם מרווח ארוך יכול להיות צמוד מדי לשכן — השרת מזהיר
        r = await postWithGapCheck(`/posts/${post.id}/attach-content`,
          { content_id: Number(b.dataset.contentId) }, 'POST', 'לשייך בכל זאת?');
      } catch (e) {
        buttons.forEach((x) => { x.disabled = false; });
        throw e;
      }
      if (!r) { buttons.forEach((x) => { x.disabled = false; }); return; }
      toast((r.draft
        ? 'התוכן שויך — הניסוח לערוץ הזה עוד בטיוטה; מסמנים "מוכן" לפני פרסום.'
        : 'התוכן שויך לפוסט.') +
        (r.approval_reset ? ' האישור לפרסום אוטומטי בוטל — צריך לאשר שוב עם התוכן החדש.' : ''));
      await refreshAfterPostChange();
      $('#postDlg').close();
      await openPostPreview(post.id);
    })));
}

/* ========================= עריכת הפוסט ========================= */

let editSnapshot = null; // ערכי הטופס כפי שנטענו — לזיהוי שינויים שלא נשמרו
let resultsShown = false; // האם בלשונית התצוגה מוצג גם "מה זה עשה בפועל"

/** עריכה — רק לפוסט שעוד לא יצא (השרת אוכף את אותו כלל ב-moveBlocker) */
const editable = (post) => can('content') && !['published', 'publishing'].includes(post.status);

const editValues = () => ({
  date: $('#peDate').value, time: $('#peTime').value, channel: $('#peChannel').value,
  assignee: $('#peAssignee').value, title: $('#peTitle').value.trim(), note: $('#peNote').value.trim(),
});
const editDirty = () => !!editSnapshot && JSON.stringify(editValues()) !== JSON.stringify(editSnapshot);

function fillEditForm(post) {
  $('#peDate').value = ymd(new Date(post.scheduled_at));
  $('#peDate').min = ymd(new Date());
  $('#peTime').value = hhmm(post.scheduled_at);
  fillSelect($('#peChannel'), state.channels.filter((c) => c.active || c.id === post.channel_id), 'name');
  $('#peChannel').value = String(post.channel_id);
  fillSelect($('#peAssignee'), state.users, 'name', 'ללא אחראי');
  $('#peAssignee').value = post.assignee_id ? String(post.assignee_id) : '';
  $('#peTitle').value = post.title;
  // סעיף 23: פוסט עם תוכן מציג את כותרת התוכן — היא נערכת בתוכן, לא כאן
  $('#peTitle').readOnly = !!post.content_id;
  $('#peTitleHint').hidden = !post.content_id;
  $('#peNote').value = post.note ?? '';
  $('#peHint').textContent = post.status === 'approved' && previewFacts?.autoReady
    ? 'הפוסט מאושר לפרסום אוטומטי. שינוי מועד משאיר את האישור; מעבר לערוץ אחר מבטל אותו.'
    : post.content_id ? 'מעבר לערוץ אחר דורש שלתוכן יהיה ניסוח לערוץ הזה.' : '';
  editSnapshot = editValues();
}

/** מעבר בין "תצוגה" ל"עריכה" — הפעולה הראשית בפוטר מתחלפת ב"שמור שינויים" */
function setTab(tab) {
  const edit = tab === 'edit';
  $$('#pTabs [data-ptab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ptab === tab)));
  $('#postPreview').hidden = edit;
  $('#pEdit').hidden = !edit;
  $('#pResults').hidden = edit || !resultsShown;
  $('#pActs').hidden = edit;
  $('#postDlg .pmore').hidden = edit;
  $('#peSave').hidden = !edit;
  $('#pMenu').hidden = true;
  if (edit) $('#peTitle').focus();
}

/**
 * שמירת העריכה — רק השדות שהשתנו, דרך PATCH עם אזהרת המרווח הרגילה.
 * השרת אוכף: לא לזמן שעבר, לא פוסט שיצא, יום חסום, אותה נקודה באותו יום.
 */
async function saveEdit() {
  const post = previewPost;
  if (!post) return;
  if (!editSnapshot) return;
  const patch = editPatch(editSnapshot, editValues());
  if (patch.error) return toast(patch.error, true);
  const { body } = patch;
  if (Object.keys(body).length === 0) return toast('אין שינויים לשמור.');
  if (body.scheduled_at && new Date(body.scheduled_at) <= new Date()) {
    return toast('המועד שבחרת כבר עבר — בוחרים מועד עתידי', true);
  }

  const btn = $('#peSave');
  btn.disabled = true;
  try {
    const res = await postWithGapCheck(`/posts/${post.id}`, body);
    if (!res) return; // ביטול אחרי אזהרת המרווח
    editSnapshot = null;
    toast('הפוסט עודכן.' + (res.approval_reset
      ? ' האישור לפרסום אוטומטי בוטל כי הערוץ השתנה — צריך לאשר שוב.'
      : post.status === 'approved' && body.scheduled_at && previewFacts?.autoReady
        ? ' האישור נשאר — הפוסט יפורסם במועד החדש.' : ''));
    await afterChange(post.id);
  } finally {
    btn.disabled = false;
  }
}

/**
 * שינויים שלא נשמרו בעריכה — שואלים לפני שמאבדים אותם (עיקרון 4). מי שמוותר
 * מקבל טופס שחזר למה שנטען, כדי שלא יישאר מצב "מלוכלך" נסתר מאחורי התצוגה.
 * @returns {Promise<boolean>} true — אפשר להמשיך
 */
async function discardEditsOk(question, okLabel) {
  if (!editDirty()) return true;
  if (!(await confirmDialog(question, { okLabel, danger: true }))) return false;
  if (previewPost && editable(previewPost)) fillEditForm(previewPost);
  return true;
}

/** סגירה — עם שינויים שלא נשמרו בעריכה שואלים קודם */
async function closePostDlg() {
  if (!(await discardEditsOk('יש שינויים שלא נשמרו בעריכת הפוסט. לסגור בלי לשמור?',
    'סגור בלי לשמור'))) return;
  editSnapshot = null;
  $('#postDlg').close();
}

/** מעבר ל"תצוגה" עם שינויים שלא נשמרו — שואלים, ובוויתור הטופס חוזר למה שנטען */
async function switchTab(tab) {
  if (tab === 'view' && !(await discardEditsOk(
    'יש שינויים שלא נשמרו בעריכת הפוסט. לחזור לתצוגה ולבטל אותם?', 'בטל את השינויים'))) return;
  setTab(tab);
}

async function runAction(key) {
  if (!previewPost) return;
  $('#pMenu').hidden = true;
  if (!(await discardEditsOk('יש שינויים שלא נשמרו בעריכת הפוסט. להמשיך ולבטל אותם?',
    'בטל את השינויים והמשך'))) return;
  const done = await ACT[key].run(previewPost);
  if (done === false) return;
  $('#postDlg').close();
  await refreshAfterPostChange();
}

export function wirePostDialog() {
  $('#pClose').addEventListener('click', run(closePostDlg));
  // Esc — אותה שאלה כמו "סגור" כשיש שינויים שלא נשמרו
  $('#postDlg').addEventListener('cancel', (e) => {
    if (!editDirty()) return;
    e.preventDefault();
    run(closePostDlg)();
  });
  $$('#pTabs [data-ptab]').forEach((b) => b.addEventListener('click', run(() => switchTab(b.dataset.ptab))));
  $('#peSave').addEventListener('click', run(saveEdit));
  // "ערוך בתוכן" ליד הכותרת — אותו עורך כמו "פתח בתוכן" (סעיף 17)
  $('#peTitleEdit').addEventListener('click', run(() => runAction('openContent')));

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
    await refreshAfterPostChange(); // התג "לא נמדד" יורד מהכרטיס
  }));

  $('#rClear').addEventListener('click', run(async () => {
    if (!previewPost) return;
    if (!(await confirmDialog('למחוק את המדידה של הפוסט הזה?', { danger: true, okLabel: 'מחק מדידה' }))) return;
    await api(`/posts/${previewPost.id}/results`, { method: 'DELETE' });
    for (const id of ['#rReach', '#rEngagement', '#rClicks', '#rLeads', '#rNote']) $(id).value = '';
    $('#rClear').hidden = true;
    toast('המדידה נמחקה.');
    await refreshAfterPostChange();
  }));
}

/**
 * "היסטוריית ניסיונות (N)" — מקופל. שורה לכל ניסיון פרסום אוטומטי: מתי,
 * הצליח/נכשל, וההודעה הידידותית; השגיאה הגולמית רק ב-title (למפתח).
 */
function attemptsHtml(log) {
  if (!log?.length) return '';
  const rowsHtml = log.map((x) => {
    const when = new Date(x.created_at).toLocaleString('he-IL',
      { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<li class="${x.ok ? 'ok' : 'bad'}"${x.ok || !x.error ? '' : ` title="${esc(x.error)}"`}>
      <span class="when">${esc(when)}</span>
      <span class="st">${x.ok ? '✓ הצליח' : '✗ נכשל'}</span>
      <span class="msg">${x.ok ? (x.external_id ? (x.platform === 'newsletter' ? 'הועבר ל-HUB' : 'פורסם בערוץ') : '')
        : esc(x.message ?? '')}</span></li>`;
  }).join('');
  return `<details class="pvlog"><summary>היסטוריית ניסיונות (${log.length})</summary>
    <ul>${rowsHtml}</ul></details>`;
}

/** צ'יפ הסטטוס בכותרת */
const STATUS_CHIP = {
  scheduled: ['מתוכנן', ''],
  approved: ['⚡ מאושר לפרסום אוטומטי', 'good'],
  publishing: ['בפרסום…', 'good'],
  published: ['פורסם ✓', 'good'],
  failed: ['נכשל', 'crit'],
  pending_approval: ['ממתין לאישור', 'warn'],
  hole: ['חסר תוכן', 'crit'],
};
const MISSED_CHIP = ['עבר המועד', 'warn'];

/**
 * מה נכנס לתפריט "עוד": כל מה שרלוונטי למצב, בלי הראשית והמשנית שכבר
 * בפוטר. הסדר: קודם מה שהמצב מזמין, עריכה באמצע, הסרה אחרונה אחרי מפריד.
 */
function menuKeys(post, f, p) {
  // פרסום אוטומטי כבוי (state.autopublish) — בלי "פרסם עכשיו" / "בטל אישור"
  const connected = f.autopublish && AUTO_PLATFORMS.includes(post.platform) && post.autopub_connected;
  const future = new Date(post.scheduled_at) > new Date();
  const menu = [];
  if (post.platform === 'newsletter') return newsletterMenuKeys(post, f, p, future);
  if (['scheduled', 'failed'].includes(post.status)) {
    // אישור לפוסט שהמועד שלו עבר נדחה בשרת — אז "קבע מועד חדש" או "פרסם עכשיו"
    if (p.approve && f.autoReady && future) menu.push('approve');
    if (p.approve && connected) menu.push('publishNow');
    if (p.content) menu.push('markPublished');
    if (p.content && !future) menu.push('reschedule');
  } else if (post.status === 'approved') {
    if (p.approve && f.autopublish) menu.push('unapprove', 'publishNow');
    if (p.content) menu.push('markPublished');
    if (p.content && isMissed(post)) menu.push('reschedule');
  } else if (post.status === 'published') {
    if (p.content) menu.push('unpublish');
  } else if (post.status === 'publishing') {
    if (p.approve && publishingStuck(f)) menu.push('resetPublishing');
  } else if (post.status === 'pending_approval') {
    if (p.approve && future) menu.push('approvePending');
    if (p.approve && p.content && !future) menu.push('reschedule');
    if (p.approve) menu.push('reject');
  }
  const attachable = !post.content_id && p.content &&
    !['published', 'publishing'].includes(post.status);
  if (attachable) menu.unshift('attach');
  else menu.push('openContent');
  if (p.content && post.status !== 'publishing') menu.push('remove');
  return menu;
}

/**
 * "עוד" לניוזלטר: לא מאשרים ולא מפרסמים מכאן — מעבירים ל-HUB ומאשרים שם.
 * מה שהועבר נפתח ב-HUB; שחרור (אם נתקע) מחזיר אותו ללוח כ"נכשל".
 */
function newsletterMenuKeys(post, f, p, future) {
  const menu = [];
  const transferable = ['scheduled', 'approved', 'failed'].includes(post.status);
  if (transferable && future && p.approve && f.autopublish && f.hasContent && f.variantReady) {
    menu.push('transferHub');
  }
  if (post.external_url && ['publishing', 'published', 'failed'].includes(post.status)) menu.push('openHub');
  if (transferable && p.content) menu.push('markPublished');
  if (transferable && p.content && !future) menu.push('reschedule');
  if (post.status === 'published' && p.content) menu.push('unpublish');
  if (post.status === 'publishing' && p.approve && publishingStuck(f)) menu.push('resetPublishing');
  if (post.content_id || post.status === 'publishing') menu.push('openContent');
  else if (p.content) menu.unshift('attach');
  if (p.content && post.status !== 'publishing') menu.push('remove');
  return menu;
}

/** הפוטר: ראשית + משנית ככפתורים, כל השאר בתפריט "עוד" */
function renderActions(post, f) {
  const p = perms();
  const { primary, secondary } = choosePrimary(f, p);
  // מבצע דחוף עם כמה ערוצים שממתינים — אישור של כולם בלחיצה, ליד "אשר"
  const group = primary === 'approvePending' && post.group_pending > 1 ? ['approveGroup'] : [];
  const shown = [primary, ...group, secondary].filter(Boolean);
  const menu = menuKeys(post, f, p).filter((k) => !shown.includes(k));

  $('#pActs').innerHTML = shown.map((key, i) => `<button type="button" class="btn${
    i === 0 && !ACT[key].danger ? ' primary' : ''}${ACT[key].danger ? ' danger' : ''}" data-act="${key}">${
    esc(labelOf(key))}</button>`).join('');

  const menuEl = $('#pMenu');
  const more = $('#pMoreBtn');
  menuEl.hidden = true;
  more.hidden = menu.length === 0;
  // תמיד "פעולות" — שם אחד לאותו תפריט. בלי פעולה ראשית הוא הכפתור הבולט; עם ראשית — צנוע לידה
  more.textContent = 'פעולות ⌄';
  more.classList.toggle('primary', shown.length === 0);
  menuEl.innerHTML = menu.map((key, i) => `${
    ACT[key].danger && i > 0 ? '<div class="sep"></div>' : ''
  }<button type="button" data-act="${key}"${ACT[key].danger ? ' data-danger' : ''}>${esc(labelOf(key))}</button>`).join('');

  for (const b of [...$('#pActs').querySelectorAll('[data-act]'), ...menuEl.querySelectorAll('[data-act]')]) {
    b.addEventListener('click', run(() => runAction(b.dataset.act)));
  }
}

let previewReq = 0; // רק התשובה לפתיחה האחרונה מצוירת

/** הטעינה נכשלה — אומרים מה קרה בתוך החלון, עם "נסה שוב" ו"סגור" (עיקרון 3) */
function showPreviewError(postId, e) {
  $('#postDlgTitle').textContent = 'הפוסט לא נטען';
  $('#postPreview').innerHTML = `
    <div class="pverr">${esc(e.status === 404
      ? 'הפוסט לא נמצא — אולי הוא נמחק בינתיים. מרעננים את הלוח.'
      : `לא הצלחנו לטעון את הפוסט: ${e.message}`)}</div>`;
  $('#pActs').innerHTML = `${e.status === 404 ? '' : '<button type="button" class="btn primary" id="pRetry">נסה שוב</button>'}`;
  $('#pRetry')?.addEventListener('click', run(() => openPostPreview(postId)));
  if (e.status === 404) run(refreshAfterPostChange)();
}

/** מה שאמור לצאת: הטקסט של המדיה הזו והקבצים שלה */
export async function openPostPreview(postId) {
  $('#postDlgTitle').textContent = 'טוען…';
  $('#postPreview').innerHTML = '';
  $('#pActs').innerHTML = '';
  $('#pMoreBtn').hidden = true;
  $('#pMenu').hidden = true;
  $('#pStatusChip').hidden = true;
  $('#pTabs').hidden = true;
  editSnapshot = null;
  resultsShown = false;
  setTab('view');
  if (!$('#postDlg').open) $('#postDlg').showModal();

  const req = ++previewReq;
  previewPost = null;
  let data;
  try {
    data = await Promise.all([
      api(`/posts/${postId}/preview`),
      // היסטוריית הניסיונות רכה — אם היא נכשלת, החלון עצמו עדיין מוצג
      api(`/posts/${postId}/publish-log`).then((r) => r.log).catch(() => []),
    ]);
  } catch (e) {
    if (req === previewReq) showPreviewError(postId, e);
    return;
  }
  if (req !== previewReq) return; // בינתיים נפתח פוסט אחר
  const [{ post, variant, assets, results }, attempts] = data;
  previewPost = post;
  previewFacts = postFacts(post, variant, { autopublish: state.autopublish });
  renderActions(post, previewFacts);
  $('#pTabs').hidden = !editable(post);
  if (editable(post)) fillEditForm(post);
  const attachable = !post.content_id && can('content') &&
    !['published', 'publishing'].includes(post.status);

  const chip = $('#pStatusChip');
  const hubTag = newsletterHubTag(post); // ניוזלטר שבידי ה-HUB — "ממתין לאישור ב-HUB"
  const [chipLabel, chipTone] = hubTag ? [hubTag.label, hubTag.tone]
    : isMissed(post) ? MISSED_CHIP
    // תוכן משויך בלי טקסט ובלי מדיה — "חסר תוכן" כמו בכרטיס בלוח (סעיף 20)
    : post.content_empty && post.status === 'scheduled' ? STATUS_CHIP.hole
    : STATUS_CHIP[post.status] ?? [null, ''];
  chip.hidden = !chipLabel;
  chip.textContent = chipLabel ?? '';
  chip.dataset.tone = chipTone;

  // תוצאות נמדדות רק למה שכבר יצא לאוויר
  const showResults = can('content') && post.status === 'published';
  resultsShown = showResults;
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
  // ניוזלטר: התצוגה מה-HUB במקום הטקסט הגולמי, ושורות המצב מול ה-HUB
  const nlInput = post.platform === 'newsletter' && variant
    ? previewInput({ subject: vMeta.subject, body: variant.body, title: post.post_title ?? post.title,
        scheduledAt: post.scheduled_at, templateId: vMeta.template_id, fieldValues: vMeta.field_values })
    : null;
  const nlNotes = newsletterPostNotes(post);
  // מה שנוסף לגרסה מעבר לטקסט (סוג פרסום, קישור, תגובה ראשונה) — גם למי
  // שמפרסם ידנית. התגובה הראשונה עם כפתור העתקה משלה.
  const ex = post.platform === 'newsletter' ? {} : pickExtras(vMeta);
  const extrasLines = [
    ex.format === 'story' ? '<div>סוג פרסום: <b>סטורי</b></div>' : '',
    // לחיץ רק http/https (השרת לא שומר אחר — כאן ליתר ביטחון)
    ex.link ? `<div>קישור: ${/^https?:\/\//i.test(ex.link)
      ? `<a href="${esc(ex.link)}" target="_blank" rel="noopener" dir="ltr">${esc(ex.link)}</a>`
      : `<span dir="ltr">${esc(ex.link)}</span>`}</div>` : '',
    // בסטורי אין תיאור תמונה ואין תגובות — מה שנשאר שמור מפוסט רגיל לא מוצג
    ex.alt_text && ex.format !== 'story' ? `<div>תיאור תמונה: ${esc(ex.alt_text)}</div>` : '',
    ex.first_comment && ex.format !== 'story' ? `<div>תגובה ראשונה: ${esc(ex.first_comment)}
      <button type="button" class="btn small" id="pCopyComment">העתק תגובה</button></div>` : '',
  ].join('');

  $('#postDlgTitle').textContent = post.title;
  $('#postPreview').innerHTML = `
    <div class="pvmeta">
      <span class="sw" style="background:${epColor(post.endpoint_id)}"></span>
      ${esc(post.endpoint_name ?? 'ללא נקודת קצה')} · ${esc(post.channel_name ?? '')}
      ${post.campaign_name ? ` · ${esc(post.campaign_name)}` : ''}
      ${post.evergreen ? ' · ♻' : ''}
      ${KIND_HE[post.kind] ? ` · ${esc(KIND_HE[post.kind])}` : ''}${post.urgent ? ' · ⚡ דחוף' : ''}
    </div>
    <div class="pvwhen">${esc(when)}${
      post.assignee_name ? ` · אחראי: ${esc(post.assignee_name)}` : ''}</div>

    ${post.note ? `<div class="pvnote">${post.status === 'hole' ? 'למה חסר תוכן: ' : 'הערה: '}${esc(post.note)}</div>` : ''}
    ${subjectLine}
    ${media ? `<div class="pvmedia">${media}</div>` : ''}

    ${nlInput ? '<div id="pNlPreview" class="pvnl"></div>' : body ? `<div class="pvbody">${esc(body)}</div>
              <div class="pvcopy"><button type="button" class="btn small" id="pCopyBody">העתק טקסט</button></div>`
            : !post.content_id
              ? `<div class="pvempty">חסר תוכן — לפוסט הזה עוד לא שויך תוכן.</div>
                 ${attachable ? '<div id="pAttachBox" hidden></div>' : ''}`
              : `<div class="pvempty">${post.platform === 'newsletter'
                ? 'אין עדיין תוכן לניוזלטר — ממלאים דרך "פתח בתוכן".'
                : post.content_empty
                  ? 'חסר תוכן — יש רק כותרת. כותבים טקסט או מוסיפים תמונה ב"פתח בתוכן".'
                  : 'אין עדיין טקסט לגרסה של הערוץ הזה.'}</div>`}

    ${extrasLines ? `<div class="pvextras">${extrasLines}</div>` : ''}

    ${post.ready_warn && post.status !== 'published'
      ? `<div class="pvwarn"><b>מוכן ⚠</b> — ${esc(post.ready_warn)}. מתקנים בעריכת התוכן.</div>` : ''}
    ${body && variant && variant.status !== 'ready' && post.status !== 'published'
      ? `<div class="pvwarn">הגרסה במצב "${variant.status === 'draft' ? 'טיוטה' : 'לא רלוונטי'}" —
         מסמנים "מוכן" בעריכת התוכן לפני פרסום.</div>` : ''}

    ${post.status === 'pending_approval'
      ? `<div class="pvwarn"><b>ממתין לאישור.</b> ${post.urgent ? 'מבצע דחוף' : 'פוסט'} שנוצר בלי הרשאת אישור${
          post.assignee_name ? ` (${esc(post.assignee_name)})` : ''} — לא יתפרסם עד שמישהו עם הרשאת אישור יאשר.${
          post.group_pending > 1 ? ` במבצע הזה ממתינים ${post.group_pending} ערוצים.` : ''}</div>` : ''}
    ${post.status === 'approved' && previewFacts.autoReady
      ? `<div class="pvauto">⚡ מאושר לפרסום אוטומטי${
          post.approved_by_name ? ` — אישר: ${esc(post.approved_by_name)}` : ''}.
          יתפרסם ב-${esc(when)}.</div>` : ''}
    ${post.status === 'approved' && !previewFacts.autoReady
      ? `<div class="pvwarn"><b>מאושר, אבל לא יתפרסם לבד</b> — הפרסום האוטומטי כבוי לערוץ הזה.
          מפרסמים ידנית ומסמנים "פורסם", או מדליקים פרסום אוטומטי לערוץ בניהול ← ערוצי פרסום.</div>` : ''}
    ${nlNotes ?? ''}
    ${post.status === 'publishing' && !nlNotes
      ? (post.platform === 'newsletter'
          ? '<div class="pvauto">📧 התקבל ב-HUB — הניוזלטר בשליחה. הפוסט יסומן "פורסם" אוטומטית כשתושלם.</div>'
          : '<div class="pvauto">🚀 נשלח לערוץ ממש עכשיו…</div>') : ''}
    ${post.status === 'publishing' && post.platform !== 'newsletter' && !publishingStuck(previewFacts) && can('approve')
      ? '<div class="pvnote">אם זה ייתקע — "שחרר פרסום תקוע" יופיע כאן אחרי 10 דקות בפרסום.</div>' : ''}
    ${post.status === 'failed'
      ? `<div class="pvwarn"><b>הפרסום האוטומטי נכשל:</b> ${esc(post.publish_error ?? 'ללא פירוט')}
         <br>${!state.autopublish
           ? 'הפרסום האוטומטי כבוי עכשיו — אם הפוסט יצא, מסמנים "פורסם"; אם לא, קובעים מועד חדש ומפרסמים בעצמכם.'
           : post.platform === 'newsletter'
           ? 'קובעים מועד חדש ולוחצים "העבר ל-HUB" — או, אם הניוזלטר כבר נשלח מה-HUB, מסמנים "פורסם".'
           : 'אפשר לקבוע מועד חדש ולאשר שוב, לפרסם עכשיו, או לפרסם ידנית ולסמן "פורסם".'}</div>` : ''}
    ${isMissed(post)
      ? `<div class="pvwarn"><b>המועד עבר והפוסט לא יצא.</b> ${previewFacts.autoReady
          ? 'קובעים מועד חדש — או, אם פורסם ביד, מסמנים "פורסם".'
          : 'אם פורסם ביד — מסמנים "פורסם"; אם לא — קובעים מועד חדש.'}</div>` : ''}
    <div id="pReschedBox" class="pvbox" hidden></div>
    ${attemptsHtml(attempts)}
    ${post.status === 'published' && post.external_url
      ? `<div class="pvauto">✓ פורסם אוטומטית —
         <a href="${esc(post.external_url)}" target="_blank" rel="noopener">לצפייה בפוסט</a></div>` : ''}`;
  wireCopyLinks($('#postPreview'));
  if (nlInput) mountHubPreview($('#pNlPreview'), () => nlInput, { head: 'כך ייראה המייל אצל הנמען (מה-HUB)' });
  // מעתיק בדיוק את מה שהתצוגה מראה — לשליחה ידנית (וואטסאפ) או להדבקה
  const commentBtn = $('#pCopyComment');
  commentBtn?.addEventListener('click', run(async () => {
    await copyText(ex.first_comment, commentBtn.parentElement);
    toast('התגובה הועתקה.');
  }));
  const copyBtn = $('#pCopyBody');
  copyBtn?.addEventListener('click', run(async () => {
    await copyText(body, copyBtn.parentElement);
    toast('הטקסט הועתק.');
  }));
}
