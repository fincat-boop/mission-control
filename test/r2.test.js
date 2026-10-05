import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enc, presignUrl, signRequest } from '../src/r2.js';

/* ========================= presign (SigV4 ב-query string) ========================= */

// הווקטור הרשמי של AWS: "Example: A presigned URL" ב-sigv4-query-string-auth
test('presignUrl — וקטור הבדיקה הרשמי של AWS (examplebucket GET)', () => {
  const url = presignUrl({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', bucket: null, key: 'test.txt',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z', expiresSec: 86400, region: 'us-east-1',
  });
  assert.equal(url,
    'https://examplebucket.s3.amazonaws.com/test.txt' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
    '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('presignUrl — R2 path-style: bucket בנתיב, region auto, UTF-8 בשם', () => {
  const url = presignUrl({
    method: 'PUT', host: 'acct.r2.cloudflarestorage.com', bucket: 'media-bkt',
    key: 'media/1/abc/תמונה.jpg', accessKey: 'AK', secretKey: 'SK',
    amzDate: '20261005T120000Z', expiresSec: 900,
  });
  assert.match(url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/media-bkt\/media\/1\/abc\/%D7%AA%D7%9E%D7%95%D7%A0%D7%94\.jpg\?/);
  assert.match(url, /X-Amz-Credential=AK%2F20261005%2Fauto%2Fs3%2Faws4_request/);
  assert.match(url, /X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
});

/* ========================= חתימה בכותרות — זהה לקוד שלפני השינוי ========================= */

// הערכים נלכדו מהקוד הקודם (r2Request לפני הפירוק ל-signRequest) עם אותם קלטים
const creds = {
  host: 'acct123.r2.cloudflarestorage.com', accessKey: 'AKIDTEST',
  secretKey: 'secretTEST', amzDate: '20260811T080742Z',
};

test('signRequest — PUT עם גוף ו-content-type זהה לפלט הקודם', () => {
  const { url, headers } = signRequest({
    ...creds, method: 'PUT', bucket: 'backup-bkt', key: 'daily/2026/dump.json',
    body: '{"a":1}', contentType: 'application/json',
  });
  assert.equal(url, 'https://acct123.r2.cloudflarestorage.com/backup-bkt/daily/2026/dump.json');
  assert.equal(headers['x-amz-content-sha256'],
    '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  assert.equal(headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDTEST/20260811/auto/s3/aws4_request, ' +
    'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
    'Signature=5618320c961550553d975d7912c1f0c386528a2b9e0695442c82db9e4a757268');
});

test('signRequest — GET בלי גוף זהה לפלט הקודם', () => {
  const { url, headers } = signRequest({
    ...creds, method: 'GET', bucket: 'backup-bkt', key: 'daily/2026/assets/5',
  });
  assert.equal(url, 'https://acct123.r2.cloudflarestorage.com/backup-bkt/daily/2026/assets/5');
  assert.equal(headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDTEST/20260811/auto/s3/aws4_request, ' +
    'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
    'Signature=c832cc7be561241b67e1ad7d1b27b94187cbdc77d8e10c69fbc39fa9ee503d3d');
});

test('signRequest — LIST עם query זהה לפלט הקודם', () => {
  const { url, headers } = signRequest({
    ...creds, method: 'GET', bucket: 'backup-bkt',
    query: { 'list-type': '2', prefix: 'daily/', delimiter: '/' },
  });
  assert.equal(url,
    'https://acct123.r2.cloudflarestorage.com/backup-bkt?delimiter=%2F&list-type=2&prefix=daily%2F');
  assert.equal(headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDTEST/20260811/auto/s3/aws4_request, ' +
    'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
    'Signature=b4689f110e09b7b622ae4364335b7c5ad362d303e196c64ee3ae305ad7db78ed');
});

test('enc — ASCII כמו קודם, ותו שאינו ASCII לפי בייטים של UTF-8', () => {
  assert.equal(enc('a b/c', false), 'a%20b/c');
  assert.equal(enc('a/b'), 'a%2Fb');
  assert.equal(enc("x!'()*"), 'x%21%27%28%29%2A');
  assert.equal(enc('ä'), '%C3%A4');
  assert.equal(enc('ק'), '%D7%A7');
});
