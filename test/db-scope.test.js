import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantContext, currentOrg, query, rows, one, tx } from '../src/db.js';

// client מזויף שקולט קריאות query בלי לגעת ב-DB אמיתי
function fakeClient(result = { rows: [] }) {
  const calls = [];
  return {
    calls,
    query(text, params) { calls.push({ text, params }); return Promise.resolve(result); },
  };
}

const inOrg = (orgId, client, fn) => tenantContext.run({ client, orgId }, fn);

test('currentOrg — null מחוץ להקשר', () => {
  assert.equal(currentOrg(), null);
});

test('currentOrg — מחזיר את ה-org בתוך ההקשר', () => {
  inOrg(42, fakeClient(), () => assert.equal(currentOrg(), 42));
});

test('query — מנותב ל-client של ההקשר', async () => {
  const c = fakeClient({ rows: [{ x: 1 }] });
  await inOrg(7, c, async () => {
    const r = await query('select 1', [9]);
    assert.deepEqual(r.rows, [{ x: 1 }]);
  });
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].text, 'select 1');
  assert.deepEqual(c.calls[0].params, [9]);
});

test('rows/one — משתמשים ב-client של ההקשר', async () => {
  const c = fakeClient({ rows: [{ id: 1 }, { id: 2 }] });
  await inOrg(1, c, async () => {
    assert.deepEqual(await rows('select'), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(await one('select'), { id: 1 });
  });
});

test('one — מחזיר null כשאין שורות', async () => {
  const c = fakeClient({ rows: [] });
  await inOrg(1, c, async () => {
    assert.equal(await one('select'), null);
  });
});

test('tx — בתוך הקשר משתמש ב-client הקיים בלי begin מקונן', async () => {
  const c = fakeClient();
  let received;
  await inOrg(3, c, async () => {
    await tx((client) => { received = client; return Promise.resolve('ok'); });
  });
  assert.equal(received, c);
  // לא נפתחה טרנזקציה מקוננת
  assert.equal(c.calls.filter((x) => x.text === 'begin').length, 0);
});
