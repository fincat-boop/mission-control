import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prunePlan } from '../src/full-backup.js';

const P = (d) => `daily/2026-10-0${d}T08-00-00/`;

test('prunePlan — שומר keep שלמים, מוחק ישנים יותר', () => {
  const prefixes = [P(1), P(2), P(3), P(4)];
  const complete = new Set(prefixes);
  assert.deepEqual(prunePlan(prefixes, complete, 2, P(4)), [P(2), P(1)]);
});

test('prunePlan — גיבוי חלקי לא נספר ב-keep ונמחק כשהוא ישן מהנוכחי', () => {
  const prefixes = [P(1), P(2), P(3), P(4)];
  const complete = new Set([P(1), P(2), P(4)]);      // P(3) נקטע באמצע
  // keep=2 מתוך השלמים: P(4), P(2) נשארים; P(1) ישן; P(3) חלקי
  assert.deepEqual(prunePlan(prefixes, complete, 2, P(4)), [P(1), P(3)]);
});

test('prunePlan — חלקי חדש מהנוכחי (הרצה מקבילה) לא נמחק', () => {
  const prefixes = [P(1), P(2)];
  const complete = new Set([P(1)]);
  assert.deepEqual(prunePlan(prefixes, complete, 7, P(1)), []);
});

test('prunePlan — monthly (לנצח): שלמים לא נמחקים, חלקיים ישנים כן', () => {
  const prefixes = [P(1), P(2), P(3)];
  const complete = new Set([P(1), P(3)]);
  assert.deepEqual(prunePlan(prefixes, complete, Infinity, P(3)), [P(2)]);
});
