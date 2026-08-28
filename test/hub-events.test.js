import './_env.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hubEventsReady, emitHubEvent, emitHubEventSafe } from '../src/hub-events.js';

beforeEach(() => {
  process.env.HUB_API_URL = 'https://hub.example.com';
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

test('emitHubEvent — בקשה נכונה: URL, Bearer, occurred_at כ-ISO, email רק כשיש', async () => {
  const f = fakeFetch(202, { ok: true, recorded: true, dispatched: false });
  const out = await emitHubEvent({
    id: 'post_published:7',
    type: 'post_published',
    occurredAt: '2026-08-28T10:00:00.000Z',
    data: { channel: 'facebook' },
  }, f);
  assert.deepEqual(out, { recorded: true, dispatched: false });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://hub.example.com/api/v1/mission-control/events');
  assert.equal(init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(init.body);
  assert.equal(body.occurred_at, '2026-08-28T10:00:00.000Z');
  assert.equal(body.type, 'post_published');
  assert.equal('email' in body, false);
  assert.deepEqual(body.data, { channel: 'facebook' });
});

test('emitHubEvent — בלי id או type נדחה מקומית, בלי רשת', async () => {
  const f = fakeFetch(202, { ok: true });
  await assert.rejects(() => emitHubEvent({ type: 'x' }, f));
  await assert.rejects(() => emitHubEvent({ id: 'a' }, f));
  assert.equal(f.calls.length, 0);
});

test('emitHubEvent — שגיאת HUB זורקת עם ההודעה שלו', async () => {
  const f = fakeFetch(400, { ok: false, error: 'type לא תקין' });
  await assert.rejects(
    () => emitHubEvent({ id: 'a', type: 'bad' }, f),
    (e) => e.message === 'type לא תקין',
  );
});

test('emitHubEventSafe — כשל רשת מחזיר null, לא זורק', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await emitHubEventSafe({ id: 'a', type: 'post_published' }, f), null);
});

test('emitHubEventSafe — בלי env מחזיר null בשקט, בלי רשת', async () => {
  delete process.env.HUB_API_KEY;
  assert.equal(hubEventsReady(), false);
  const f = fakeFetch(202, { ok: true });
  assert.equal(await emitHubEventSafe({ id: 'a', type: 'x' }, f), null);
  assert.equal(f.calls.length, 0);
});

test('emitHubEventSafe — מצליח כרגיל כשהכול תקין', async () => {
  const f = fakeFetch(202, { ok: true, recorded: true, dispatched: true });
  assert.deepEqual(await emitHubEventSafe({ id: 'a', type: 'task_completed' }, f),
    { recorded: true, dispatched: true });
});
