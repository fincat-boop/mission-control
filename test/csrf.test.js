import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csrfGuard } from '../src/csrf.js';

function fakeRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const spyNext = () => { let called = false; const fn = () => { called = true; }; fn.called = () => called; return fn; };

test('csrfGuard — GET עובר תמיד', () => {
  const next = spyNext();
  csrfGuard({ method: 'GET', headers: {} }, fakeRes(), next);
  assert.equal(next.called(), true);
});

test('csrfGuard — POST בלי Origin עובר (שרת-לשרת)', () => {
  const next = spyNext();
  csrfGuard({ method: 'POST', headers: { host: 'app.example' } }, fakeRes(), next);
  assert.equal(next.called(), true);
});

test('csrfGuard — POST עם Origin תואם עובר', () => {
  const next = spyNext();
  csrfGuard(
    { method: 'POST', headers: { host: 'app.example', origin: 'https://app.example' } },
    fakeRes(), next
  );
  assert.equal(next.called(), true);
});

test('csrfGuard — POST עם Origin זר → 403', () => {
  const res = fakeRes();
  const next = spyNext();
  csrfGuard(
    { method: 'POST', headers: { host: 'app.example', origin: 'https://evil.example' } },
    res, next
  );
  assert.equal(res.code, 403);
  assert.equal(next.called(), false);
});

test('csrfGuard — מכבד x-forwarded-host מאחורי פרוקסי', () => {
  const next = spyNext();
  csrfGuard(
    {
      method: 'PUT',
      headers: { host: 'internal:8080', 'x-forwarded-host': 'app.example', origin: 'https://app.example' },
    },
    fakeRes(), next
  );
  assert.equal(next.called(), true);
});
