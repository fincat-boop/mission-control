import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/publish/crypto.js';
import { publishBlocker } from '../src/publish/runner.js';

/* ========================= הצפנת טוקנים ========================= */

test('encryptSecret/decryptSecret — הלוך ושוב', () => {
  const token = 'EAAB-some-meta-token-אבג';
  const enc = encryptSecret(token);
  assert.notEqual(enc, token);
  assert.equal(decryptSecret(enc), token);
});

test('encryptSecret — כל הצפנה שונה (IV אקראי) אבל נפענחת לאותו ערך', () => {
  const a = encryptSecret('x');
  const b = encryptSecret('x');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('decryptSecret — קלט משובש זורק, לא מחזיר זבל', () => {
  assert.throws(() => decryptSecret('not.a.token'));
});

/* ========================= מה חוסם פרסום ========================= */

const base = () => ({
  post: {
    platform: 'facebook', channel_name: 'פייסבוק', page_id: '123',
    ig_user_id: null, access_token_enc: 'enc', content_id: 7,
  },
  variant: { status: 'ready', body: 'טקסט מוכן' },
  assets: [],
});

test('publishBlocker — פייסבוק עם טקסט מוכן: אין חסימה', () => {
  assert.equal(publishBlocker(base()), null);
});

test('publishBlocker — פלטפורמה בלי אינטגרציה נחסמת', () => {
  const p = base();
  p.post.platform = 'whatsapp';
  assert.match(publishBlocker(p), /וואטסאפ/);
  p.post.platform = 'manual';
  assert.match(publishBlocker(p), /לא מחובר/);
});

test('publishBlocker — בלי טוקן נחסם', () => {
  const p = base();
  p.post.access_token_enc = null;
  assert.match(publishBlocker(p), /חיבור/);
});

test('publishBlocker — פייסבוק בלי page_id נחסם', () => {
  const p = base();
  p.post.page_id = null;
  assert.match(publishBlocker(p), /עמוד/);
});

test('publishBlocker — גרסה שאינה ready נחסמת', () => {
  const p = base();
  p.variant.status = 'draft';
  assert.match(publishBlocker(p), /מוכן/);
});

test('publishBlocker — בלי תוכן משויך נחסם', () => {
  const p = base();
  p.post.content_id = null;
  assert.match(publishBlocker(p), /אין תוכן/);
});

test('publishBlocker — אינסטגרם בלי מדיה נחסם', () => {
  const p = base();
  p.post.platform = 'instagram';
  p.post.ig_user_id = '456';
  assert.match(publishBlocker(p), /תמונה או וידאו/);
});

test('publishBlocker — פייסבוק בלי טקסט ובלי מדיה נחסם', () => {
  const p = base();
  p.variant.body = '   ';
  assert.match(publishBlocker(p), /אין מה לפרסם/);
});

test('publishBlocker — פייסבוק בלי טקסט אבל עם תמונה עובר', () => {
  const p = base();
  p.variant.body = '';
  p.assets = [{ mime: 'image/jpeg' }];
  assert.equal(publishBlocker(p), null);
});

/* ========================= ניוזלטר (HUB) ========================= */

const mailBase = () => ({
  post: { platform: 'newsletter', channel_name: 'ניוזלטר', content_id: 7,
          access_token_enc: null, page_id: null, ig_user_id: null },
  variant: { status: 'ready', body: '<p>גוף</p>',
             meta: { subject: 'נושא', list_ids: ['l1'] } },
  assets: [],
});

test('publishBlocker — ניוזלטר תקין עובר כשה-HUB מוגדר', () => {
  process.env.HUB_API_URL = 'https://hub.example.com';
  process.env.HUB_API_KEY = 'k';
  assert.equal(publishBlocker(mailBase()), null);
});

test('publishBlocker — ניוזלטר בלי HUB_API_* נחסם', () => {
  delete process.env.HUB_API_URL;
  delete process.env.HUB_API_KEY;
  assert.match(publishBlocker(mailBase()), /HUB_API/);
});

test('publishBlocker — ניוזלטר בלי נושא נחסם', () => {
  process.env.HUB_API_URL = 'https://hub.example.com';
  process.env.HUB_API_KEY = 'k';
  const p = mailBase();
  p.variant.meta.subject = '  ';
  assert.match(publishBlocker(p), /נושא/);
});

test('publishBlocker — ניוזלטר בלי רשימת יעד עובר (ה-HUB שולח לרשימת העל)', () => {
  process.env.HUB_API_URL = 'https://hub.example.com';
  process.env.HUB_API_KEY = 'k';
  const p = mailBase();
  p.variant.meta.list_ids = [];
  assert.equal(publishBlocker(p), null);
});

test('publishBlocker — ניוזלטר עם גרסה לא מוכנה נחסם', () => {
  process.env.HUB_API_URL = 'https://hub.example.com';
  process.env.HUB_API_KEY = 'k';
  const p = mailBase();
  p.variant.status = 'draft';
  assert.match(publishBlocker(p), /מוכן/);
});
