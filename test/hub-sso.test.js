import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyHubSsoToken, hubSsoReady } from '../src/hub-sso.js';

const SECRET = 'shared-sso-secret-for-tests';

const sign = (claims, secret = SECRET, opts = {}) =>
  jwt.sign({ purpose: 'hub-sso', ...claims }, secret, { expiresIn: '60s', ...opts });

test('טוקן תקין מחזיר email מנורמל', () => {
  const email = verifyHubSsoToken(sign({ sub: '  User@Example.COM ' }), SECRET);
  assert.equal(email, 'user@example.com');
});

test('סוד שגוי נדחה', () => {
  assert.equal(verifyHubSsoToken(sign({ sub: 'a@b.co' }, 'wrong-secret-000000'), SECRET), null);
});

test('טוקן פג נדחה', () => {
  const token = sign({ sub: 'a@b.co' }, SECRET, { expiresIn: '-1s' });
  assert.equal(verifyHubSsoToken(token, SECRET), null);
});

test('purpose אחר נדחה — טוקן שנחתם למטרה אחרת באותו סוד לא נכנס', () => {
  assert.equal(verifyHubSsoToken(sign({ sub: 'a@b.co', purpose: 'other' }), SECRET), null);
});

test('בלי sub נדחה', () => {
  assert.equal(verifyHubSsoToken(jwt.sign({ purpose: 'hub-sso' }, SECRET, { expiresIn: '60s' }), SECRET), null);
});

test('אלגוריתם none נדחה', () => {
  const [h, p] = sign({ sub: 'a@b.co' }).split('.');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(verifyHubSsoToken(`${noneHeader}.${p}.`, SECRET), null);
  assert.equal(verifyHubSsoToken(`${h}.${p}.`, SECRET), null);
});

// משקף אחד-לאחד את signMissionControlSsoToken ב-HUB (lib/mission-control/sso.ts) —
// חתימה ידנית על node:crypto. אם הפורמט שם ישתנה, הטסט הזה חייב להישבר.
test('אימות צולב — טוקן בפורמט שה-HUB חותם', () => {
  const b64url = (s) => Buffer.from(s).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: 'hub@example.com', purpose: 'hub-sso', iat, exp: iat + 60 }));
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(verifyHubSsoToken(`${header}.${payload}.${sig}`, SECRET), 'hub@example.com');
});

test('hubSsoReady — דורש סוד באורך מינימלי', () => {
  const prev = process.env.HUB_SSO_SECRET;
  try {
    delete process.env.HUB_SSO_SECRET;
    assert.equal(hubSsoReady(), false);
    process.env.HUB_SSO_SECRET = 'short';
    assert.equal(hubSsoReady(), false);
    process.env.HUB_SSO_SECRET = 'long-enough-secret-16+';
    assert.equal(hubSsoReady(), true);
  } finally {
    if (prev === undefined) delete process.env.HUB_SSO_SECRET; else process.env.HUB_SSO_SECRET = prev;
  }
});
