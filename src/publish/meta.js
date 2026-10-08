/**
 * לקוח Meta Graph API — פרסום לעמוד פייסבוק ולחשבון אינסטגרם עסקי.
 *
 * פייסבוק: מדיה ב-R2 נשלחת כקישור ציבורי (url / file_url); קובץ ישן
 * מהמסד עולה ישירות (multipart).
 * אינסטגרם: ה-API מושך את המדיה מ-URL ציבורי (image_url / video_url) —
 * ההעלאה הזמנית ל-R2 קורית ב-runner, לא כאן. וידאו באינסטגרם יוצא כריל.
 */

const GRAPH = 'https://graph.facebook.com/v23.0';

/**
 * הגבלת זמן לכל קריאה. בלי הגבלה, fetch מחכה עד ~5 דקות לכל קריאה (ברירת
 * המחדל של undici), וקריאה איטית אחת עוצרת את טיק הפרסום של כל הארגונים
 * (טיק אחד בכל רגע — server.js). העלאה (multipart, או וידאו שפייסבוק מושך
 * מקישור בזמן הבקשה) — יותר זמן. waitForContainer שומר על התקציב שלו.
 */
export const GRAPH_TIMEOUT_MS = 60000;
export const GRAPH_UPLOAD_TIMEOUT_MS = 180000;

const isAbort = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

/**
 * קריאת Graph. זורק Error עם ההודעה של Meta כשהתשובה היא שגיאה, ועם
 * code/subcode/type/status שלה — friendlyPublishError (errors.js) מתרגם
 * לפיהם להודעה בעברית; הטקסט הגולמי נשמר ב-publish_log.
 *
 * קריאה שלא ענתה בזמן — שגיאה עם kind: 'graph_timeout'. live=true — הקריאה
 * שמעלה את הפוסט לאוויר (feed, photos, videos, media_publish): הבקשה אולי
 * הגיעה ומטא פרסמה, ורק התשובה לא חזרה — maybeLive, וההודעה אומרת לבדוק
 * בעמוד לפני שמפרסמים שוב (errors.js). כשל לא חוזר לפרסום לבד בכל מקרה.
 */
async function graph(path, {
  method = 'GET', token, params = {}, form = null, signal, live = false, upload = false,
} = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  let body;

  if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries({ ...params, access_token: token })) {
      if (v == null) continue;
      body.append(k, v);
    }
    for (const [name, file] of Object.entries(form)) {
      body.append(name, new Blob([file.buffer], { type: file.mime }), file.filename);
    }
  } else if (method === 'GET') {
    for (const [k, v] of Object.entries({ ...params, access_token: token })) {
      if (v != null) url.searchParams.set(k, v);
    }
  } else {
    body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, access_token: token })) {
      if (v != null) body.set(k, v);
    }
  }

  const timeoutMs = upload || form ? GRAPH_UPLOAD_TIMEOUT_MS : GRAPH_TIMEOUT_MS;
  let res, data;
  try {
    res = await fetch(url, { method, body, signal: signal ?? AbortSignal.timeout(timeoutMs) });
    // גוף שנקטע באמצע הקריאה (הזמן נגמר) — לא "תשובה ריקה": בלי זה פרסום
    // שהצליח היה חוזר בלי מזהה
    data = await res.json().catch((e) => { if (isAbort(e)) throw e; return {}; });
  } catch (e) {
    if (!isAbort(e)) throw e;
    // רק הנתיב, בלי פרמטרים — בשאילתת GET יש את הטוקן
    throw Object.assign(
      new Error(`Graph API timeout (${method} ${path})`),
      { kind: 'graph_timeout', maybeLive: live, cause: e });
  }
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    throw Object.assign(new Error(e.error_user_msg ?? e.message ?? `Graph API ${res.status}`), {
      code: e.code, subcode: e.error_subcode, type: e.type, status: res.status,
    });
  }
  return data;
}

/* ========================= אימות חיבור ========================= */

