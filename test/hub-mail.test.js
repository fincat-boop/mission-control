import './_env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hubMailReady, createNewsletter, newsletterStatus, audienceLists, HubMailError } from '../src/hub-mail.js';

beforeEach(() => {
  process.env.HUB_API_URL = 'https://hub.example.com/';
  process.env.HUB_API_KEY = 'test-key';
});

const fakeFetch = (status, body, calls = []) => {
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
};

test('hubMailReady — דורש את שני המשתנים', () => {
  assert.equal(hubMailReady(), true);
  delete process.env.HUB_API_KEY;
  assert.equal(hubMailReady(), false);
});

test('createNewsletter — בונה בקשה נכונה: URL בלי כפל /, Bearer, גוף snake_case', async () => {
  const f = fakeFetch(201, { ok: true, campaign_id: 'c1', status: 'scheduled', scheduled_at: 'x' });
  const out = await createNewsletter({
    externalRef: 'post-7',
    subject: 'נושא',
    htmlBody: '<p>גוף</p>',
    listIds: ['l1'],
    scheduledAt: '2026-09-01T06:00:00.000Z',
  }, f);
  assert.equal(out.campaign_id, 'c1');
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://hub.example.com/api/v1/mission-control/newsletters');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.list_ids, ['l1']);
  assert.equal(body.external_ref, 'post-7');
  assert.equal(body.scheduled_at, '2026-09-01T06:00:00.000Z');
  assert.equal('name' in body, false);
});

test('createNewsletter — בלי externalRef נדחה מקומית, בלי קריאת רשת', async () => {
  const f = fakeFetch(201, { ok: true });
  await assert.rejects(
    () => createNewsletter({ subject: 'א', htmlBody: 'ב', listIds: ['l'] }, f),
    (e) => e instanceof HubMailError && e.status === 400,
  );
  assert.equal(f.calls.length, 0);
});

test('שגיאת HUB — ה-message של {error} עובר כמו שהוא, עם הסטטוס', async () => {
  const f = fakeFetch(422, { ok: false, error: 'הניוזלטר נחסם' });
  await assert.rejects(
    () => createNewsletter({ externalRef: 'p', subject: 'א', htmlBody: 'ב', listIds: ['l'] }, f),
    (e) => e instanceof HubMailError && e.status === 422 && e.message === 'הניוזלטר נחסם',
  );
});

test('בלי הגדרות env — HubMailError 503, בלי קריאת רשת', async () => {
  delete process.env.HUB_API_URL;
  const f = fakeFetch(200, { ok: true });
  await assert.rejects(() => audienceLists(f), (e) => e instanceof HubMailError && e.status === 503);
  assert.equal(f.calls.length, 0);
});

test('רשת נפלה — HubMailError 502', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => newsletterStatus('c1', f), (e) => e instanceof HubMailError && e.status === 502);
});

test('newsletterStatus — external_ref עם תווים מיוחדים עובר encodeURIComponent', async () => {
  const f = fakeFetch(200, { ok: true, status: 'sent', counts: {} });
  await newsletterStatus('פוסט/7', f);
  assert.ok(f.calls[0].url.endsWith('/newsletters/' + encodeURIComponent('פוסט/7')));
});

test('audienceLists — מחזיר את המערך עצמו', async () => {
  const f = fakeFetch(200, { ok: true, lists: [{ id: 'l1', name: 'רשימה' }] });
  assert.deepEqual(await audienceLists(f), [{ id: 'l1', name: 'רשימה' }]);
});
