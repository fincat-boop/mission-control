import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importanceNudge, nudgesFrom, scoreAll, PERF_BAND, PERF_MIN_RESULTS, ENGINE_WINDOW_DAYS,
} from '../src/performance.js';
import { debtScore } from '../src/engine.js';

/**
 * סעיף 33 (docs/behavior-improvements.md): הביצועים משפיעים רק על נקודת הקצה,
 * כמכפיל חסום על החשיבות — ±15%, מ-5 תוצאות מדודות, בלי מתג.
 */

test('סעיף 33 — המכפיל: פחות מ-5 תוצאות = 1.0, בלי קשר לציון', () => {
  assert.equal(PERF_MIN_RESULTS, 5);
  assert.equal(PERF_BAND, 0.15);
  assert.equal(importanceNudge(null), 1);
  assert.equal(importanceNudge({ score: 1, n: 0 }), 1);
  assert.equal(importanceNudge({ score: 2.4, n: 4 }), 1);
  assert.equal(importanceNudge({ score: 0.3, n: 4 }), 1);
});

test('סעיף 33 — המכפיל: מ-5 תוצאות, חסום ל-0.85..1.15', () => {
  assert.equal(importanceNudge({ score: 1.07, n: 5 }), 1.07);
  assert.equal(importanceNudge({ score: 1.6, n: 5 }), 1.15);
  assert.equal(importanceNudge({ score: 0.4, n: 12 }), 0.85);
  assert.equal(importanceNudge({ score: 0.9, n: 30 }), 0.9);
  assert.equal(importanceNudge({ score: Number.NaN, n: 9 }), 1);
});

/** n תוצאות לנקודה, בערוץ 1, כל אחת reach נתון (הבסיס — ממוצע הערוץ) */
const results = (spec) => {
  let id = 0;
  return spec.flatMap(({ endpoint, reaches }) => reaches.map((reach) => {
    id += 1;
    return { post_id: id, endpoint_id: endpoint, channel_id: 1, reach, engagement: null,
             clicks: null, leads: null, published_at: '2026-09-01T10:00:00', scheduled_at: null };
  }));
};

test('סעיף 33 — שתי תוצאות מצוינות לא מזיזות את הנקודה; חמש — כן, ועד 15%', () => {
  // נקודה 1: שתי תוצאות פי 3 מהממוצע; נקודה 2: שש תוצאות חלשות; נקודה 3: חמש חזקות
  const n = nudgesFrom(results([
    { endpoint: 1, reaches: [3000, 3000] },
    { endpoint: 2, reaches: [100, 100, 100, 100, 100, 100] },
    { endpoint: 3, reaches: [2000, 2000, 2000, 2000, 2000] },
  ]));
  assert.equal(n.get(1).n, 2);
  assert.equal(n.get(1).nudge, 1, 'פחות מ-5 תוצאות — ניטרלי');
  assert.equal(n.get(2).n, 6);
  assert.ok(n.get(2).nudge < 1 && n.get(2).nudge >= 0.85, `חלשה: ${n.get(2).nudge}`);
  assert.equal(n.get(3).n, 5);
  assert.ok(n.get(3).nudge > 1 && n.get(3).nudge <= 1.15, `חזקה: ${n.get(3).nudge}`);
});

test('סעיף 33 — אין תוצאות בכלל: מפה ריקה (כל נקודה 1.0)', () => {
  assert.equal(nudgesFrom([]).size, 0);
});

test('סעיף 33 — הציון בחוב: בלי רכיב 0.6 × (ביצועים − 1); הביצועים רק דרך החשיבות', () => {
  // אותה נקודה, "ביצועים" 1.5 בשדה performance — לא משנה כלום בציון
  const base = { staleness: 1.2, importance: 0.7 };
  assert.equal(debtScore({ ...base, performance: 1.5 }), debtScore(base));
  assert.equal(debtScore({ ...base, performance: 0.5 }), debtScore(base));
  // הרכיבים: 1.0·ותק + 0.8·פיגור + 0.5·חשיבות − 0.6·כבר הוצע
  assert.ok(Math.abs(debtScore(base, 0.1, 1) - (1.2 + 0.08 + 0.35 - 0.6)) < 1e-12);
  // חשיבות 7 × 1.15 מול 7 × 1: ההפרש = 0.5 × 0.105 — פחות מנקודת חשיבות אחת וחצי
  const up = debtScore({ staleness: 1, importance: (7 * 1.15) / 10 });
  const flat = debtScore({ staleness: 1, importance: 0.7 });
  assert.ok(Math.abs(up - flat - 0.0525) < 1e-12);
});

test('סעיף 33 — פוסט שסומן ידנית אחרי המועד נמדד לפי המועד (published_at = scheduled_at)', () => {
  // סימון אחרי המועד שומר published_at = scheduled_at (MARK_PUBLISHED_AT_SQL ב-routes/board.js);
  // scoreAll קורא published_at, ובלעדיו — scheduled_at. שבת 21:00 = ערב, יום 6
  const { scored } = scoreAll([
    { post_id: 1, endpoint_id: 1, channel_id: 1, reach: 10,
      published_at: '2026-09-05T21:00:00', scheduled_at: '2026-09-05T21:00:00' },
    { post_id: 2, endpoint_id: 1, channel_id: 1, reach: 10,
      published_at: null, scheduled_at: '2026-09-06T08:00:00' },
  ]);
  assert.deepEqual(scored.map((s) => [s.dow, s.bucket]), [[6, 'evening'], [0, 'morning']]);
  assert.equal(ENGINE_WINDOW_DAYS, 180);
});