/** בדיקה שהטוקן והמזהים אמיתיים. מחזיר את שם העמוד/החשבון לתצוגה. */
export async function verifyConnection({ platform, pageId, igUserId, token }) {
  if (platform === 'facebook') {
    const page = await graph(pageId, { token, params: { fields: 'name' } });
    return `עמוד: ${page.name}`;
  }
  if (platform === 'instagram') {
    const ig = await graph(igUserId, { token, params: { fields: 'username' } });
    return `חשבון: @${ig.username}`;
  }
  throw new Error(`אין אימות לפלטפורמה "${platform}"`);
}

/* ========================= פייסבוק ========================= */

const isImage = (m) => /^image\//.test(m);
const isVideo = (m) => /^video\//.test(m);

/**
 * קובץ לשליחה: {url} — Graph מושך בעצמו מהקישור הציבורי (מדיה ב-R2);
 * {buffer} — multipart כמו קודם (קובץ ישן מהמסד). field = שם הפרמטר
 * ל-URL: 'url' לתמונה, 'file_url' לווידאו.
 */
function mediaArgs(asset, params, field) {
  return asset.url
    ? { params: { ...params, [field]: asset.url } }
    : { params, form: { source: asset } };
}

/**
 * תגובה ראשונה אחרי הפרסום — runner.js קורא לה רק אחרי שהפוסט נרשם
 * "פורסם", כדי שתגובה שנתקעת לא תשאיר פוסט שבאוויר במצב publishing (ומשם
 * "נכשל" ופרסום כפול). כשל חוזר כשגיאה, לא נזרק (runner פותח משימה).
 * 30 שניות לכל היותר.
 * נדרשת הרשאה נוספת בטוקן: pages_manage_engagement (פייסבוק) /
 * instagram_manage_comments (אינסטגרם).
 */
export async function postFirstComment(objectId, token, message) {
  if (!objectId || !String(message ?? '').trim()) return null;
  try {
    await graph(`${objectId}/comments`, {
      method: 'POST', token, params: { message }, signal: AbortSignal.timeout(30000),
    });
    return null;
  } catch (e) {
    // לא ענתה בזמן — ייתכן שהתגובה נכתבה. הודעה משלנו בעברית (עוברת כמו
    // שהיא ב-errors.js), כי ההודעה הכללית של graph_timeout מדברת על הפוסט
    if (e.kind === 'graph_timeout') {
      return new Error('מטא לא ענתה בזמן, וייתכן שהתגובה נכתבה בכל זאת — בודקים בפוסט לפני שמוסיפים אותה');
    }
    return e;
  }
}

/** הטקסט לפייסבוק: בפוסט עם מדיה אין כרטיס קישור, ולכן הקישור נכנס לסוף הטקסט */
export function facebookMessage(message, link, hasMedia) {
  const text = String(message ?? '');
  const url = String(link ?? '').trim();
  if (!url || !hasMedia || text.includes(url)) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${url}` : url;
}

/**
 * פרסום לעמוד פייסבוק. assets = [{url} או {buffer}, mime, filename].
 * וידאו גובר על תמונות (פוסט וידאו); כמה תמונות = פוסט מרובה תמונות.
 * link — בפוסט טקסט: כרטיס תצוגה מקדימה; עם מדיה: בסוף הטקסט.
 * altText — לתמונה בודדת. commentTarget — על מה נכתבת התגובה הראשונה
 * (postFirstComment, אחרי הפרסום).
 * @returns {{id: string, url: string, commentTarget: string}}
 */
export async function publishFacebook({
  pageId, token, message, assets = [], link = null, altText = null,
}) {
  const video = assets.find((a) => isVideo(a.mime));
  const images = assets.filter((a) => isImage(a.mime));
  const text = facebookMessage(message, link, !!(video || images.length));
  const done = (id, url) => ({ id, url, commentTarget: id });

  if (video) {
    const r = await graph(`${pageId}/videos`, {
      method: 'POST', token, live: true, upload: true,
      ...mediaArgs(video, { description: text }, 'file_url'),
    });
    return done(r.id, `https://www.facebook.com/${pageId}/videos/${r.id}`);
  }

  if (images.length === 1) {
    const r = await graph(`${pageId}/photos`, {
      method: 'POST', token, live: true,
      ...mediaArgs(images[0], { caption: text, alt_text_custom: altText || null }, 'url'),
    });
    const id = r.post_id ?? r.id;
    return done(id, `https://www.facebook.com/${id}`);
  }

  if (images.length > 1) {
    // כל תמונה עולה לא-מפורסמת, ואז פוסט אחד אוסף את כולן
    const ids = [];
    for (const img of images) {
      const r = await graph(`${pageId}/photos`, {
        method: 'POST', token, ...mediaArgs(img, { published: 'false' }, 'url'),
      });
      ids.push(r.id);
    }
    const params = { message: text };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const r = await graph(`${pageId}/feed`, { method: 'POST', token, params, live: true });
    return done(r.id, `https://www.facebook.com/${r.id}`);
  }

  const r = await graph(`${pageId}/feed`, {
    method: 'POST', token, live: true,
    params: { message: text, link: String(link ?? '').trim() || null },
  });
  return done(r.id, `https://www.facebook.com/${r.id}`);
}

