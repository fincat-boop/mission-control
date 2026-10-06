import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { missingContentAlerts } from '../src/alerts.js';
import { suppressTaskedAlerts } from '../src/task-lifecycle.js';

/**
 * "חסר תוכן" (שלב 4, ממצא 7): ההתראה חיפשה status='hole', והמנוע כותב
 * 'scheduled' + auto_hole — היא מעולם לא עלתה. עכשיו התראה אחת לכל פוסט.
 */

const now = new Date('2030-01-10T12:00:00');
const at = (h) => new Date(now.getTime() + h * 3600000).toISOString();
const post = (id, hours, x = {}) => ({
  id, title: 'חסר תוכן', scheduled_at: at(hours), auto_hole: true,
  endpoint_name: 'קורס', channel_name: 'פייסבוק', ...x,
});

test('missingContentAlerts — עבר המועד / בקרוב: crit; עד שבוע: warn; id אחד לפוסט', () => {
  const list = [post(1, -20), post(2, 10), post(3, 24 * 5)];
  const [past, soon, later] = missingContentAlerts(list, { alertHours: 48, now });
  assert.deepEqual([past.id, soon.id, later.id], ['no-text-1', 'no-text-2', 'no-text-3']);
  assert.deepEqual([past.level, soon.level, later.level], ['crit', 'crit', 'warn']);
  assert.equal(past.title, 'חסר תוכן והמועד עבר — קורס');
  assert.match(past.detail, /כותבים תוכן ומשבצים מחדש, או מוחקים את הפוסט/);
  assert.equal(soon.title, 'חסר תוכן לפוסט שמתפרסם בקרוב');
  assert.equal(later.title, 'חסר תוכן על הלוח — קורס');
  for (const a of [past, soon, later]) {
    assert.equal(a.tab, 'board');
    assert.doesNotMatch(a.title + a.detail, /חור/);
  }
  assert.deepEqual([past, soon, later].map((a) => a.post_id), [1, 2, 3]);
});

test('missingContentAlerts — משימת "לכתוב" פתוחה על הפוסט מכסה את ההתראה (סימן אחד)', () => {
  const alerts = missingContentAlerts([post(1, 10), post(2, 24 * 4)], { now });
  const shown = suppressTaskedAlerts(alerts, [{ post_id: 2, kind: 'write' }]);
  assert.deepEqual(shown.map((a) => a.id), ['no-text-1']);
});

test('buildAlerts — שאילתה אחת: scheduled + auto_hole + בלי תוכן (לא status=hole), שבוע קדימה ויומיים אחורה', () => {
  const src = readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /p\.status = 'hole'/);
  assert.match(src, /p\.status = 'scheduled' and p\.content_id is null/);
  assert.match(src, /p\.auto_hole and p\.scheduled_at between/);
  // "עבר המועד" לא מוצג לפוסט שכבר קיבל "חסר תוכן"
  assert.match(src, /missed\.filter\(\(p\) => !noTextIds\.has\(p\.id\)\)/);
});
