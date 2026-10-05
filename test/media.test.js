import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetView, fmtLimit, isAllowedMime, isOwnKey, legacyMediaKey, mediaReady, mediaUrl,
  newMediaKey, safeFilename, validateSignRequest, validateUploaded, MAX_MEDIA_BYTES,
} from '../src/media.js';

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_BUCKET: 'backups',
  R2_PUBLIC_BUCKET: 'media', R2_PUBLIC_BASE_URL: 'https://pub-x.r2.dev/',
};
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('MAX_MEDIA_BYTES — ברירת מחדל 1GB', () => {
  assert.equal(MAX_MEDIA_BYTES, 1024 * 1024 * 1024);
  assert.equal(fmtLimit(MAX_MEDIA_BYTES), '1GB');
  assert.equal(fmtLimit(50 * 1048576), '50MB');
});

test('mediaReady — דורש גם R2_* וגם R2_PUBLIC_*', () => {
  withEnv({ ...R2_ENV }, () => assert.equal(mediaReady(), true));
  withEnv({ ...R2_ENV, R2_PUBLIC_BASE_URL: '' }, () => assert.equal(mediaReady(), false));
  withEnv({ ...R2_ENV, R2_SECRET_ACCESS_KEY: '' }, () => assert.equal(mediaReady(), false));
});

test('safeFilename — שומר סיומת, מנקה נתיב ותווים מסוכנים', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\me\\My Photo #1.JPG'), 'My-Photo-1.jpg');
  assert.equal(safeFilename('a?b%c&d.png'), 'a-b-c-d.png');
  assert.equal(safeFilename('\u0000\u202e evil.exe.mp4'), 'evil.exe.mp4');
  assert.equal(safeFilename('...'), 'file');
  assert.equal(safeFilename(''), 'file');
  assert.equal(safeFilename('.png'), 'file.png');
});

test('safeFilename — עברית מותרת, אורך מוגבל', () => {
  assert.equal(safeFilename('תמונה של החתול.jpeg'), 'תמונה-של-החתול.jpeg');
  const long = safeFilename(`${'א'.repeat(300)}.mp4`);
  assert.equal(long, `${'א'.repeat(80)}.mp4`);
});

test('newMediaKey — media/<org>/<uuid>/<שם>, אקראי בכל קריאה', () => {
  const a = newMediaKey(3, 'x y.png');
  const b = newMediaKey(3, 'x y.png');
  assert.match(a, /^media\/3\/[0-9a-f-]{36}\/x-y\.png$/);
  assert.notEqual(a, b);
  assert.equal(isOwnKey(3, a), true);
});

test('isOwnKey — רק מפתח שהונפק לארגון הזה', () => {
  const k = newMediaKey(3, 'a.png');
  assert.equal(isOwnKey(4, k), false);                     // ארגון אחר
  assert.equal(isOwnKey('3', k), true);
  assert.equal(isOwnKey(3, k.replace('media/3/', 'media/3/../4/')), false);
  assert.equal(isOwnKey(3, 'media/3/legacy-5/a.png'), false); // legacy — רק התחזוקה
  assert.equal(isOwnKey(3, 'publish/abc.png'), false);
  assert.equal(isOwnKey(3, `${k}/extra`), false);
  assert.equal(isOwnKey(3, null), false);
  assert.equal(isOwnKey(3, 'media/33/' + k.split('/').slice(2).join('/')), false);
});

test('legacyMediaKey — דטרמיניסטי', () => {
  assert.equal(legacyMediaKey(2, 17, 'סרטון.MP4'), 'media/2/legacy-17/סרטון.mp4');
  assert.equal(legacyMediaKey(2, 17, 'סרטון.MP4'), legacyMediaKey(2, 17, 'סרטון.MP4'));
});

test('mediaUrl — בסיס בלי / כפול, קידוד לכל מקטע', () => {
  withEnv(R2_ENV, () => {
    assert.equal(mediaUrl('media/1/u/תמונה.jpg'),
      'https://pub-x.r2.dev/media/1/u/%D7%AA%D7%9E%D7%95%D7%A0%D7%94.jpg');
  });
  withEnv({ R2_PUBLIC_BASE_URL: '' }, () => assert.equal(mediaUrl('media/1/u/a.jpg'), null));
});

test('assetView — url במקום storage_key, בלי bytes', () => {
  withEnv(R2_ENV, () => {
    const v = assetView({ id: 1, filename: 'a.png', storage_key: 'media/1/u/a.png', data: Buffer.from('x') });
    assert.deepEqual(v, { id: 1, filename: 'a.png', url: 'https://pub-x.r2.dev/media/1/u/a.png' });
    assert.equal(assetView({ id: 2, storage_key: null }).url, null);
  });
});

test('isAllowedMime', () => {
  for (const m of ['image/png', 'video/mp4', 'audio/mpeg', 'application/pdf', 'image/svg+xml']) {
    assert.equal(isAllowedMime(m), true, m);
  }
  for (const m of ['text/html', 'application/javascript', '', null, 'image/', 'application/zip']) {
    assert.equal(isAllowedMime(m), false, String(m));
  }
});

test('validateSignRequest', () => {
  const ok = { filename: 'a.mp4', mime: 'video/mp4', size: 5 };
  assert.equal(validateSignRequest(ok, 10), null);
  assert.match(validateSignRequest({ ...ok, size: 11 }, 10), /גדול מדי/);
  assert.match(validateSignRequest({ ...ok, size: 0 }, 10), /גודל/);
  assert.match(validateSignRequest({ ...ok, size: 'abc' }, 10), /גודל/);
  assert.match(validateSignRequest({ ...ok, mime: 'text/html' }, 10), /סוג קובץ/);
  assert.match(validateSignRequest({ ...ok, filename: ' ' }, 10), /שם קובץ/);
  assert.match(validateSignRequest(null, 10), /ריקה/);
});

test('validateUploaded — חסר / חורג / סוג אסור / תקין', () => {
  assert.equal(validateUploaded(null, 10).status, 409);
  assert.equal(validateUploaded(null, 10).purge, false);
  assert.deepEqual(
    { s: validateUploaded({ size: 11, contentType: 'image/png' }, 10).status,
      p: validateUploaded({ size: 11, contentType: 'image/png' }, 10).purge },
    { s: 413, p: true });
  assert.equal(validateUploaded({ size: 3, contentType: 'text/html' }, 10).status, 415);
  assert.equal(validateUploaded({ size: 0, contentType: 'image/png' }, 10).purge, true);
  assert.equal(validateUploaded({ size: 3, contentType: 'image/png; charset=x' }, 10), null);
});