/* ========================= אינסטגרם ========================= */

/** ממתין שקונטיינר מדיה יסיים עיבוד (וידאו לוקח זמן; תמונות כמעט מיידיות) */
async function waitForContainer(creationId, token, timeoutMs = 5 * 60000) {
  const started = Date.now();
  for (;;) {
    const r = await graph(creationId, { token, params: { fields: 'status_code,status' } });
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR') {
      throw new Error(`אינסטגרם דחה את המדיה: ${r.status ?? 'ללא פירוט'}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw Object.assign(new Error('אינסטגרם לא סיים לעבד את המדיה בזמן סביר'),
        { kind: 'processing_timeout' });
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/**
 * פרסום לאינסטגרם. media = [{url, video: boolean}] — כתובות ציבוריות.
 * פריט אחד = פוסט תמונה או ריל; כמה תמונות = קרוסלה; story = סטורי (פריט
 * אחד, בלי כיתוב — לסטורי אין). altText — לתמונה בודדת בפיד. לריל: coverUrl
 * (תמונת שער) או thumbOffsetMs (פריים מהסרטון). commentTarget — null בסטורי
 * (אין בו תגובות).
 * @returns {{id: string, url: string, commentTarget: string|null}}
 */
export async function publishInstagram({
  igUserId, token, caption, media, story = false, altText = null,
  coverUrl = null, thumbOffsetMs = null,
}) {
  if (!media?.length) throw new Error('אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט');

  let creationId;

  if (story) {
    if (media.length > 1) throw new Error('סטורי יוצא עם תמונה או סרטון אחד');
    const m = media[0];
    const r = await graph(`${igUserId}/media`, {
      method: 'POST', token,
      params: m.video
        ? { media_type: 'STORIES', video_url: m.url }
        : { media_type: 'STORIES', image_url: m.url },
    });
    creationId = r.id;
  } else if (media.length === 1) {
    const m = media[0];
    const r = await graph(`${igUserId}/media`, {
      method: 'POST', token,
      params: m.video
        ? { media_type: 'REELS', video_url: m.url, caption,
            cover_url: coverUrl || null,
            thumb_offset: coverUrl || thumbOffsetMs == null ? null : String(thumbOffsetMs) }
        : { image_url: m.url, caption, alt_text: altText || null },
    });
    creationId = r.id;
  } else {
    // קרוסלה: עד 10 פריטים, כל אחד קונטיינר-ילד משלו (readiness.js חוסם יותר)
    const children = [];
    for (const m of media.slice(0, 10)) {
      const r = await graph(`${igUserId}/media`, {
        method: 'POST', token,
        params: m.video
          ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true' }
          : { image_url: m.url, is_carousel_item: 'true' },
      });
      await waitForContainer(r.id, token);
      children.push(r.id);
    }
    const r = await graph(`${igUserId}/media`, {
      method: 'POST', token,
      params: { media_type: 'CAROUSEL', children: children.join(','), caption },
    });
    creationId = r.id;
  }

  await waitForContainer(creationId, token);
  const pub = await graph(`${igUserId}/media_publish`, {
    method: 'POST', token, live: true, params: { creation_id: creationId },
  });

  const info = await graph(pub.id, { token, params: { fields: 'permalink' } })
    .catch(() => null);
  return { id: pub.id, url: info?.permalink ?? `https://www.instagram.com/`,
           commentTarget: story ? null : pub.id };
}
