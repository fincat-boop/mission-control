import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePerm } from '../src/auth.js';

// res מזויף שקולט status()/json()
function fakeRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const spyNext = () => { let called = false; const fn = () => { called = true; }; fn.called = () => called; return fn; };

test('requirePerm — בלי משתמש → 401', () => {
  const res = fakeRes();
  const next = spyNext();
  requirePerm('content')({ user: null }, res, next);
  assert.equal(res.code, 401);
  assert.equal(next.called(), false);
});

test('requirePerm — בעלים עוקף הכול', () => {
  const res = fakeRes();
  const next = spyNext();
  requirePerm('settings')({ user: { is_owner: true } }, res, next);
  assert.equal(next.called(), true);
});

test('requirePerm — עם ההרשאה המתאימה → ממשיך', () => {
  const res = fakeRes();
  const next = spyNext();
  requirePerm('content')({ user: { perm_content: true } }, res, next);
  assert.equal(next.called(), true);
});

test('requirePerm — בלי ההרשאה → 403', () => {
  const res = fakeRes();
  const next = spyNext();
  requirePerm('users')({ user: { perm_content: true } }, res, next);
  assert.equal(res.code, 403);
  assert.equal(next.called(), false);
});
