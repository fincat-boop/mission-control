import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetOwnerId, itemAssetsSql, linkError } from '../src/links.js';

/**
 * כללי הקישור בין משבצות (src/links.js, linkError) — בלי DB. הבדיקות מול
 * מסד אמיתי (סנכרון, ניתוק, מחיקה, שכפול, פרסום) ב-links-db.test.js.
 */

const IG = { id: 1, name: 'אינסטגרם ריל', platform: 'instagram', in_campaign: true };
const YT = { id: 2, name: 'יוטיוב שורטס', platform: 'manual', in_campaign: true };
const NL = { id: 3, name: 'ניוזלטר', platform: 'newsletter', in_campaign: true };

const ctx = (over = {}) => ({
  campaign: { structure: 'general' },
  root: { id: 10, slot_channel_id: IG.id, campaign_id: 5 },
  rootChannel: IG,
  target: { channel_id: YT.id, sort_order: 2, campaign_id: 5 },
  targetChannel: YT,
  targetItem: null,
  sibling: null,
  replace: false,
  ...over,
});

test('linkError — משבצת ריקה במדיה אחרת באותו קמפיין: מותר', () => {
  assert.equal(linkError(ctx()), null);
});

test('linkError — רק בקמפיין כללי', () => {
  const r = linkError(ctx({ campaign: { structure: 'angles' } }));
  assert.equal(r.status, 400);
  assert.match(r.error, /קמפיין כללי/);
  // זווית (בלי משבצת) גם בקמפיין כללי לא מתקשרת
  assert.equal(linkError(ctx({ root: { id: 10, slot_channel_id: null, campaign_id: 5 } })).status, 400);
});

test('linkError — רק באותו קמפיין', () => {
  const r = linkError(ctx({ target: { channel_id: YT.id, sort_order: 2, campaign_id: 6 } }));
  assert.equal(r.status, 400);
  assert.match(r.error, /אותו קמפיין/);
});

test('linkError — מספר משבצת לא תקין', () => {
  for (const n of [0, -1, 1.5, 1001, NaN]) {
    assert.equal(linkError(ctx({ target: { channel_id: YT.id, sort_order: n, campaign_id: 5 } })).status,
      400, String(n));
  }
});

test('linkError — המדיה של היעד חייבת להיות בקמפיין', () => {
  assert.equal(linkError(ctx({ targetChannel: { ...YT, in_campaign: false } })).status, 400);
  assert.equal(linkError(ctx({ targetChannel: null })).status, 400);
});

test('linkError — אותה מדיה נחסמת: שם כל משבצת היא פוסט נפרד', () => {
  const r = linkError(ctx({ target: { channel_id: IG.id, sort_order: 4, campaign_id: 5 }, targetChannel: IG }));
  assert.equal(r.status, 400);
  assert.match(r.error, /מדיה אחרת/);
});

test('linkError — ניוזלטר לא מתקשר, לא כמקור ולא כיעד', () => {
  assert.match(linkError(ctx({ targetChannel: NL, target: { channel_id: NL.id, sort_order: 1, campaign_id: 5 } })).error,
    /ניוזלטר/);
  assert.match(linkError(ctx({ rootChannel: NL, root: { id: 10, slot_channel_id: NL.id, campaign_id: 5 } })).error,
    /ניוזלטר/);
});

test('linkError — יעד שכבר מקושר / מקור של אחרים / אותה משבצת', () => {
  assert.equal(linkError(ctx({ targetItem: { id: 10, linked_to_id: null, followers: 1 } })).status, 400);
  const already = linkError(ctx({ targetItem: { id: 11, linked_to_id: 10, followers: 0 } }));
  assert.equal(already.status, 409);
  assert.match(already.error, /כבר מקושרות/);
  // בלי שרשרת: יעד שעוקב אחרי מקור אחר, או שיש לו עוקבות משלו
  assert.match(linkError(ctx({ targetItem: { id: 11, linked_to_id: 99, followers: 0 } })).error, /מנתקים אותה/);
  assert.match(linkError(ctx({ targetItem: { id: 11, linked_to_id: null, followers: 2 } })).error, /מנתקים אותן/);
});

test('linkError — עוקבת אחת לכל מדיה למקור', () => {
  const r = linkError(ctx({ sibling: { sort_order: 4 } }));
  assert.equal(r.status, 409);
  assert.match(r.error, /יוטיוב שורטס \(פוסט 4\)/);
});

test('linkError — יעד עם תוכן: 409 עם needs_confirm, ואחרי אישור מותר', () => {
  const full = { id: 11, linked_to_id: null, followers: 0 };
  const r = linkError(ctx({ targetItem: full }));
  assert.equal(r.status, 409);
  assert.equal(r.needs_confirm, true);
  assert.equal(r.error, 'התוכן הקיים במשבצת יוחלף');
  assert.equal(linkError(ctx({ targetItem: full, replace: true })), null);
});

test('assetOwnerId — עוקבת מציגה את הקבצים של המקור', () => {
  assert.equal(assetOwnerId({ id: 7, linked_to_id: 3 }), 3);
  assert.equal(assetOwnerId({ id: 7, linked_to_id: null }), 7);
  assert.equal(assetOwnerId({ id: 7 }), 7);
});

test('itemAssetsSql — הקבצים נקראים דרך הקישור (coalesce) והעמודות שנבחרו', () => {
  const sql = itemAssetsSql('a.id, a.mime');
  assert.match(sql, /select a\.id, a\.mime/);
  assert.match(sql, /a\.content_id = coalesce\(ci\.linked_to_id, ci\.id\)/);
  assert.match(sql, /ci\.linked_to_id is not null/);
});
