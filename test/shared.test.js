import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdList, titleFromFilename } from '../src/routes/_shared.js';

test('parseIdList — מערך של מספרים', () => {
  assert.deepEqual(parseIdList([1, 2, 3]), [1, 2, 3]);
});

test('parseIdList — מסנן ערכים לא-מספריים ואפסים', () => {
  assert.deepEqual(parseIdList(['1', 'x', '0', '3']), [1, 3]);
});

test('parseIdList — מחרוזת JSON', () => {
  assert.deepEqual(parseIdList('[4,5]'), [4, 5]);
});

test('parseIdList — רשימה מופרדת בפסיקים', () => {
  assert.deepEqual(parseIdList('7, 8 ,9'), [7, 8, 9]);
});

test('parseIdList — ריק', () => {
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(null), []);
});

test('titleFromFilename — מסיר סיומת ומנקה מפרידים', () => {
  assert.equal(titleFromFilename('my_cool-post.png'), 'my cool post');
});

test('titleFromFilename — בלי סיומת נשאר כמו שהוא', () => {
  assert.equal(titleFromFilename('שלום'), 'שלום');
});
