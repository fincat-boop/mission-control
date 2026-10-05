import './_env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hubMailReady, createNewsletter, newsletterStatus, audienceLists, newsletterTemplate, newsletterPreview, HubMailError } from '../src/hub-mail.js';

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

test('רשת נפלה — HubMailError 502, אחרי שני ניסיונות חוזרים', async () => {
  let calls = 0;
  const f = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => newsletterStatus('c1', f, { delays: [0, 0] }),
    (e) => e instanceof HubMailError && e.status === 502);
  assert.equal(calls, 3);
});

test('call — נשלח עם signal (תקרת זמן), ו-timeout נחשב תקלה זמנית שחוזרת', async () => {
  const signals = [];
  let n = 0;
  const f = async (_url, init) => {
    signals.push(init.signal);
    n += 1;
    if (n === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => ({ ok: true, campaign_id: 'c1', status: 'sent' }) };
  };
  const s = await newsletterStatus('post-1', f, { delays: [0, 0] });
  assert.equal(s.status, 'sent');
  assert.equal(n, 2);
  assert.ok(signals[0] instanceof AbortSignal);

  const always = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  await assert.rejects(() => newsletterStatus('post-1', always, { delays: [0, 0] }),
    (e) => e instanceof HubMailError && e.status === 502 && /לא ענה תוך 15 שניות/.test(e.message));
});

test('withRetry — 5xx חוזר עד שמצליח; 4xx והגדרה חסרה לא חוזרים', async () => {
  const seq = (...statuses) => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push(url);
      const st = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return { ok: st < 300, status: st, json: async () => (st < 300 ? { ok: true, campaign_id: 'c9', status: 'scheduled' } : { ok: false }) };
    };
    fn.calls = calls;
    return fn;
  };
  const sleeps = [];
  const retry = { delays: [10, 20], sleep: async (ms) => { sleeps.push(ms); } };
  const input = { externalRef: 'post-1', subject: 'א', htmlBody: 'ב' };

  const f1 = seq(503, 502, 200);
  assert.equal((await createNewsletter(input, f1, retry)).campaign_id, 'c9');
  assert.equal(f1.calls.length, 3);
  assert.deepEqual(sleeps, [10, 20]);

  const f2 = seq(500, 500, 500, 200);
  await assert.rejects(() => createNewsletter(input, f2, retry), (e) => e.status === 500);
  assert.equal(f2.calls.length, 3); // שניים נוספים, לא יותר

  const f3 = seq(422);
  await assert.rejects(() => createNewsletter(input, f3, retry), (e) => e.status === 422);
  assert.equal(f3.calls.length, 1);

  delete process.env.HUB_API_URL;
  const f4 = seq(200);
  await assert.rejects(() => newsletterStatus('x', f4, retry), (e) => e.status === 503);
  assert.equal(f4.calls.length, 0);
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

test('createNewsletter — fieldValues עוברים כ-field_values; ריק לא נשלח', async () => {
  const f = fakeFetch(201, { ok: true, campaign_id: 'c1' });
  await createNewsletter({
    externalRef: 'p1', subject: 'א', htmlBody: 'ב', listIds: ['l'],
    fieldValues: { 'טקסט מקדים': 'שלום' },
  }, f);
  assert.deepEqual(JSON.parse(f.calls[0].init.body).field_values, { 'טקסט מקדים': 'שלום' });

  const f2 = fakeFetch(201, { ok: true, campaign_id: 'c2' });
  await createNewsletter({ externalRef: 'p2', subject: 'א', htmlBody: 'ב', listIds: ['l'], fieldValues: {} }, f2);
  assert.equal('field_values' in JSON.parse(f2.calls[0].init.body), false);
});

test('newsletterTemplate — מחזיר את התבנית עצמה (או null)', async () => {
  const tpl = { id: 't1', name: 'ניוזלטר', fields: [{ name: 'תוכן', multiline: true }] };
  const f = fakeFetch(200, { ok: true, template: tpl });
  assert.deepEqual(await newsletterTemplate(f), tpl);
  assert.ok(f.calls[0].url.endsWith('/api/v1/mission-control/newsletter-template'));

  const f2 = fakeFetch(200, { ok: true, template: null });
  assert.equal(await newsletterTemplate(f2), null);
});

test('newsletterPreview — בקשה נכונה ותשובה מלאה', async () => {
  const f = fakeFetch(200, { ok: true, subject: 'פרסומת: א', html: '<html>x</html>', unsafe_vars: [] });
  const out = await newsletterPreview({
    subject: 'א', htmlBody: 'תוכן', name: 'גיליון 5',
    scheduledAt: '2026-09-01T06:00:00.000Z', fieldValues: { 'פתיחה': 'היי' },
  }, f);
  assert.equal(out.html, '<html>x</html>');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.name, 'גיליון 5');
  assert.equal(body.scheduled_at, '2026-09-01T06:00:00.000Z');
  assert.deepEqual(body.field_values, { 'פתיחה': 'היי' });
  assert.ok(f.calls[0].url.endsWith('/api/v1/mission-control/newsletter-preview'));
});
