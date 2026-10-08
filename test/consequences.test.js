import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingConsequences } from '../src/consequences.js';
import {
  averageSharesByChannel, blendShares, channelBudget, channelEndpoints, effectiveGap, gapOn,
  ratioPromoLimit, weeklyPromoCap,
} from '../src/capacity.js';
import { effectiveCadenceDays } from '../src/board.js';

/**
 * סעיף 35 (docs/behavior-improvements.md): שורת ההשלכה מחושבת מ-capacity.js —
 * אותם מספרים, גם עם ערכים שעוד לא נשמרו.
 */

const week = { from: '2026-10-04', to: '2026-10-10' };
const fb = { id: 1, name: 'פייסבוק', active: true, max_per_week: 5, urgent_reserve_pct: 20 };
const ig = { id: 2, name: 'אינסטגרם', active: true, max_per_week: 3, urgent_reserve_pct: null };
const off = { id: 3, name: 'ישן', active: false, max_per_week: 7, urgent_reserve_pct: 0 };
const camp = (id, endpoint, importance, channels, extra = {}) => ({
  id, endpoint_id: endpoint, endpoint_importance: importance, active: true, paused_at: null,
  endpoint_active: true, starts_on: '2026-09-01', ends_on: '2026-12-31', share_pct: null,
  min_gap_days: null, channel_ids: channels, ...extra,
});
const base = () => ({
  campaigns: [camp(10, 1, 7, [1, 2]), camp(11, 2, 3, [1]), camp(12, 2, 3, [1], { paused_at: '2026-10-01' })],
  channels: [fb, ig, off],
  endpoints: [{ id: 1, name: 'א', importance: 7 }, { id: 2, name: 'ב', importance: 3 },
              { id: 3, name: 'ג', importance: 5 }],
  standalone: new Map([[2, new Set([3])]]),
  settings: { min_gap_days: 7, min_value_per_promo: 3 },
  week,
});

test('סעיף 35 — ערוץ: התקציב, השמורה, המרווח והיחס = capacity.js', () => {
  const b = base();
  const c = settingConsequences(b);
  const ctx = { channels: new Map(b.channels.map((ch) => [ch.id, ch])),
                endpoints: channelEndpoints(b.campaigns, b.standalone, week) };
  for (const ch of b.channels) {
    const row = c.channels.find((x) => x.id === ch.id);
    assert.equal(row.budget, channelBudget(ch));
    assert.equal(row.gap_days, effectiveGap(null, b.settings, gapOn(ctx, ch.id)));
    assert.equal(row.promo_28, ratioPromoLimit(channelBudget(ch), 28, 4, 3));
    assert.equal(row.promo_week, weeklyPromoCap(channelBudget(ch), 3));
  }
  // פייסבוק 5 בשבוע, 20% → שמורה 1, תקציב 4; שתי נקודות → floor(14/4) = 3
  assert.deepEqual(
    (({ budget, reserve, gap_days }) => ({ budget, reserve, gap_days }))(c.channels[0]),
    { budget: 4, reserve: 1, gap_days: 3 });
});

test('סעיף 35 — נקודה: הנתח בערוצים שלה השבוע (כמו היעד של המנוע) והקצב 60/חשיבות', () => {
  const b = base();
  const c = settingConsequences(b);
  const shares = averageSharesByChannel(b.campaigns, { ...week, channelIds: [1, 2, 3] });
  const per = new Map([[1, shares.get(1).get(10)], [2, shares.get(2).get(10)]]);
  const a = c.endpoints.find((e) => e.id === 1);
  assert.equal(a.share_pct, Math.round(blendShares(per, [fb, ig]) * 100));
  assert.equal(a.cadence_days, effectiveCadenceDays({ importance: 7 }));
  assert.deepEqual(a.channels, ['פייסבוק', 'אינסטגרם']);
  // פייסבוק: 7 מול 3 (המושהה לא נספר) = 70%; אינסטגרם: לבד = 100%; משוקלל 4:2
  assert.equal(a.share_pct, Math.round(((0.7 * 4 + 1 * 2) / 6) * 100));
  // בלי קמפיין שרץ — null
  assert.equal(c.endpoints.find((e) => e.id === 3).share_pct, null);
});

test('סעיף 35 — טיוטה לפני שמירה: חשיבות, פוסטים בשבוע, מרווח ויחס', () => {
  const b = base();
  const c = settingConsequences(b, {
    endpoints: { 1: 3 },
    channels: { 1: { max_per_week: 10, urgent_reserve_pct: null } },
    settings: { min_gap_days: 2, min_value_per_promo: 0 },
  });
  const a = c.endpoints.find((e) => e.id === 1);
  assert.equal(a.importance, 3);
  assert.equal(a.cadence_days, 20);
  // פייסבוק 3 מול 3 = 50%; תקציב פייסבוק 10 − 2 = 8 מול 2 באינסטגרם
  assert.equal(a.share_pct, Math.round(((0.5 * 8 + 1 * 2) / 10) * 100));
  const row = c.channels.find((x) => x.id === 1);
  assert.equal(row.budget, 8);
  assert.equal(row.reserve, 2);
  assert.equal(row.gap_days, 1, 'min(2, floor(14/8))');
  assert.equal(c.ratio_on, false);
  assert.equal(row.promo_28, null);
  // ערך ריק / לא מספר — נשאר מה שבמסד
  const same = settingConsequences(b, { endpoints: { 1: '' }, channels: { 1: { max_per_week: 'x' } } });
  assert.equal(same.endpoints.find((e) => e.id === 1).importance, 7);
  assert.equal(same.channels.find((x) => x.id === 1).budget, 4);
});
