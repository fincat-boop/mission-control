import { createHash, createHmac } from 'node:crypto';

/**
 * לקוח Cloudflare R2 מינימלי (S3-compatible, path-style) עם חתימת AWS
 * SigV4 שכתובה ידנית על node:crypto — בלי aws-sdk. משמש לגיבוי המלא
 * (full-backup.js) ולאחסון המדיה (media.js): bucket ציבורי נפרד, העלאה
 * ישירה מהדפדפן דרך presigned PUT.
 *
 * משתני סביבה:
 *   R2_ACCOUNT_ID         מזהה החשבון (חלק מכתובת ה-endpoint)
 *   R2_ACCESS_KEY_ID      מפתח גישה (R2 API token)
 *   R2_SECRET_ACCESS_KEY  הסוד
 *   R2_BUCKET             שם ה-bucket (ברירת המחדל — הגיבויים)
 */

const REGION = 'auto';
const SERVICE = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

export const r2Ready = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
     process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

/** ה-host של ה-endpoint של R2 — גם ל-CSP (connect-src) של ההעלאה מהדפדפן */
export const r2Host = () =>
  (process.env.R2_ACCOUNT_ID ? `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);

function config(bucketOverride) {
  const {
    R2_ACCESS_KEY_ID: accessKey, R2_SECRET_ACCESS_KEY: secretKey, R2_BUCKET: bucket,
  } = process.env;
  if (!r2Ready()) throw new Error('R2 לא מוגדר — חסר אחד ממשתני R2_*');
  return { accessKey, secretKey, bucket: bucketOverride ?? bucket, host: r2Host() };
}

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * קידוד לפי כללי S3 (RFC 3986): כל בייט UTF-8 שאינו unreserved מקודד.
 * הנתיב שומר על '/'. (עד אוקטובר 2026 תו שאינו ASCII קודד לפי charCode
 * ולא לפי UTF-8 — עבד כי שום מפתח לא הכיל כזה; מפתחות מדיה עם שם עברי כן.)
 */
export function enc(str, encodeSlash = true) {
  let out = '';
  for (const byte of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (c === '/' && !encodeSlash)) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** 20260811T080742Z (amz-date). התאריך בלבד = 8 התווים הראשונים. */
export const amzStamp = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

/** path-style: /<bucket>/<key>, מקודד */
const canonicalPath = (bucket, key) =>
  '/' + enc(bucket) + (key ? '/' + enc(key, false) : '');

const canonicalQueryOf = (query) => Object.keys(query).sort()
  .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');

function signature({ secretKey, dateOnly, region, stringToSign }) {
  const kDate = hmac(`AWS4${secretKey}`, dateOnly);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

/**
 * ליבת החתימה בכותרות — טהורה (host/תאריך/מפתחות מוזרקים), כדי שאפשר
 * יהיה לבדוק אותה בלי רשת ובלי שעון.
 * @returns {{url:string, headers:object}}
 */
export function signRequest({
  method, host, bucket, key = '', query = {}, body = null, contentType,
  accessKey, secretKey, amzDate, region = REGION, extraHeaders = {},
}) {
  const dateOnly = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body == null ? '' : body);
  const canonicalUri = canonicalPath(bucket, key);
  const canonicalQuery = canonicalQueryOf(query);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  // כותרות x-amz-* נוספות (למשל x-amz-copy-source) — חייבות להיחתם
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${headers[h]}\n`).join('');

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateOnly}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature({ secretKey, dateOnly, region, stringToSign })}`;

  const url = `https://${host}${canonicalUri}` + (canonicalQuery ? `?${canonicalQuery}` : '');
  return { url, headers };
}

/**
 * ליבת ה-presign (SigV4 ב-query string) — טהורה. הגוף UNSIGNED-PAYLOAD.
 * headers = כותרות נוספות שנחתמות מלבד host (שם באותיות קטנות → ערך), למשל
 * content-type ו-content-length: הלקוח חייב לשלוח בדיוק אותם ערכים, אחרת
 * החתימה לא תתאים. canonicalUri מגיע מקודד; bucket=null = virtual-host (הצורה
 * של וקטור הבדיקה של AWS), אחרת path-style כמו כל השאר כאן.
 * @returns {{url:string, canonicalRequest:string}}
 */
