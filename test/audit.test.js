import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../src/audit.js';

/** מריץ את ה-middleware על בקשה מדומה; מחזיר אם נרשם מאזין לסיום (= ייכתב ליומן) */
async function run(method, path) {
  let listening = false;
  const json = () => {};
  const res = { json, on: () => { listening = true; } };
  let nexted = false;
  await audit({ method, path, body: {}, get: () => null }, res, () => { nexted = true; });
  assert.equal(nexted, true);
  return { listening, wrapped: res.json !== json };
}

test('audit — התצוגה המקדימה של קיבולת לא נרשמת ביומן', async () => {
  const r = await run('POST', '/campaigns/capacity-preview');
  assert.deepEqual(r, { listening: false, wrapped: false });
});

test('audit — שורות ההשלכה בניהול לא נרשמות ביומן (סעיף 35)', async () => {
  const r = await run('POST', '/settings/consequences');
  assert.deepEqual(r, { listening: false, wrapped: false });
});

test('audit — שמירת כללי המנוע כן נרשמת', async () => {
  const r = await run('PATCH', '/settings');
  assert.deepEqual(r, { listening: true, wrapped: true });
});

test('audit — יצירת קמפיין כן נרשמת', async () => {
  const r = await run('POST', '/campaigns');
  assert.deepEqual(r, { listening: true, wrapped: true });
});
