import jwt from 'jsonwebtoken';

/**
 * לקוח Google Drive מינימלי (REST ישיר, בלי חבילת googleapis הכבדה) —
 * אימות service account ב-JWT חתום עם jsonwebtoken (כבר תלות קיימת בפרויקט).
 * משמש רק לגיבוי החיצוני, ראו offsite-backup.js.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY לא מוגדר');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

let cachedToken = null; // { token, expires }

async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  const { client_email, private_key } = credentials();
  const assertion = jwt.sign(
    { scope: 'https://www.googleapis.com/auth/drive' },
    private_key,
    { algorithm: 'RS256', issuer: client_email, audience: TOKEN_URL, expiresIn: '1h' }
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`קבלת access token מגוגל נכשלה: ${res.status} ${await res.text()}`);

  const data = await res.json();
  cachedToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function driveFetch(path) {
  const token = await accessToken();
  const res = await fetch(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive API ${path} נכשל: ${res.status} ${await res.text()}`);
  return res.json();
}

/** מוצא תיקייה לפי שם מתחת ל-parentId, יוצר אם לא קיימת */
export async function ensureFolder(name, parentId) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name = '${name}' and mimeType = '${FOLDER_MIME}' and trashed = false`
  );
  const found = await driveFetch(`/files?q=${q}&fields=files(id)`);
  if (found.files?.length) return found.files[0].id;

  const token = await accessToken();
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`יצירת תיקייה "${name}" ב-Drive נכשלה: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

export async function uploadJson(name, folderId, content) {
  const token = await accessToken();
  const boundary = 'merkaz-bakara-backup-boundary';
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`העלאת "${name}" ל-Drive נכשלה: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

/** קבצים בתיקייה, מהחדש לישן */
export async function listByCreated(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const data = await driveFetch(
    `/files?q=${q}&fields=files(id,name,createdTime)&orderBy=createdTime desc&pageSize=1000`
  );
  return data.files ?? [];
}

export async function deleteFile(id) {
  const token = await accessToken();
  const res = await fetch(`${DRIVE_API}/files/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`מחיקת קובץ ${id} מ-Drive נכשלה: ${res.status}`);
}
