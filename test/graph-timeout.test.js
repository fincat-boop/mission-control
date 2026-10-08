import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postFirstComment, publishFacebook, publishInstagram } from '../src/publish/meta.js';
import { friendlyPublishError } from '../src/publish/errors.js';

/**
 * הגבלת זמן לקריאות Graph (meta.js): כל קריאה יוצאת עם signal, קריאה
 * שלא ענתה בזמן הופכת לשגיאה graph_timeout, והקריאה שמעלה את הפוסט
 * מסומנת maybeLive — ההודעה אומרת לבדוק בעמוד לפני שמפרסמים שוב.
 * fetch מזויף זורק TimeoutError כמו ש-AbortSignal.timeout עושה, בלי לחכות דקה.
 */

const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/** fetch מזויף: הנתיב (בלי גרסה) → תשובה, או 'timeout'. רושם אם נשלח signal */
async function withFetch(routes, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ path, signal: opts.signal });
    const r = routes(path);
    if (r === 'timeout') throw timeoutErr();
    if (r === 'body-timeout') {
      return { ok: true, status: 200, json: () => Promise.reject(timeoutErr()) };
    }
    return new Response(JSON.stringify(r ?? { id: 'x1' }), { status: 200 });
  };
  try {
    return { out: await fn(), calls };
  } catch (e) {
    return { error: e, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('כל קריאה ל-Graph יוצאת עם הגבלת זמן (signal)', async () => {
  const { calls, error } = await withFetch(() => null,
    () => publishFacebook({ pageId: '9', token: 't', message: 'שלום' }));
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('פייסבוק: /feed לא ענה בזמן — graph_timeout עם maybeLive, וההודעה: לבדוק בעמוד', async () => {
  const { error } = await withFetch(() => 'timeout',
    () => publishFacebook({ pageId: '9', token: 't', message: 'שלום' }));
  assert.equal(error.kind, 'graph_timeout');
  assert.equal(error.maybeLive, true);
  assert.doesNotMatch(error.message, /access_token|\bt\b=/);
  const f = friendlyPublishError(error, { platform: 'facebook' });
  assert.equal(f.who, 'owner');
  assert.match(f.message, /פייסבוק לא ענתה בזמן/);
  assert.match(f.message, /ייתכן שהוא עלה/);
  assert.match(f.message, /בודקים בעמוד/);
});

test('פייסבוק: גוף התשובה נקטע בזמן הקריאה — שגיאה, לא "הצלחה בלי מזהה"', async () => {
  const { error, out } = await withFetch(() => 'body-timeout',
    () => publishFacebook({ pageId: '9', token: 't', message: 'שלום' }));
  assert.equal(out, undefined);
  assert.equal(error.kind, 'graph_timeout');
  assert.equal(error.maybeLive, true);
});

test('פייסבוק כמה תמונות: העלאת תמונה לא-מפורסמת לא ענתה — לא maybeLive', async () => {
  const img = (n) => ({ url: `https://pub.example/${n}.png`, mime: 'image/png', filename: `${n}.png` });
  const { error } = await withFetch((p) => (p === '9/photos' ? 'timeout' : null),
    () => publishFacebook({ pageId: '9', token: 't', message: 'm', assets: [img(1), img(2)] }));
  assert.equal(error.kind, 'graph_timeout');
  assert.equal(error.maybeLive, false);
  const f = friendlyPublishError(error, { platform: 'facebook' });
  assert.match(f.message, /לא ענתה בזמן, והפוסט לא עלה/);
  assert.match(f.message, /מפרסמים שוב/);
});

test('אינסטגרם: יצירת קונטיינר לא ענתה — לא maybeLive; media_publish לא ענה — maybeLive', async () => {
  const media = [{ url: 'https://pub.example/1.jpg', video: false }];
  const created = await withFetch((p) => (p === '17/media' ? 'timeout' : null),
    () => publishInstagram({ igUserId: '17', token: 't', caption: 'c', media }));
  assert.equal(created.error.kind, 'graph_timeout');
  assert.equal(created.error.maybeLive, false);

  const published = await withFetch((p) => {
    if (p === '17/media') return { id: 'c1' };
    if (p === 'c1') return { status_code: 'FINISHED' };
    if (p === '17/media_publish') return 'timeout';
    return null;
  }, () => publishInstagram({ igUserId: '17', token: 't', caption: 'c', media }));
  assert.equal(published.error.kind, 'graph_timeout');
  assert.equal(published.error.maybeLive, true);
  assert.match(friendlyPublishError(published.error, { platform: 'instagram' }).message,
    /אינסטגרם לא ענתה בזמן אחרי ששלחנו את הפוסט/);
});

test('תגובה ראשונה שלא ענתה בזמן — הודעה על התגובה, לא "הפוסט לא עלה"', async () => {
  const { out } = await withFetch(() => 'timeout', () => postFirstComment('9_1', 't', 'תגובה'));
  assert.ok(out instanceof Error);
  const f = friendlyPublishError(out, { platform: 'facebook' });
  assert.match(f.message, /ייתכן שהתגובה נכתבה/);
  assert.doesNotMatch(f.message, /הפוסט לא עלה/);
});

test('שגיאת רשת אחרת (לא הגבלת זמן) — עוברת כמו שהיא', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(publishFacebook({ pageId: '9', token: 't', message: 'm' }),
      (e) => e instanceof TypeError && e.kind === undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
