import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { softWarning } from '../src/gap.js';

test('softWarning — אין אזהרות → null', () => {
  assert.equal(softWarning(null, undefined), null);
});

test('softWarning — אזהרה אחת עוברת כמו שהיא (תאימות לממשק הקיים)', () => {
  const gap = { days: 2, min: 7, message: 'צמוד מדי' };
  const w = softWarning(gap, null);
  assert.equal(w.message, 'צמוד מדי');
  assert.equal(w.days, 2);
});

test('softWarning — מרווח + חלון קמפיין: הודעה אחת, אישור אחד', () => {
  const w = softWarning({ message: 'צמוד מדי' }, { message: 'מחוץ לחלון' });
  assert.equal(w.message, 'צמוד מדי\n\nמחוץ לחלון');
  assert.equal(w.all.length, 2);
});
