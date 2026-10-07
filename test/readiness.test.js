import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentBlocker, contentState, isEmptyContent, readyRejection } from '../src/publish/readiness.js';
import { publishBlocker } from '../src/publish/runner.js';
import { readyWarn } from '../src/campaigns.js';

/* ========================= כללי התוכן של "מוכן" ========================= */

test('contentBlocker — אינסטגרם בלי מדיה נחסם, עם תמונה או וידאו עובר', () => {
  const v = { body: 'טקסט' };
  assert.match(contentBlocker({ platform: 'instagram', variant: v }), /תמונה או וידאו/);
  // מסמך PDF הוא לא מדיה לאינסטגרם
  assert.match(contentBlocker({ platform: 'instagram', variant: v,
    assets: [{ mime: 'application/pdf' }] }), /תמונה או וידאו/);
  assert.equal(contentBlocker({ platform: 'instagram', variant: v,
    assets: [{ mime: 'video/mp4' }] }), null);
});

test('contentBlocker — פייסבוק/וואטסאפ/ידני: צריך טקסט או מדיה', () => {
  for (const platform of ['facebook', 'whatsapp', 'manual']) {
    assert.match(contentBlocker({ platform, variant: { body: '   ' } }), /אין טקסט ואין מדיה/);
    assert.equal(contentBlocker({ platform, variant: { body: 'שלום' } }), null);
    assert.equal(contentBlocker({ platform, variant: { body: '' },
      assets: [{ mime: 'image/png' }] }), null);
  }
  // בלי גרסה בכלל — אין טקסט
  assert.match(contentBlocker({ platform: 'facebook', variant: null }), /אין טקסט/);
});

test('contentBlocker — ניוזלטר: תוכן (גוף או שדה שמולא בעורך ה-HUB) ונושא', () => {
  assert.match(contentBlocker({ platform: 'newsletter',
    variant: { body: '', meta: { subject: 'נושא' } } }), /אין תוכן למייל/);
  assert.match(contentBlocker({ platform: 'newsletter',
    variant: { body: '<p>גוף</p>', meta: {} } }), /חסר נושא/);
  assert.equal(contentBlocker({ platform: 'newsletter',
    variant: { body: '', meta: { subject: 'נושא', field_values: { 'תוכן': 'מילוי' } } } }), null);
  // כלל אחד עם ההעברה ל-HUB (newsletter.js): כל שדה שמולא בעורך ה-HUB הוא
  // תוכן — שמות השדות נקבעים בתבנית שם; ריק/רווחים לא נחשב
  assert.equal(contentBlocker({ platform: 'newsletter',
    variant: { body: '', meta: { subject: 'נושא', field_values: { 'פתיח': 'x' } } } }), null);
  assert.match(contentBlocker({ platform: 'newsletter',
    variant: { body: ' ', meta: { subject: 'נושא', field_values: { 'פתיח': '  ' } } } }),
  /אין תוכן למייל/);
});

test('readyRejection — ההודעה למשתמש כוללת את הסיבה', () => {
  assert.match(readyRejection('חסר נושא'), /אי אפשר לסמן "מוכן": חסר נושא/);
});

test('publishBlocker ו-contentBlocker מסכימים על כללי התוכן', () => {
  const post = { platform: 'instagram', channel_name: 'אינסטגרם', page_id: null,
                 ig_user_id: '1', access_token_enc: 'enc', content_id: 7 };
  const variant = { status: 'ready', body: 'טקסט' };
  assert.equal(publishBlocker({ post, variant, assets: [] }),
    contentBlocker({ platform: 'instagram', variant, assets: [] }));
});

/* ========================= "מוכן ⚠" ברשת הקמפיין ========================= */

const ig = { id: 7, platform: 'instagram' };

test('readyWarn — רק לגרסה "מוכן" שהתוכן שלה לא יעבור', () => {
  const v = { id: 1, status: 'ready', body: 'טקסט' };
  const item = { assets: [], variant_assets: [] };
  assert.match(readyWarn(item, v, ig), /תמונה או וידאו/);
  assert.equal(readyWarn(item, { ...v, status: 'draft' }, ig), null);
  assert.equal(readyWarn(null, v, ig), null);
});

