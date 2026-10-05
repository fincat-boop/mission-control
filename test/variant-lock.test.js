import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleVariant } from '../src/variant-lock.js';

const row = (over = {}) => ({
  body: 'טקסט', status: 'draft', meta: null,
  updated_at: new Date('2026-10-05T10:00:00.123Z'), ...over,
});

test('staleVariant — אותו updated_at (גם כמחרוזת ISO מה-JSON) לא ישן', () => {
  assert.equal(staleVariant(row(), '2026-10-05T10:00:00.123Z'), false);
});

test('staleVariant — מישהו שמר אחרי שהטופס נפתח: ישן', () => {
  assert.equal(staleVariant(row({ updated_at: new Date('2026-10-05T10:05:00Z') }),
    '2026-10-05T10:00:00.123Z'), true);
});

test('staleVariant — לא הייתה גרסה בפתיחה ומישהו כתב אחת בינתיים: ישן', () => {
  assert.equal(staleVariant(row(), null), true);
});

test('staleVariant — גרסה ריקה שנוצרה מתליית קובץ — כמו שלא הייתה', () => {
  assert.equal(staleVariant(row({ body: '', status: 'draft', meta: null }), null), false);
});

test('staleVariant — הגרסה נמחקה מאז שהטופס נפתח: ישן; לא הייתה ואין: לא', () => {
  assert.equal(staleVariant(null, '2026-10-05T10:00:00.123Z'), true);
  assert.equal(staleVariant(null, null), false);
});
