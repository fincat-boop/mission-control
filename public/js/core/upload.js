import { api } from './api.js';
import { esc } from './dom.js';
import { state } from './state.js';

/**
 * העלאת קבצים. שכבה 0 — נשען רק על core.
 *
 * כשאחסון המדיה (R2) מוגדר בשרת (state.media.ready, מגיע עם /api/me):
 *   חתימה בשרת → PUT ישיר מהדפדפן ל-R2 (עם התקדמות) → דיווח לשרת.
 *   הקובץ לא עובר דרך השרת, ולכן אפשר עד MAX_MEDIA_MB (ברירת מחדל 1GB).
 * אחרת (מקומית / לפני שהוגדר): multipart לשרת כמו קודם, עד 50MB.
 * גם אם השרת עונה 503 על החתימה — נופלים למסלול הישן.
 */

const LEGACY_MAX_MB = 50;

const mediaOn = () => !!state.media?.ready;
const maxMb = () => (mediaOn() ? state.media.max_mb : LEGACY_MAX_MB);

const fmtMb = (mb) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}GB` : `${mb}MB`);

/** הטקסט ליד בורר הקבצים: "עד 1GB לקובץ" */
export const fileLimitLabel = () => `עד ${fmtMb(maxMb())} לקובץ`;

/** accept לבורר הקבצים — רק כשהמדיה ב-R2 (שם יש רשימה סגורה) */
export const acceptAttr = () =>
  (mediaOn() && state.media.allowed_mimes?.length ? state.media.allowed_mimes.join(',') : '');

/** בדיקה מקומית לפני העלאה — שגיאה ברורה מיד, לא אחרי דקות של PUT */
function precheck(files) {
  const max = maxMb() * 1048576;
  for (const f of files) {
    if (f.size > max) throw new Error(`"${f.name}" גדול מדי — ${fileLimitLabel()}`);
    // הרשימה מגיעה מהשרת (/api/me) — מקור אחד לשני הצדדים
    if (mediaOn() && !(state.media.allowed_mimes ?? []).includes((f.type || '').toLowerCase())) {
      throw new Error(`"${f.name}" — סוג קובץ לא נתמך (תמונות, סרטונים, אודיו, PDF ומסמכי Office)`);
    }
  }
}

/** XHR ולא fetch — רק ל-XHR יש אירועי התקדמות של העלאה */
function xhrSend(method, url, body, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* R2 מחזיר XML/ריק */ }
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.onerror = () => reject(new Error('ההעלאה נכשלה — בעיית רשת'));
    xhr.onabort = () => reject(new Error('ההעלאה בוטלה'));
    xhr.send(body);
  });
}

async function putToStorage(signPath, file, extra, onProgress) {
  const { key, url, headers } = await api(signPath, {
    method: 'POST',
    body: { filename: file.name, mime: file.type, size: file.size, ...extra },
  });
  // הכותרות חתומות ב-URL (סוג וגודל) — שולחים בדיוק את מה שהשרת חתם.
  // Content-Length הדפדפן קובע לבד, מגודל הקובץ.
  const res = await xhrSend('PUT', url, file, { headers: headers ?? {}, onProgress });
  if (!res.ok) throw new Error(`ההעלאה של "${file.name}" לאחסון נכשלה (${res.status})`);
  return key;
}

/** multipart לשרת — המסלול הישן (bytea) */
async function legacyMultipart(path, files, extraFields, onProgress) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
  const res = await xhrSend('POST', `/api${path}`, fd, {
    // מנה אחת — ההתקדמות מתחלקת בין הקבצים לפי הגודל
    onProgress: (loaded) => {
      let left = loaded;
      files.forEach((f, i) => {
        const part = Math.max(0, Math.min(f.size, left));
        left -= f.size;
        onProgress?.(i, part, f.size);
      });
    },
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('נדרשת התחברות'); }
  if (!res.ok) throw new Error(res.data.error || 'הקבצים לא נשמרו');
  return res.data;
}

const isNotConfigured = (e) => e?.status === 503;

/**
 * קבצים לזווית (משותפים) או לגרסה של מדיה אחת (channelId).
 * onProgress(index, loaded, total) לכל קובץ.
 * @returns {Promise<object[]>} שורות הקבצים שנשמרו
 */
export async function uploadFiles(contentId, files, { channelId = null, onProgress } = {}) {
  const list = [...files];
  if (!list.length) return [];
  precheck(list);

  const legacy = () => legacyMultipart(
    channelId ? `/content/${contentId}/variants/${channelId}/assets` : `/content/${contentId}/assets`,
    list, {}, onProgress).then((d) => d.assets ?? []);
  if (!mediaOn()) return legacy();

  const saved = [];
  for (const [i, f] of list.entries()) {
    let key;
    try {
      key = await putToStorage(`/content/${contentId}/uploads/sign`, f,
        channelId ? { channel_id: channelId } : {}, (l, t) => onProgress?.(i, l, t));
    } catch (e) {
      if (i === 0 && isNotConfigured(e)) return legacy();
      throw e;
    }
    const { asset } = await api(`/content/${contentId}/uploads/complete`, {
      method: 'POST',
      body: { key, filename: f.name, ...(channelId ? { channel_id: channelId } : {}) },
    });
    saved.push(asset);
  }
  return saved;
}

/**
 * העלאה מרוכזת לקמפיין: כל קובץ הופך לזווית. כל הקבצים עולים קודם,
 * ורק אז נוצרות הזוויות — במנה אחת, כמו במסלול הישן.
 */
export async function uploadBulk(campaignId, files, { kind, onProgress } = {}) {
  const list = [...files];
  precheck(list);

  const legacy = () => legacyMultipart(`/campaigns/${campaignId}/bulk`, list, { kind }, onProgress);
  if (!mediaOn()) return legacy();

  const uploaded = [];
  for (const [i, f] of list.entries()) {
    try {
      const key = await putToStorage(`/campaigns/${campaignId}/bulk/sign`, f, {},
        (l, t) => onProgress?.(i, l, t));
      uploaded.push({ key, filename: f.name });
    } catch (e) {
      if (i === 0 && isNotConfigured(e)) return legacy();
      throw e;
    }
  }
  return api(`/campaigns/${campaignId}/bulk/media`, {
    method: 'POST', body: { kind, files: uploaded },
  });
}

/**
 * רשימת התקדמות לכל קובץ בתוך container. מחזיר את ה-onProgress
 * להעביר ל-uploadFiles/uploadBulk.
 */
export function progressList(container, files) {
  if (!container) return undefined;
  const list = [...files];
  container.hidden = !list.length;
  container.innerHTML = list.map((f, i) => `
    <div class="upl" data-upl="${i}">
      <span class="upl-name">${esc(f.name)}</span>
      <span class="upl-bar"><i style="width:0%"></i></span>
      <span class="upl-pct">0%</span>
    </div>`).join('');
  return (i, loaded, total) => {
    const row = container.querySelector(`[data-upl="${i}"]`);
    if (!row) return;
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    row.querySelector('i').style.width = `${pct}%`;
    row.querySelector('.upl-pct').textContent = `${pct}%`;
  };
}