test('readyWarn — זווית: קובץ של גרסה אחרת לא נחשב, משותף כן', () => {
  const v = { id: 1, status: 'ready', body: '' };
  const other = { assets: [], variant_assets: [{ variant_id: 2, mime: 'image/png' }] };
  assert.match(readyWarn(other, v, ig), /תמונה/);
  const shared = { assets: [{ mime: 'image/png' }], variant_assets: [] };
  assert.equal(readyWarn(shared, v, ig), null);
});

test('readyWarn — משבצת מקושרת רואה את הקבצים של המקור', () => {
  const v = { id: 9, status: 'ready', body: '' };
  const follower = { linked_to_id: 3, assets: [],
                     variant_assets: [{ variant_id: 4, mime: 'video/mp4' }] };
  assert.equal(readyWarn(follower, v, ig), null);
});

/* ========================= סעיפים 20–21: ריק / "מוכן ⚠" ========================= */

test('isEmptyContent — כותרת בלבד (בלי טקסט ובלי מדיה) ריק; טקסט, תמונה או קישור פייסבוק — לא', () => {
  assert.equal(isEmptyContent({ platform: 'facebook', variant: { body: ' \n\t ' } }), true);
  assert.equal(isEmptyContent({ platform: 'facebook', variant: null }), true);
  assert.equal(isEmptyContent({ platform: 'whatsapp', variant: { body: 'שלום' } }), false);
  assert.equal(isEmptyContent({ platform: 'instagram', variant: { body: '' },
    assets: [{ mime: 'image/jpeg' }] }), false);
  // מסמך הוא לא מדיה לפוסט
  assert.equal(isEmptyContent({ platform: 'facebook', variant: { body: '' },
    assets: [{ mime: 'application/pdf' }] }), true);
  assert.equal(isEmptyContent({ platform: 'facebook',
    variant: { body: '', meta: { link: 'https://x.co' } } }), false);
  // קישור יוצא רק בפייסבוק
  assert.equal(isEmptyContent({ platform: 'whatsapp',
    variant: { body: '', meta: { link: 'https://x.co' } } }), true);
  // ניוזלטר: גוף או שדה שמולא בעורך ה-HUB (אותו כלל כמו ההעברה)
  assert.equal(isEmptyContent({ platform: 'newsletter', variant: { body: '', meta: { subject: 'נ' } } }), true);
  assert.equal(isEmptyContent({ platform: 'newsletter',
    variant: { body: '', meta: { field_values: { 'תוכן': 'x' } } } }), false);
});

test('contentBlocker נשען על isEmptyContent — אותה הגדרה של "אין טקסט"', () => {
  for (const platform of ['facebook', 'whatsapp', 'manual']) {
    for (const variant of [{ body: '' }, { body: 'x' }, null]) {
      const empty = isEmptyContent({ platform, variant });
      assert.equal(/אין טקסט ואין מדיה/.test(contentBlocker({ platform, variant }) ?? ''), empty);
    }
  }
});

test('contentState — warn רק לגרסה "מוכן", וריק גובר על warn', () => {
  assert.deepEqual(contentState({ platform: 'instagram', variant: { status: 'ready', body: 'כיתוב' } }),
    { empty: false, warn: 'אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט' });
  assert.deepEqual(contentState({ platform: 'instagram', variant: { status: 'draft', body: 'כיתוב' } }),
    { empty: false, warn: null });
  assert.deepEqual(contentState({ platform: 'facebook', variant: { status: 'ready', body: '' } }),
    { empty: true, warn: null });
  // אותה תשובה כמו התא בטבלה (readyWarn) לאותה גרסה וקבצים
  const v = { id: 1, status: 'ready', body: 'x'.repeat(2300) };
  const item = { assets: [{ mime: 'image/png' }], variant_assets: [] };
  assert.equal(contentState({ platform: 'instagram', variant: v, assets: item.assets }).warn,
    readyWarn(item, v, { platform: 'instagram' }));
});
