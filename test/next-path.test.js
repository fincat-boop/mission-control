import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../src/next-path.js';
import { signState, verifyState } from '../src/google-auth.js';

test('נתיב יחסי עם hash עובר כמו שהוא', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/#tasks'), '/#tasks');
  assert.equal(safeNext('/#plan;e=3;c=7'), '/#plan;e=3;c=7');
  assert.equal(safeNext('/?week=2026-10-05#board'), '/?week=2026-10-05#board');
});

test('כתובת מלאה או protocol-relative נדחות', () => {
  for (const v of ['https://evil.com', 'http://evil.com/x', '//evil.com', '//evil.com/#tasks',
                   'javascript:alert(1)', 'evil.com', '#tasks', '']) {
    assert.equal(safeNext(v), null, v);
  }
});

test('לוכסן הפוך ותווי בקרה נדחים', () => {
  for (const v of ['/\\evil.com', '/\\/evil.com', '\\\\evil.com', '/\t/evil.com', '/\n/evil.com', '/%0a']) {
    // "/%0a" מקודד — לא תו בקרה בפועל, ולכן עובר
    if (v === '/%0a') { assert.equal(safeNext(v), '/%0a'); continue; }
    assert.equal(safeNext(v), null, JSON.stringify(v));
  }
});

test('לא ל-/api ולא חזרה לדף הכניסה', () => {
  assert.equal(safeNext('/api/auth/logout'), null);
  assert.equal(safeNext('/api'), null);
  assert.equal(safeNext('/login.html'), null);
  assert.equal(safeNext('/login'), null);
  assert.equal(safeNext('/./api/x'), null);
});

test('לא מחרוזת או ארוך מדי — נדחה', () => {
  assert.equal(safeNext(undefined), null);
  assert.equal(safeNext(['/']), null);
  assert.equal(safeNext(`/${'a'.repeat(600)}`), null);
});

test('ה-next נשמר בתוך ה-state החתום של Google', () => {
  const claims = verifyState(signState('/#tasks'));
  assert.equal(claims.next, '/#tasks');
  assert.equal(verifyState(signState()).next, undefined);
  assert.equal(verifyState('not-a-token'), null);
});
