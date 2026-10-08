import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALL_MINUTES, armTickHeartbeat, tickFinished, tickHeartbeat, tickStallAlert, tickStarted,
} from '../src/publish/heartbeat.js';

/**
 * דופק טיק הפרסום (publish/heartbeat.js): התראה חוסמת כשהשרת רץ יותר מ-10
 * דקות והטיק האחרון שהסתיים ישן מזה — או שטיק רץ כבר יותר מ-10 דקות.
 */

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 8, 7, 0); // 10:00 בשעון ישראל

test('לפני שהשרת רשם את הטיק (טסטים, CLI) — אין התראה', () => {
  assert.equal(tickStallAlert({ armedAt: null, startedAt: null, finishedAt: null }, T0 + 60 * MIN), null);
});

test('השרת עלה לפני פחות מ-10 דקות — אין התראה גם בלי טיק שהסתיים', () => {
  assert.equal(tickStallAlert({ armedAt: T0, startedAt: null, finishedAt: null }, T0 + STALL_MINUTES * MIN), null);
});

test('טיקים מסתיימים כל דקה — אין התראה', () => {
  const now = T0 + 120 * MIN;
  assert.equal(tickStallAlert({ armedAt: T0, startedAt: now - MIN, finishedAt: now - MIN + 5000 }, now), null);
  // טיק שרץ עכשיו, והקודם הסתיים לפני 9 דקות — עוד בסדר
  assert.equal(tickStallAlert({ armedAt: T0, startedAt: now - 8 * MIN, finishedAt: now - 9 * MIN }, now), null);
});

test('הטיק האחרון הסתיים לפני יותר מ-10 דקות — crit, עם מספר הדקות', () => {
  const now = T0 + 60 * MIN;
  const a = tickStallAlert({ armedAt: T0, startedAt: T0 + 30 * MIN, finishedAt: T0 + 30 * MIN + 1000 }, now);
  assert.equal(a.id, 'publish-tick-stalled');
  assert.equal(a.level, 'crit');
  assert.equal(a.title, 'הפרסום האוטומטי לא רץ כבר 29 דקות');
  assert.match(a.detail, /הטיק האחרון הסתיים ב-10:30/);
  assert.match(a.detail, /פוסטים מאושרים לא יוצאים/);
  assert.match(a.detail, /מעבירים למפתח/);
  assert.equal(a.perm, undefined, 'כמו "פרסום נכשל" — לכל משתמש');
});

test('טיק שרץ יותר מ-10 דקות (נתקע) — crit, "עדיין לא הסתיים"', () => {
  const now = T0 + 60 * MIN;
  const a = tickStallAlert({ armedAt: T0, startedAt: T0 + 45 * MIN, finishedAt: T0 + 44 * MIN }, now);
  assert.equal(a.level, 'crit');
  assert.equal(a.title, 'הפרסום האוטומטי לא רץ כבר 16 דקות');
  assert.match(a.detail, /טיק שהתחיל ב-10:45 עדיין לא הסתיים/);
});

test('אף טיק לא הסתיים מאז העלייה, לפני יותר מ-10 דקות — crit', () => {
  const a = tickStallAlert({ armedAt: T0, startedAt: null, finishedAt: null }, T0 + 11 * MIN);
  assert.equal(a.title, 'הפרסום האוטומטי לא רץ כבר 11 דקות');
  assert.match(a.detail, /אף טיק לא הסתיים/);
  // הטיק הראשון התחיל ונתקע
  const b = tickStallAlert({ armedAt: T0, startedAt: T0 + MIN, finishedAt: null }, T0 + 15 * MIN);
  assert.match(b.detail, /עדיין לא הסתיים/);
});

test('armTickHeartbeat / tickStarted / tickFinished — המצב שההתראה קוראת', () => {
  armTickHeartbeat(T0);
  assert.deepEqual(tickHeartbeat(), { armedAt: T0, startedAt: null, finishedAt: null });
  tickStarted(T0 + MIN);
  tickFinished(T0 + MIN + 500);
  assert.deepEqual(tickHeartbeat(), { armedAt: T0, startedAt: T0 + MIN, finishedAt: T0 + MIN + 500 });
  assert.equal(tickStallAlert(tickHeartbeat(), T0 + 5 * MIN), null);
  assert.ok(tickStallAlert(tickHeartbeat(), T0 + 12 * MIN));
});
