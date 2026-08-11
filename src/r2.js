import { createHash, createHmac } from 'node:crypto';

/**
 * לקוח Cloudflare R2 מינימלי (S3-compatible, path-style) עם חתימת AWS
 * SigV4 שכתובה ידנית על node:crypto — בלי aws-sdk. משמש רק לגיבוי המלא,
 * ראו full-backup.js.
 *
 * משתני סביבה:
 *   R2_ACCOUNT_ID         מזהה החשבון (חלק מכתובת ה-endpoint)
 *   R2_ACCESS_KEY_ID      מפתח גישה (R2 API token)
 *   R2_SECRET_ACCESS_KEY  הסוד
 *   R2_BUCKET             שם ה-bucket
 */

const REGION = 'auto';
const SERVICE = 's3';

export const r2Ready = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
     process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

function config() {
  const {
    R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKey,
    R2_SECRET_ACCESS_KEY: secretKey, R2_BUCKET: bucket,
  } = process.env;
  if (!r2Ready()) throw new Error('R2 לא מוגדר — חסר אחד ממשתני R2_*');
  return { account, accessKey, secretKey, bucket, host: `${account}.r2.cloudflarestorage.com` };
}

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** קידוד לפי כללי S3: כל תו שאינו unreserved מקודד. הנתיב שומר על '/'. */
function enc(str, encodeSlash = true) {
  return String(str).replace(/[^A-Za-z0-9\-_.~]/g, (c) => {
    if (c === '/' && !encodeSlash) return c;
    return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

const stamp = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
// 20260811T080742Z (amz-date) ו-20260811 (תאריך בלבד)

/**
 * מבצע בקשה חתומה ל-R2. body הוא Buffer/מחרוזת (או null לבקשות בלי גוף).
 * מחזיר את ה-Response של fetch.
 */
async function r2Request(method, { key = '', query = {}, body = null, contentType } = {}) {
  const { accessKey, secretKey, bucket, host } = config();

  const amzDate = stamp();
  const dateOnly = amzDate.slice(0, 8);
  const payload = body == null ? '' : body;
  const payloadHash = sha256hex(payload);

  // path-style: /<bucket>/<key>
  const canonicalUri = '/' + enc(bucket) + (key ? '/' + enc(key, false) : '');

  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${headers[h]}\n`).join('');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateOnly}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, dateOnly);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}` + (canonicalQuery ? `?${canonicalQuery}` : '');
  return fetch(url, { method, headers, body: body ?? undefined });
}

export async function putObject(key, body, contentType = 'application/octet-stream') {
  const res = await r2Request('PUT', { key, body, contentType });
  if (!res.ok) throw new Error(`R2 PUT ${key} נכשל: ${res.status} ${await res.text()}`);
}

export async function getObject(key) {
  const res = await r2Request('GET', { key });
  if (!res.ok) throw new Error(`R2 GET ${key} נכשל: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteObject(key) {
  const res = await r2Request('DELETE', { key });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} נכשל: ${res.status}`);
}

/**
 * רשימת מפתחות תחת prefix. עם delimiter='/' מחזיר גם את ה"תיקיות"
 * (CommonPrefixes). מטפל בעימוד דרך continuation-token.
 * @returns {Promise<{keys:string[], prefixes:string[]}>}
 */
export async function listObjects(prefix = '', delimiter = '') {
  const keys = [];
  const prefixes = [];
  let token;
  do {
    const query = { 'list-type': '2', prefix };
    if (delimiter) query.delimiter = delimiter;
    if (token) query['continuation-token'] = token;

    const res = await r2Request('GET', { query });
    if (!res.ok) throw new Error(`R2 LIST ${prefix} נכשל: ${res.status} ${await res.text()}`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
    for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) prefixes.push(decodeXml(m[1]));

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = truncated && next ? decodeXml(next[1]) : null;
  } while (token);

  // ה-prefix עצמו לא נחשב "תיקיית משנה"
  return { keys, prefixes: prefixes.filter((p) => p !== prefix) };
}

const decodeXml = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
