import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTable } from '../src/import.js';

/* סעיף 19 — בקמפיין כללי שורה N = פוסט N, ולכן שורה ריקה באמצע נשמרת */

test('parseTable — שורות ריקות יורדות כברירת מחדל (זוויות)', () => {
  assert.deepEqual(parseTable('a\tb\n\t\n1\t2\n\n'), [['a', 'b'], ['1', '2']]);
});

test('parseTable keepEmpty — ריקה באמצע נשארת, בהתחלה ובסוף יורדות', () => {
  assert.deepEqual(parseTable('\n\na\tb\n\t\n1\t2\n\t\n\n', { keepEmpty: true }),
    [['a', 'b'], ['', ''], ['1', '2']]);
  assert.deepEqual(parseTable('  \n\t', { keepEmpty: true }), []);
});

test('parseTable — תא במרכאות עם שורה חדשה ופסיק נשאר תא אחד', () => {
  assert.deepEqual(parseTable('a,b\n"x\ny, z",2'), [['a', 'b'], ['x\ny, z', '2']]);
});
