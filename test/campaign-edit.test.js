import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftNote } from '../public/js/core/campaignEdit.js';

test('shiftNote — כמה זזו, כמה שובצו מחדש וכמה מאושרים צריכים אישור מחדש', () => {
  assert.equal(shiftNote(null), '');
  assert.equal(shiftNote({ moved: 0, rescheduled: 0, approved: 0 }), '');
  assert.equal(shiftNote({ moved: 3, rescheduled: 0, approved: 0 }), '3 פוסטים זזו עם הקמפיין.');
  assert.equal(shiftNote({ moved: 1, rescheduled: 0, approved: 0 }), 'פוסט אחד זז עם הקמפיין.');
  assert.equal(shiftNote({ moved: 4, rescheduled: 2, approved: 1 }),
    '4 פוסטים זזו עם הקמפיין, 2 פוסטים שובצו מחדש כי התאריך החדש לא התאים ' +
    '(אחד מהם היה מאושר ויצטרך אישור מחדש).');
  assert.equal(shiftNote({ moved: 0, rescheduled: 1, approved: 0 }),
    'פוסט אחד שובץ מחדש כי התאריך החדש לא התאים.');
  assert.equal(shiftNote({ moved: 0, rescheduled: 3, approved: 2 }),
    '3 פוסטים שובצו מחדש כי התאריך החדש לא התאים (2 מהם היו מאושרים ויצטרכו אישור מחדש).');
});
