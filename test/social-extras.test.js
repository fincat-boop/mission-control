import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentBlocker, coverAsset, metaExtrasError, postMedia, validLink,
} from '../src/publish/readiness.js';
import { publishInstagramPost, publishOptions } from '../src/publish/runner.js';
import { facebookMessage, postFirstComment, publishFacebook, publishInstagram } from '../src/publish/meta.js';
import {
  badFeedRatio, captionCounts, extraSummary, extrasFor, extrasKey, mergeExtras, pickExtras,
} from '../public/js/core/socialRules.js';

/*
 * מה שנוסף לגרסה מעבר לטקסט ולקבצים (content_variants.meta): סוג פרסום,
 * שער לריל, תגובה ראשונה, תיאור תמונה, קישור — הכללים, מה שנשלח ל-Graph,
 * והעורך (החלק הטהור).
 */

const img = (id, name = `p${id}.jpg`) => ({ id, mime: 'image/jpeg', filename: name });
const vid = (id) => ({ id, mime: 'video/mp4', filename: `v${id}.mp4` });

/* ========================= כללי "מוכן" ========================= */

test('contentBlocker — סטורי באינסטגרם: קובץ אחד בדיוק', () => {
  const v = { body: '', meta: { format: 'story' } };
  assert.equal(contentBlocker({ platform: 'instagram', variant: v, assets: [img(1)] }), null);
  assert.match(contentBlocker({ platform: 'instagram', variant: v, assets: [img(1), img(2)] }),
    /סטורי יוצא עם תמונה או סרטון אחד — יש 2/);
  // בסטורי אין כיתוב — טקסט ארוך לא חוסם
  assert.equal(contentBlocker({ platform: 'instagram',
    variant: { body: 'א'.repeat(3000), meta: { format: 'story' } }, assets: [img(1)] }), null);
});

