import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLE_MAX, deriveTitle, fileTitle, firstLineTitle, isDerivedTitle, slotTitle,
} from '../public/js/core/title.js';

/* סעיף 23 — כותרת אוטומטית: אותה פונקציה בטופס ובשרת */

test('השורה הראשונה שיש בה טקסט, בלי רווחים מיותרים', () => {
  assert.equal(firstLineTitle('\n\n   שלום   עולם  \nשורה שנייה'), 'שלום עולם');
  assert.equal(firstLineTitle('  \r\n כותרת\r\nעוד'), 'כותרת');
  assert.equal(firstLineTitle(''), '');
  assert.equal(firstLineTitle('   \n  '), '');
  assert.equal(firstLineTitle(null), '');
});

test('שורה ארוכה נחתכת בגבול מילה עם "…", עד 60 תווים', () => {
  const long = 'מילה '.repeat(30).trim();
  const t = firstLineTitle(long);
  assert.ok(t.endsWith('…'), t);
  assert.ok(t.length <= TITLE_MAX + 1, `${t.length}`);
  assert.ok(!t.slice(0, -1).endsWith(' '));
  // החיתוך בגבול מילה — לא באמצע "מילה"
  assert.ok(t.slice(0, -1).split(' ').every((w) => w === 'מילה'), t);
  // בדיוק 60 — לא נחתך
  const exact = 'א'.repeat(TITLE_MAX);
  assert.equal(firstLineTitle(exact), exact);
  // מילה אחת ארוכה (קישור) — נחתכת באמצע
  const url = `https://example.com/${'x'.repeat(100)}`;
  assert.equal(firstLineTitle(url), `${url.slice(0, TITLE_MAX)}…`);
});

test('בלי טקסט — שם הקובץ בלי סיומת; בלי שם — "<ערוץ> · פוסט N"', () => {
  assert.equal(fileTitle('השקה_חדשה-סופי.final.jpg'), 'השקה חדשה סופי.final');
  assert.equal(deriveTitle({ body: '', files: ['באנר_קיץ.png', 'b.mp4'] }), 'באנר קיץ');
  assert.equal(deriveTitle({ body: 'הטקסט קודם', files: ['x.png'] }), 'הטקסט קודם');
  assert.equal(deriveTitle({ files: ['.png'], channelName: 'אינסטגרם', index: 4 }), 'אינסטגרם · פוסט 4');
  assert.equal(slotTitle('פייסבוק', 2), 'פייסבוק · פוסט 2');
});

test('בלי טקסט ובלי קבצים — אין כותרת (פוסט ריק לא נוצר)', () => {
  assert.equal(deriveTitle({ body: '  ', files: [], channelName: 'פייסבוק', index: 1 }), '');
  assert.equal(deriveTitle(), '');
});

test('כותרת שמורה שהיא בדיוק הנגזרת — "אוטומטית"; כותרת שהוקלדה — לא', () => {
  const src = { body: 'פתיחה\nהמשך', files: [] };
  assert.equal(isDerivedTitle('פתיחה', src), true);
  assert.equal(isDerivedTitle('כותרת שלי', src), false);
  assert.equal(isDerivedTitle('', src), false);
  assert.equal(isDerivedTitle('באנר', { body: '', files: ['באנר.png'] }), true);
});
