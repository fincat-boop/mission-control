import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copySources, nextEmptySlot, rowPrefill, slotBody,
} from '../public/js/core/slotRow.js';

/* סעיף 18 — חלון המשבצת בקמפיין כללי: כותרת+סוג מהשורה, "העתק מ־", "הבא ›" */

const FB = 1;
const IG = 2;
const WA = 3;
const ORDER = [FB, IG, WA];

const item = (id, ch, n, { title = `פוסט ${n}`, kind = 'value', body = '', files = 0 } = {}) => ({
  id, slot_channel_id: ch, sort_order: n, title, kind,
  variants: [{ channel_id: ch, body }],
  assets: Array.from({ length: files }, (_, i) => ({ id: id * 10 + i })), variant_assets: [],
});

test('rowPrefill — כותרת וסוג מפוסט אחר באותה שורה, לפי סדר העמודות', () => {
  const content = [
    item(1, WA, 4, { title: 'וואטסאפ 4', kind: 'hybrid' }),
    item(2, IG, 4, { title: 'השקה', kind: 'promo' }),
    item(3, FB, 3, { title: 'אחר' }),
  ];
  // אינסטגרם לפני וואטסאפ בסדר העמודות
  assert.deepEqual(rowPrefill(content, { index: 4, channelId: FB, order: ORDER }),
    { title: 'השקה', kind: 'promo' });
  // התא עצמו לא נחשב "אחר"
  assert.deepEqual(rowPrefill(content, { index: 4, channelId: IG, order: ORDER }),
    { title: 'וואטסאפ 4', kind: 'hybrid' });
  // שורה בלי אף פוסט — אין מאיפה
  assert.equal(rowPrefill(content, { index: 5, channelId: FB, order: ORDER }), null);
  // כותרת ריקה לא נלקחת
  assert.equal(rowPrefill([item(9, IG, 6, { title: '  ' })], { index: 6, channelId: FB }), null);
});

test('copySources — קודם השורה, אחר כך השאר; רק מה שיש בו טקסט או קבצים', () => {
  const content = [
    item(1, WA, 4, { body: 'טקסט וואטסאפ' }),
    item(2, IG, 4, { body: '' }),                // ריק — לא מקור
    item(3, IG, 2, { body: '', files: 2 }),       // רק קבצים — כן
    item(4, FB, 1, { body: 'ראשון' }),
    item(5, FB, 4, { body: 'אני' }),              // התא עצמו
  ];
  const list = copySources(content, { index: 4, channelId: FB, selfId: 5, order: ORDER });
  assert.deepEqual(list.map((x) => [x.id, x.sameRow]), [[1, true], [4, false], [3, false]]);
  assert.equal(list[0].body, 'טקסט וואטסאפ');
  assert.equal(list[2].files, 2);
  // משבצת חדשה (אין selfId) — לפי המקום
  assert.ok(!copySources(content, { index: 4, channelId: FB, order: ORDER }).some((x) => x.id === 5));
});

test('slotBody — הגרסה לערוץ של המשבצת, אחרת הגוף של הפריט', () => {
  assert.equal(slotBody({ slot_channel_id: 1, variants: [{ channel_id: 1, body: 'v' }], body: 'b' }), 'v');
  assert.equal(slotBody({ slot_channel_id: 1, variants: [], body: 'b' }), 'b');
  assert.equal(slotBody(null), '');
});

test('nextEmptySlot — המשך השורה, ואז השורות הבאות מתחילתן; מעבר לצורך ריק לא נספר', () => {
  const col = (ch, cells) => ({ channel_id: ch,
    slots: cells.map(([index, filled, extra = false]) => ({ index, extra, content: filled ? {} : null })) });
  const slots = [
    col(FB, [[1, true], [2, false], [3, true]]),
    col(IG, [[1, true], [2, true], [3, false], [4, false, true]]),
    col(WA, [[1, false], [2, false], [3, false]]),
  ];
  // שורה 1, פייסבוק → וואטסאפ באותה שורה
  assert.deepEqual(nextEmptySlot(slots, { channelId: FB, index: 1 }), { channelId: WA, index: 1 });
  // שורה 1, וואטסאפ (אחרון) → שורה 2 מההתחלה: פייסבוק
  assert.deepEqual(nextEmptySlot(slots, { channelId: WA, index: 1 }), { channelId: FB, index: 2 });
  // שורה 2, פייסבוק → אינסטגרם מלא, וואטסאפ ריק
  assert.deepEqual(nextEmptySlot(slots, { channelId: FB, index: 2 }), { channelId: WA, index: 2 });
  // שורה 3, וואטסאפ → אין עוד (4 באינסטגרם מעבר לצורך וריק)
  assert.equal(nextEmptySlot(slots, { channelId: WA, index: 3 }), null);
  // עמודות קודמות באותה שורה לא חוזרות
  assert.deepEqual(nextEmptySlot(slots, { channelId: IG, index: 3 }), { channelId: WA, index: 3 });
});
