import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../public/js/core/autosave.js';

/* סעיף 24 — מנגנון השמירה האוטומטית המשותף לחלון המשבצת ולעורך הגרסאות */

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('הקלדה רצופה — שמירה אחת אחרי ההפסקה', async () => {
  let saves = 0;
  const auto = createAutosave(async (ctl) => { saves += 1; ctl.unsaved = false; });
  auto.schedule(20);
  auto.schedule(20);
  auto.schedule(20);
  assert.equal(auto.unsaved, true);
  assert.equal(auto.busy, true);
  await tick(40);
  await auto.idle();
  assert.equal(saves, 1);
  assert.equal(auto.unsaved, false);
  assert.equal(auto.busy, false);
});

test('שינוי באמצע שמירה — נשמר מיד אחריה, בלי שתי שמירות במקביל', async () => {
  let running = 0;
  let max = 0;
  let saves = 0;
  const auto = createAutosave(async (ctl) => {
    running += 1;
    max = Math.max(max, running);
    saves += 1;
    await tick(15);
    running -= 1;
    ctl.unsaved = false;
  });
  const first = auto.saveNow();
  await tick(2);
  const second = auto.saveNow();     // באמצע — לא שמירה שנייה במקביל
  assert.equal(first, second);
  await first;
  assert.equal(saves, 2);
  assert.equal(max, 1);
});

test('saveOnce מבקש סבב נוסף (ctl.again) — למשל "מוכן" שנדחה ונשמר שוב כטיוטה', async () => {
  const calls = [];
  const auto = createAutosave(async (ctl) => {
    calls.push(calls.length);
    if (calls.length === 1) ctl.again();
    ctl.unsaved = false;
  });
  await auto.saveNow();
  assert.deepEqual(calls, [0, 1]);
});

test('שגיאה שלא נתפסה — לא נשמר, ההודעה עוברת ל-onError', async () => {
  const errors = [];
  const auto = createAutosave(async () => { throw new Error('נפל'); },
    { onError: (e) => errors.push(e.message) });
  await auto.saveNow();
  assert.equal(auto.unsaved, true);
  assert.deepEqual(errors, ['נפל']);
  assert.equal(auto.busy, false);
});

test('flush לפני סגירה: שומר רק כשיש מה; cancel מבטל שמירה מתוזמנת', async () => {
  let saves = 0;
  const auto = createAutosave(async (ctl) => { saves += 1; ctl.unsaved = false; });
  await auto.flush();
  assert.equal(saves, 0, 'אין שינוי — אין שמירה');
  auto.schedule(1000);
  await auto.flush();                // לא מחכים לתזמון
  assert.equal(saves, 1);
  auto.schedule(10);
  auto.cancel();
  await tick(25);
  assert.equal(saves, 1);
});