test('contentBlocker — אינסטגרם: כיתוב, האשטגים, תיוגים וקרוסלה במגבלות של Graph', () => {
  const at = (body, assets = [img(1)]) => contentBlocker({ platform: 'instagram', variant: { body }, assets });
  assert.equal(at('א'.repeat(2200)), null);
  assert.match(at('א'.repeat(2201)), /2201 תווים מתוך 2200/);
  assert.equal(at(Array.from({ length: 30 }, (_, i) => `#תג${i}`).join(' ')), null);
  assert.match(at(Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')), /31 מתוך 30/);
  assert.match(at(Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ')), /תיוגים/);
  // מייל בטקסט הוא לא תיוג
  assert.equal(at(Array.from({ length: 25 }, (_, i) => `a${i}@x.com`).join(' ')), null);
  // יותר מ-10 לא נחסם — יוצאים 10 הראשונים, כמו לפני השדות החדשים
  assert.equal(at('', Array.from({ length: 11 }, (_, i) => img(i + 1))), null);
});

test('contentBlocker — תמונת השער של הריל לא נספרת כפריט (לא הופכת לקרוסלה)', () => {
  const meta = { cover_asset_id: 2 };
  assert.equal(contentBlocker({ platform: 'instagram',
    variant: { body: '', meta: { format: 'story', ...meta } }, assets: [vid(1), img(2)] }), null);
  assert.deepEqual(postMedia({ variant: { meta }, assets: [vid(1), img(2)] }).map((a) => a.id), [1]);
  assert.equal(coverAsset({ variant: { meta }, assets: [vid(1), img(2)] }).id, 2);
  // בלי וידאו אין ריל — התמונה היא תוכן רגיל, לא שער
  assert.deepEqual(postMedia({ variant: { meta }, assets: [img(2)] }).map((a) => a.id), [2]);
  assert.equal(coverAsset({ variant: { meta }, assets: [img(2)] }), null);
});

test('contentBlocker — פייסבוק: קישור לבד הוא תוכן, קישור לא תקין חוסם', () => {
  assert.equal(contentBlocker({ platform: 'facebook',
    variant: { body: '', meta: { link: 'https://fincat.co.il/x' } } }), null);
  assert.match(contentBlocker({ platform: 'facebook',
    variant: { body: 'טקסט', meta: { link: 'fincat' } } }), /הקישור לא תקין/);
  // בוואטסאפ הקישור לא יוצא — לא נחשב תוכן ולא נבדק
  assert.match(contentBlocker({ platform: 'whatsapp',
    variant: { body: '', meta: { link: 'https://x.co' } } }), /אין טקסט ואין מדיה/);
});

test('metaExtrasError — נבדק בשמירה: קישור רק http/https, אורכים, סוגים', () => {
  assert.equal(metaExtrasError(null), null);
  assert.equal(metaExtrasError({ subject: 'נושא', field_values: {} }), null);   // ניוזלטר
  assert.equal(metaExtrasError({ format: 'story', cover_asset_id: 3, cover_offset_sec: 2.5,
    first_comment: 'תגובה', alt_text: 'תיאור', link: 'https://a.co' }), null);
  assert.match(metaExtrasError({ link: 'javascript:alert(1)' }), /הקישור לא תקין/);
  assert.match(metaExtrasError({ format: 'reel' }), /סוג פרסום/);
  assert.match(metaExtrasError({ cover_asset_id: '3' }), /שער/);
  assert.match(metaExtrasError({ cover_offset_sec: -1 }), /0 ל-900/);
  assert.match(metaExtrasError({ alt_text: 'א'.repeat(1001) }), /תיאור התמונה ארוך מדי/);
  assert.match(metaExtrasError({ first_comment: 5 }), /התגובה הראשונה לא תקין/);
  assert.match(metaExtrasError([]), /meta/);
  assert.equal(validLink('http://x.co'), true);
  assert.equal(validLink('https://localhost'), false);
});

/* ========================= מה נשלח ל-Graph ========================= */

test('publishOptions — תיאור תמונה רק לתמונה בודדת; קישור רק לפייסבוק; שנייה → מילישניות', () => {
  const meta = { alt_text: ' תיאור ', first_comment: ' #תג ', link: 'https://a.co', cover_offset_sec: 2.5 };
  assert.deepEqual(publishOptions({ platform: 'facebook', variant: { meta }, media: [img(1)] }),
    { comment: '#תג', altText: 'תיאור', link: 'https://a.co' });
  assert.deepEqual(publishOptions({ platform: 'instagram', variant: { meta }, media: [img(1), img(2)] }),
    { comment: '#תג', altText: null, story: false, thumbOffsetMs: 2500 });
  assert.equal(publishOptions({ platform: 'instagram', variant: { meta: { format: 'story' } },
    media: [vid(1)] }).story, true);
  assert.equal(publishOptions({ platform: 'instagram', variant: null, media: [] }).comment, null);
});

test('facebookMessage — עם מדיה הקישור לסוף הטקסט (פעם אחת), בלי מדיה — לא', () => {
  assert.equal(facebookMessage('שלום', 'https://a.co', true), 'שלום\n\nhttps://a.co');
  assert.equal(facebookMessage('', 'https://a.co', true), 'https://a.co');
  assert.equal(facebookMessage('ראו https://a.co', 'https://a.co', true), 'ראו https://a.co');
  assert.equal(facebookMessage('שלום', 'https://a.co', false), 'שלום');
});

/** fetch מזויף ל-Graph: רושם כל קריאה, ומחזיר לפי הנתיב */
async function withGraph(reply, fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const params = opts.body instanceof URLSearchParams ? Object.fromEntries(opts.body) : {};
    const call = { path: u.pathname.replace(/^\/v[\d.]+\//, ''), method: opts.method ?? 'GET', params };
    sent.push(call);
    const out = reply(call);
    return new Response(JSON.stringify(out), { status: out?.error ? 400 : 200 });
  };
  try {
    return { sent, result: await fn() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('publishFacebook — טקסט עם קישור: כרטיס (link); התגובה הראשונה לא נכתבת כאן', async () => {
  const { sent, result } = await withGraph(() => ({ id: 'post1' }), () =>
    publishFacebook({ pageId: '9', token: 't', message: 'שלום', link: 'https://a.co' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '9/feed');
  assert.deepEqual([sent[0].params.message, sent[0].params.link], ['שלום', 'https://a.co']);
  assert.equal(result.commentTarget, 'post1');
});

test('publishFacebook — תמונה בודדת: alt_text_custom, קישור בסוף הכיתוב, יעד התגובה = post_id', async () => {
  const { sent, result } = await withGraph(() => ({ id: 'ph1', post_id: '9_77' }), () =>
    publishFacebook({ pageId: '9', token: 't', message: 'שלום', link: 'https://a.co',
      altText: 'תיאור',
      assets: [{ url: 'https://pub/p.jpg', mime: 'image/jpeg', filename: 'p.jpg' }] }));
  assert.equal(sent[0].path, '9/photos');
  assert.equal(sent[0].params.alt_text_custom, 'תיאור');
  assert.equal(sent[0].params.caption, 'שלום\n\nhttps://a.co');
  assert.equal(sent[0].params.link, undefined);
  assert.equal(result.commentTarget, '9_77');
});

test('postFirstComment — נכתבת על היעד; כשל חוזר כשגיאה ולא נזרק; ריק — כלום', async () => {
  const ok = await withGraph(() => ({ id: 'c1' }), () => postFirstComment('post1', 't', 'תגובה'));
  assert.equal(ok.sent[0].path, 'post1/comments');
  assert.equal(ok.sent[0].params.message, 'תגובה');
  assert.equal(ok.result, null);
  const bad = await withGraph(() => ({ error: { message: '(#200) pages_manage_engagement', code: 200 } }),
    () => postFirstComment('post1', 't', 'תגובה'));
  assert.match(bad.result.message, /pages_manage_engagement/);
  const none = await withGraph(() => ({}), () => postFirstComment('post1', 't', '  '));
  assert.equal(none.sent.length, 0);
  assert.equal(none.result, null);
});

const igReply = (c) => {
  if (c.path === '456/media') return { id: `cont${c.params.media_type ?? 'IMG'}` };
  if (c.path === '456/media_publish') return { id: 'm1' };
  if (c.method === 'GET' && c.path.startsWith('cont')) return { status_code: 'FINISHED' };
  if (c.method === 'GET' && c.path === 'm1') return { permalink: 'https://ig/p/1' };
  return { id: 'c1' };
};

test('publishInstagram — סטורי: STORIES בלי כיתוב, ואין יעד לתגובה', async () => {
  const { sent, result } = await withGraph(igReply, () => publishInstagram({
    igUserId: '456', token: 't', caption: 'לא יוצא', story: true,
    media: [{ url: 'https://pub/v.mp4', video: true }] }));
  assert.deepEqual(sent[0].params, { media_type: 'STORIES', video_url: 'https://pub/v.mp4', access_token: 't' });
  assert.equal(result.commentTarget, null);
  assert.equal(result.url, 'https://ig/p/1');
});

test('publishInstagram — ריל עם שער: cover_url גובר על thumb_offset; יעד התגובה = המדיה', async () => {
  const { sent, result } = await withGraph(igReply, () => publishInstagram({
    igUserId: '456', token: 't', caption: 'כיתוב', coverUrl: 'https://pub/c.jpg', thumbOffsetMs: 3000,
    media: [{ url: 'https://pub/v.mp4', video: true }] }));
  assert.equal(sent[0].params.media_type, 'REELS');
  assert.equal(sent[0].params.cover_url, 'https://pub/c.jpg');
  assert.equal(sent[0].params.thumb_offset, undefined);
  assert.ok(!sent.some((c) => c.path.endsWith('/comments')));
  assert.equal(result.commentTarget, 'm1');
});

test('publishInstagram — ריל בלי שער: thumb_offset; תמונה בודדת: alt_text', async () => {
  const reel = await withGraph(igReply, () => publishInstagram({
    igUserId: '456', token: 't', caption: '', thumbOffsetMs: 2500,
    media: [{ url: 'https://pub/v.mp4', video: true }] }));
  assert.equal(reel.sent[0].params.thumb_offset, '2500');
  const photo = await withGraph(igReply, () => publishInstagram({
    igUserId: '456', token: 't', caption: '', altText: 'תיאור',
    media: [{ url: 'https://pub/p.jpg', video: false }] }));
  assert.equal(photo.sent[0].params.alt_text, 'תיאור');
});

test('publishInstagramPost — שער מקובץ ישן: עותק זמני ציבורי שנמחק בסוף', async () => {
  const removed = [];
  let args;
  await publishInstagramPost({
    post: { ig_user_id: '456' }, token: 't', text: 'כיתוב',
    media: [{ storage_key: null, data: Buffer.from('v'), mime: 'video/mp4', filename: 'v.mp4' }],
    cover: { storage_key: null, data: Buffer.from('c'), mime: 'image/jpeg', filename: 'c.jpg' },
    options: { comment: 'x', story: false, altText: null, thumbOffsetMs: null },
  }, {
    upload: async (a) => ({ url: `https://pub/tmp-${a.filename}`, key: `tmp-${a.filename}` }),
    remove: async (keys) => { removed.push(...keys); },
    publish: async (a) => { args = a; return { id: 'm1', url: 'u', commentTarget: 'm1' }; },
  });
  assert.equal(args.coverUrl, 'https://pub/tmp-c.jpg');
  assert.equal(args.comment, undefined);   // התגובה — ב-runner, אחרי שהפוסט נרשם
  assert.deepEqual(removed, ['tmp-v.mp4', 'tmp-c.jpg']);
});

/* ========================= העורך (החלק הטהור) ========================= */

test('extrasFor — כל האזורים בכל ערוץ, בלי התאמה בהגדרות; ניוזלטר — בעורך המייל', () => {
  const all = ['format', 'cover', 'link', 'first_comment', 'alt_text'];
  for (const p of ['instagram', 'facebook', 'whatsapp', 'manual', undefined]) assert.deepEqual(extrasFor(p), all);
  assert.deepEqual(extrasFor('newsletter'), []);
});

test('publishBlocker — סטורי בפייסבוק לא יוצא אוטומטית (ולא כפוסט רגיל בטעות)', async () => {
  const { publishBlocker } = await import('../src/publish/runner.js');
  const p = {
    post: { platform: 'facebook', channel_name: 'פייסבוק', access_token_enc: 'x', page_id: '9', content_id: 1 },
    variant: { status: 'ready', body: 'טקסט', meta: { format: 'story' } }, assets: [],
  };
  assert.match(publishBlocker(p), /סטורי בפייסבוק לא מתפרסם אוטומטית/);
  p.variant.meta = {};
  assert.equal(publishBlocker(p), null);
});

test('pickExtras / mergeExtras — ריק לא נשמר, שדות של אחרים לא נמחקים', () => {
  assert.deepEqual(pickExtras({ format: '', first_comment: '  ', link: 'https://a.co', subject: 'x' }),
    { link: 'https://a.co' });
  assert.equal(extrasKey({ format: null }), extrasKey(undefined));
  assert.equal(extrasKey({ cover_offset_sec: 0 }), extrasKey({}));
  assert.deepEqual(mergeExtras({ subject: 'נושא', first_comment: 'ישן' }, { alt_text: 'חדש', first_comment: null }),
    { subject: 'נושא', alt_text: 'חדש' });
});

test('captionCounts / badFeedRatio / extraSummary', () => {
  const c = captionCounts('שלום #א #ב @מישהו');
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => !x.over));
  assert.ok(captionCounts('א'.repeat(2201))[0].over);
  assert.equal(badFeedRatio(1080, 1350), false);   // 4:5
  assert.equal(badFeedRatio(1080, 1920), true);    // 9:16 — לא בפיד
  assert.equal(badFeedRatio(1910, 1000), false);
  assert.equal(extraSummary('cover', { cover_asset_id: 2 }, [vid(1), img(2, 'שער.jpg')]).text, 'שער.jpg');
  assert.equal(extraSummary('cover', { cover_offset_sec: 3 }, [vid(1)]).text, 'פריים משנייה 3');
  assert.equal(extraSummary('cover', {}, [img(2)]).text, 'רק לפוסט עם סרטון');
  assert.equal(captionCounts('שלום')[0].text, '4 מתוך 2,200 תווים');
  assert.equal(extraSummary('link', { link: 'https://fincat.co.il/a' }).text, 'fincat.co.il');
  assert.deepEqual(extraSummary('first_comment', {}), { text: 'לא בשימוש', set: false });
});
