import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waTaskAction } from '../src/publish/runner.js';

/* ========================= משימת וואטסאפ: מה עושים ========================= */

test('waTaskAction — אין משימה: יוצרים, גם כשהטקסט לא מוכן', () => {
  assert.equal(waTaskAction({ ready: true, task_id: null }), 'insert');
  assert.equal(waTaskAction({ ready: false, task_id: null }), 'insert');
});

test('waTaskAction — משימה פתוחה שמצב המוכנות שלה השתנה: מעדכנים', () => {
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: false, task_ready: false }), 'update');
  // משימה ישנה בלי הדגל — מקבלת את הכותרת המשנית הנוכחית
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: false, task_ready: null }), 'update');
});

test('waTaskAction — משימה פתוחה במצב הנכון, או משימה שנסגרה: כלום', () => {
  assert.equal(waTaskAction({ ready: false, task_id: 5, task_done: false, task_ready: false }), null);
  assert.equal(waTaskAction({ ready: true, task_id: 5, task_done: true, task_ready: false }), null);
});
