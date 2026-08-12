import jwt from 'jsonwebtoken';

/**
 * התחברות דרך Google — OAuth 2.0 Authorization Code flow, כולו בצד שרת.
 * אנחנו לא טוענים סקריפט של גוגל בדף (ולכן אין צורך לרופף את ה-CSP): המשתמש
 * מנווט ל-/api/auth/google, מופנה לגוגל, וחוזר ל-callback עם code שאותו אנחנו
 * מחליפים בשרת (מאומת ב-client_secret) לפרטי הזהות.
 *
 * מי מורשה להתחבר: רק email שכבר קיים כמשתמש (הבעלים מאשר ע"י הוספת משתמש).
 *
 * משתני סביבה: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. אופציונלי
 * GOOGLE_REDIRECT_URI (אחרת נגזר מכתובת הבקשה).
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VALID_ISS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export const googleReady = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function redirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/google/callback`;
}

/** URL ההפניה לגוגל, עם state לחתימה נגד CSRF */
export function authUrl(req, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  return `${AUTH_URL}?${p}`;
}

/* ---- state חתום (נגד CSRF ב-OAuth) ---- */
const stateSecret = () => process.env.SESSION_SECRET;
export const signState = () => jwt.sign({ n: Date.now() }, stateSecret(), { expiresIn: '10m' });
export function verifyState(s) {
  try { jwt.verify(s, stateSecret()); return true; } catch { return false; }
}

/**
 * מחליף code בפרטי זהות. ה-id_token מגיע ישירות מגוגל בתגובה לחילוף המאומת
 * ב-client_secret over TLS — ולכן מותר לפענח את ה-payload בלי אימות חתימה
 * (המלצת גוגל לטוקנים שמתקבלים ישירות מ-token endpoint). עדיין מוודאים
 * aud, iss ו-email_verified.
 * @returns {Promise<{email:string, ok:boolean}>}
 */
export async function exchangeCode(req, code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange נכשל: ${res.status} ${await res.text()}`);

  const { id_token } = await res.json();
  if (!id_token) throw new Error('אין id_token בתשובת גוגל');
  const claims = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'));

  const ok =
    claims.aud === process.env.GOOGLE_CLIENT_ID &&
    VALID_ISS.has(claims.iss) &&
    claims.email_verified === true &&
    (claims.exp ?? 0) * 1000 > Date.now() &&
    !!claims.email;

  return { email: String(claims.email ?? '').trim().toLowerCase(), ok };
}
