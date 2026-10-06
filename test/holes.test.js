import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsage, findHoles } from '../src/engine.js';
import { weekMeta } from '../src/board.js';

/**
 * פוסט חסר תוכן (findHoles) עובר את אותם כללים כמו שיבוץ רגיל (שלב 4,
 * ממצא 9): תקציב / יום חסום / תקרת ערך (usage.allows), לא באותו יום,
 * ומרווח מהשכן הקרוב — קודם הוא עקף את כולם.
 */

const week = weekMeta('2030-01-09');                 // 6.1–12.1.2030
const now = new Date('2030-01-05T09:00:00');         // לפני השבוע
const settings = { min_gap_days: 7, max_promo_per_day: 1, min_value_per_promo: 0 };
const ep = { id: 1, name: 'קורס', importance: 5 };
const chan = (id, x = {}) => ({ id, name: `ערוץ ${id}`, max_per_week: 5 - id, urgent_reserve_pct: 0,
                                blocked_days: [], ...x });
// הנקודה מפגרת (staleness ≥ 1) ולא קיבלה שיבוץ בריצה
const debts = { parts: () => ({ staleness: 2, daysSince: 20 }), scheduledCount: () => 0 };

const run = (channels, extra = {}) => {
  const usage = buildUsage(channels, [], settings);
  return findHoles({ endpoints: [ep], content: [], debts, channels, usage, week, existing: [], now,
                     settings, ...extra });
};

test('findHoles — בלי מגבלות: פוסט אחד בערוץ הפנוי ביותר, לא ביומיים הראשונים', () => {
  const [h] = run([chan(1), chan(2)]);
  assert.equal(h.channel_id, 1);                      // תקציב 4 מול 3
  assert.ok(week.days.findIndex((d) => d.date === h.date) >= 2);
  assert.equal(h.kind, 'value');
});

test('findHoles — מרווח מהשכן הקרוב (לשני הכיוונים): אין יום חוקי בערוץ → הערוץ הבא', () => {
  // פוסט של הנקודה באמצע השבוע בערוץ 1: כל ימי השבוע בתוך 7 ימים ממנו
  const pairDates = new Map([['1:1', ['2030-01-09']]]);
  const [h] = run([chan(1), chan(2)], { pairDates });
  assert.equal(h.channel_id, 2);
  // אחרי היצירה התאריך נכנס לרשימה, כמו שיבוץ
  assert.deepEqual(pairDates.get('1:2'), [h.date]);
  // שכן אחרי השבוע (16.1): רק ימים שרחוקים 7 ימים ממנו — עד 9.1
  const after = new Map([['1:1', ['2030-01-16']]]);
  const [h2] = run([chan(1)], { pairDates: after });
  assert.ok(h2.date <= '2030-01-09', h2.date);
});

test('findHoles — בלי ערוץ שיש בו יום חוקי: אין פוסט (ולא נופלים ליום חסום)', () => {
  const pairDates = new Map([['1:1', ['2030-01-09']]]);
  assert.deepEqual(run([chan(1)], { pairDates }), []);
  // כל הימים חסומים — קודם נפל ליום הרביעי בכל זאת
  assert.deepEqual(run([chan(1, { blocked_days: [0, 1, 2, 3, 4, 5, 6] })]), []);
  // רק ראשון ושני פתוחים — היום החוקי הראשון, לא יום חסום
  const [h] = run([chan(1, { blocked_days: [2, 3, 4, 5, 6] })]);
  assert.equal(h.date, '2030-01-06');
});

test('findHoles — תקרת ערך שבועית (usage.allows לסוג value): ערוץ שמלא בערך מדולג', () => {
  const [h] = run([chan(1, { max_value_per_week: 0 }), chan(2)]);
  assert.equal(h.channel_id, 2);
});

test('findHoles — לא באותו יום כמו פוסט אחר של הנקודה באותו ערוץ (גם במרווח 0)', () => {
  const zero = { ...settings, min_gap_days: 0 };
  const taken = new Set(week.days.filter((d) => d.date !== '2030-01-11')
    .map((d) => `1:1:${d.date}`));
  const usage = buildUsage([chan(1)], [], zero);
  const [h] = findHoles({ endpoints: [ep], content: [], debts, channels: [chan(1)], usage, week,
                          existing: [], now, settings: zero, sameDay: taken });
  assert.equal(h.date, '2030-01-11');
  assert.ok(taken.has('1:1:2030-01-11'));
});

test('findHoles — יום שעבר או שהשעה שלו עברה לא נבחר', () => {
  const late = new Date('2030-01-11T13:00:00');      // שישי אחרי 12:00
  const usage = buildUsage([chan(1)], [], settings);
  const [h] = findHoles({ endpoints: [ep], content: [], debts, channels: [chan(1)], usage, week,
                          existing: [], now: late, settings });
  assert.equal(h.date, '2030-01-12');
});
