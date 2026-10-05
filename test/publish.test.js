import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/publish/crypto.js';
import { facebookAssets, publishBlocker, publishInstagramPost } from '../src/publish/runner.js';

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

/* ========================= מדיה ב-R2 בפרסום ========================= */

const withBase = (fn) => async () => {
  const saved = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = 'https://pub-x.r2.dev';
  try { await fn(); } finally {
    if (saved === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = saved;
  }
};

function igDeps() {
  const calls = { upload: [], remove: [], publish: [] };
  return {
    calls,
    deps: {
      upload: async (a) => {
        calls.upload.push(a.filename);
        return { url: `https://pub-x.r2.dev/publish/tmp-${a.filename}`, key: `publish/tmp-${a.filename}` };
      },
      remove: async (keys) => { calls.remove.push(...keys); },
      publish: async (args) => { calls.publish.push(args); return { id: 'ig1', url: 'https://ig/p/1' }; },
    },
  };
}

const igPost = { ig_user_id: '456' };

test('publishInstagramPost — קובץ ב-R2: הקישור הקבוע, בלי עותק ובלי מחיקה', withBase(async () => {
  const { calls, deps } = igDeps();
  await publishInstagramPost({
    post: igPost, token: 't', text: 'כיתוב',
    media: [{ storage_key: 'media/1/u/reel.mp4', mime: 'video/mp4', filename: 'reel.mp4' }],
  }, deps);
  assert.deepEqual(calls.upload, []);
  assert.deepEqual(calls.remove, []);
  assert.deepEqual(calls.publish[0].media,
    [{ url: 'https://pub-x.r2.dev/media/1/u/reel.mp4', video: true }]);
}));

test('publishInstagramPost — קובץ ישן: עותק זמני ומחיקה שלו בלבד', withBase(async () => {
  const { calls, deps } = igDeps();
  await publishInstagramPost({
    post: igPost, token: 't', text: '',
    media: [
      { storage_key: 'media/1/u/a.jpg', mime: 'image/jpeg', filename: 'a.jpg' },
      { storage_key: null, data: Buffer.from('x'), mime: 'image/jpeg', filename: 'old.jpg' },
    ],
  }, deps);
  assert.deepEqual(calls.upload, ['old.jpg']);
  assert.deepEqual(calls.remove, ['publish/tmp-old.jpg']);   // לא media/1/u/a.jpg
  assert.deepEqual(calls.publish[0].media.map((m) => m.url),
    ['https://pub-x.r2.dev/media/1/u/a.jpg', 'https://pub-x.r2.dev/publish/tmp-old.jpg']);
}));

test('publishInstagramPost — גם כשהפרסום נכשל, רק העותק הזמני נמחק', withBase(async () => {
  const { calls, deps } = igDeps();
  deps.publish = async () => { throw new Error('Graph נפל'); };
  await assert.rejects(publishInstagramPost({
    post: igPost, token: 't', text: '',
    media: [
      { storage_key: 'media/1/u/a.jpg', mime: 'image/jpeg', filename: 'a.jpg' },
      { storage_key: null, data: Buffer.from('x'), mime: 'image/jpeg', filename: 'old.jpg' },
    ],
  }, deps), /Graph נפל/);
  assert.deepEqual(calls.remove, ['publish/tmp-old.jpg']);
}));

test('facebookAssets — R2 כקישור, ישן כבייטים', withBase(async () => {
  const out = facebookAssets([
    { storage_key: 'media/1/u/v.mp4', mime: 'video/mp4', filename: 'v.mp4', data: null },
    { storage_key: null, data: Buffer.from('ab'), mime: 'image/png', filename: 'p.png' },
  ]);
  assert.deepEqual(out[0], { url: 'https://pub-x.r2.dev/media/1/u/v.mp4', mime: 'video/mp4', filename: 'v.mp4' });
  assert.equal(out[1].buffer.toString(), 'ab');
  assert.equal(out[1].url, undefined);
}));

test('publishBlocker — קובץ ב-R2 בלי כתובת ציבורית נחסם', () => {
  const saved = process.env.R2_PUBLIC_BASE_URL;
  delete process.env.R2_PUBLIC_BASE_URL;
  try {
    const p = base();
    p.assets = [{ mime: 'image/jpeg', storage_key: 'media/1/u/a.jpg' }];
    assert.match(publishBlocker(p), /R2_PUBLIC_BASE_URL/);
  } finally {
    if (saved !== undefined) process.env.R2_PUBLIC_BASE_URL = saved;
  }
});

test('publishFacebook — קישור: url לתמונה, file_url לווידאו, בלי multipart', async () => {
  const { publishFacebook } = await import('../src/publish/meta.js');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ path: new URL(url).pathname, body: opts.body });
    return new Response(JSON.stringify({ id: 'x1', post_id: 'p1' }), { status: 200 });
  };
  try {
    await publishFacebook({ pageId: '9', token: 't', message: 'm',
      assets: [{ url: 'https://pub-x.r2.dev/media/1/u/p.png', mime: 'image/png', filename: 'p.png' }] });
    await publishFacebook({ pageId: '9', token: 't', message: 'm',
      assets: [{ url: 'https://pub-x.r2.dev/media/1/u/v.mp4', mime: 'video/mp4', filename: 'v.mp4' }] });
    await publishFacebook({ pageId: '9', token: 't', message: 'm',
      assets: [{ buffer: Buffer.from('ab'), mime: 'image/png', filename: 'old.png' }] });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(sent[0].path, /\/9\/photos$/);
  assert.ok(sent[0].body instanceof URLSearchParams);
  assert.equal(sent[0].body.get('url'), 'https://pub-x.r2.dev/media/1/u/p.png');
  assert.match(sent[1].path, /\/9\/videos$/);
  assert.equal(sent[1].body.get('file_url'), 'https://pub-x.r2.dev/media/1/u/v.mp4');
  assert.ok(sent[2].body instanceof FormData);           // קובץ ישן — multipart כמו קודם
  assert.ok(sent[2].body.get('source'));
});
