/**
 * לקוח Meta Graph API — פרסום לעמוד פייסבוק ולחשבון אינסטגרם עסקי.
 *
 * פייסבוק: מדיה ב-R2 נשלחת כקישור ציבורי (url / file_url); קובץ ישן
 * מהמסד עולה ישירות (multipart).
 * אינסטגרם: ה-API מושך את המדיה מ-URL ציבורי (image_url / video_url) —
 * ההעלאה הזמנית ל-R2 קורית ב-runner, לא כאן. וידאו באינסטגרם יוצא כריל.
 */

const GRAPH = 'https://graph.facebook.com/v23.0';

/** קריאת Graph. זורק Error עם ההודעה של Meta כשהתשובה היא שגיאה. */
async function graph(path, { method = 'GET', token, params = {}, form = null } = {}) {
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

  const res = await fetch(url, { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    throw new Error(e.error_user_msg ?? e.message ?? `Graph API ${res.status}`);
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
 * פרסום לעמוד פייסבוק. assets = [{url} או {buffer}, mime, filename].
 * וידאו גובר על תמונות (פוסט וידאו); כמה תמונות = פוסט מרובה תמונות.
 * @returns {{id: string, url: string}}
 */
export async function publishFacebook({ pageId, token, message, assets = [] }) {
  const video = assets.find((a) => isVideo(a.mime));
  const images = assets.filter((a) => isImage(a.mime));

  if (video) {
    const r = await graph(`${pageId}/videos`, {
      method: 'POST', token, ...mediaArgs(video, { description: message }, 'file_url'),
    });
    return { id: r.id, url: `https://www.facebook.com/${pageId}/videos/${r.id}` };
  }

  if (images.length === 1) {
    const r = await graph(`${pageId}/photos`, {
      method: 'POST', token, ...mediaArgs(images[0], { caption: message }, 'url'),
    });
    return { id: r.post_id ?? r.id, url: `https://www.facebook.com/${r.post_id ?? r.id}` };
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
    const params = { message };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const r = await graph(`${pageId}/feed`, { method: 'POST', token, params });
    return { id: r.id, url: `https://www.facebook.com/${r.id}` };
  }

  const r = await graph(`${pageId}/feed`, { method: 'POST', token, params: { message } });
  return { id: r.id, url: `https://www.facebook.com/${r.id}` };
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
      throw new Error('אינסטגרם לא סיים לעבד את המדיה בזמן סביר');
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/**
 * פרסום לאינסטגרם. media = [{url, video: boolean}] — כתובות ציבוריות.
 * פריט אחד = פוסט תמונה או ריל; כמה תמונות = קרוסלה.
 * @returns {{id: string, url: string}}
 */
export async function publishInstagram({ igUserId, token, caption, media }) {
  if (!media?.length) throw new Error('אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט');

  let creationId;

  if (media.length === 1) {
    const m = media[0];
    const r = await graph(`${igUserId}/media`, {
      method: 'POST', token,
      params: m.video
        ? { media_type: 'REELS', video_url: m.url, caption }
        : { image_url: m.url, caption },
    });
    creationId = r.id;
  } else {
    // קרוסלה: עד 10 פריטים, כל אחד קונטיינר-ילד משלו
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
    method: 'POST', token, params: { creation_id: creationId },
  });

  const info = await graph(pub.id, { token, params: { fields: 'permalink' } })
    .catch(() => null);
  return { id: pub.id, url: info?.permalink ?? `https://www.instagram.com/` };
}