export function presignParts({
  method = 'PUT', host, bucket = null, key, accessKey, secretKey, amzDate,
  expiresSec = 900, region = REGION, headers = {},
}) {
  const dateOnly = amzDate.slice(0, 8);
  const scope = `${dateOnly}/${region}/${SERVICE}/aws4_request`;
  const canonicalUri = bucket ? canonicalPath(bucket, key) : '/' + enc(key, false);
  const all = { host };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(';');
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = canonicalQueryOf(query);
  const canonicalHeaders = names.map((h) => `${h}:${all[h]}\n`).join('');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, UNSIGNED,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');
  const sig = signature({ secretKey, dateOnly, region, stringToSign });
  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`,
    canonicalRequest,
  };
}

export const presignUrl = (opts) => presignParts(opts).url;

/**
 * URL חתום להעלאה ישירה (PUT) מהדפדפן ל-R2, תקף expiresSec שניות.
 * headers נחתמות (ראו presignParts) — הדפדפן חייב לשלוח אותן בדיוק.
 */
export function presignPut(key, { bucket, expiresSec = 900, headers = {} } = {}) {
  const c = config(bucket);
  return presignUrl({
    method: 'PUT', host: c.host, bucket: c.bucket, key, headers,
    accessKey: c.accessKey, secretKey: c.secretKey, amzDate: amzStamp(), expiresSec,
  });
}

/**
 * מבצע בקשה חתומה ל-R2. body הוא Buffer/מחרוזת (או null לבקשות בלי גוף).
 * מחזיר את ה-Response של fetch.
 */
async function r2Request(method, {
  key = '', query = {}, body = null, contentType, bucket: bucketOverride, extraHeaders,
} = {}) {
  const { accessKey, secretKey, bucket, host } = config(bucketOverride);
  const { url, headers } = signRequest({
    method, host, bucket, key, query, body, contentType, accessKey, secretKey, amzDate: amzStamp(),
    extraHeaders,
  });
  return fetch(url, { method, headers, body: body ?? undefined });
}

export async function putObject(key, body, contentType = 'application/octet-stream', bucket) {
  const res = await r2Request('PUT', { key, body, contentType, bucket });
  if (!res.ok) throw new Error(`R2 PUT ${key} נכשל: ${res.status} ${await res.text()}`);
}

export async function getObject(key, bucket) {
  const res = await r2Request('GET', { key, bucket });
  if (!res.ok) throw new Error(`R2 GET ${key} נכשל: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** גודל וסוג של אובייקט, או null אם אינו קיים */
export async function headObject(key, bucket) {
  const res = await r2Request('HEAD', { key, bucket });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD ${key} נכשל: ${res.status}`);
  return {
    size: Number(res.headers.get('content-length') ?? 0),
    contentType: res.headers.get('content-type') ?? null,
  };
}

/**
 * העתקה בתוך ה-bucket, בצד של R2 — הבייטים לא עוברים דרכנו (גם וידאו של 1GB).
 * הסוג (content-type) נשמר מהמקור. S3 עלול להחזיר 200 עם <Error> בגוף.
 */
export async function copyObject(srcKey, dstKey, bucket) {
  const { bucket: b } = config(bucket);
  const res = await r2Request('PUT', {
    key: dstKey, bucket,
    extraHeaders: { 'x-amz-copy-source': `/${enc(b)}/${enc(srcKey, false)}` },
  });
  const text = await res.text();
  if (!res.ok || text.includes('<Error>')) {
    throw new Error(`R2 COPY ${srcKey} → ${dstKey} נכשל: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function deleteObject(key, bucket) {
  const res = await r2Request('DELETE', { key, bucket });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} נכשל: ${res.status}`);
}

/**
 * רשימת מפתחות תחת prefix. עם delimiter='/' מחזיר גם את ה"תיקיות"
 * (CommonPrefixes). מטפל בעימוד דרך continuation-token. objects נושא גם
 * את זמן השינוי והגודל (לניקוי יתומים במדיה).
 * @returns {Promise<{keys:string[], prefixes:string[], objects:{key:string, lastModified:Date|null, size:number}[]}>}
 */
export async function listObjects(prefix = '', delimiter = '', { bucket } = {}) {
  const keys = [];
  const prefixes = [];
  const objects = [];
  let token;
  do {
    const query = { 'list-type': '2', prefix };
    if (delimiter) query.delimiter = delimiter;
    if (token) query['continuation-token'] = token;

    const res = await r2Request('GET', { query, bucket });
    if (!res.ok) throw new Error(`R2 LIST ${prefix} נכשל: ${res.status} ${await res.text()}`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
    for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) prefixes.push(decodeXml(m[1]));
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = m[1].match(/<Key>([^<]+)<\/Key>/);
      if (!k) continue;
      const lm = m[1].match(/<LastModified>([^<]+)<\/LastModified>/);
      const sz = m[1].match(/<Size>(\d+)<\/Size>/);
      objects.push({
        key: decodeXml(k[1]),
        lastModified: lm ? new Date(lm[1]) : null,
        size: sz ? Number(sz[1]) : 0,
      });
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = truncated && next ? decodeXml(next[1]) : null;
  } while (token);

  // ה-prefix עצמו לא נחשב "תיקיית משנה"
  return { keys, prefixes: prefixes.filter((p) => p !== prefix), objects };
}

const decodeXml = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
