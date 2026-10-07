import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapDaysError, shareError, tightensCampaignRules } from '../src/routes/campaigns.js';

/* ========================= מרווח לקמפיין — אימות הקלט ========================= */

test('gapDaysError — לא נשלח: אין שגיאה ולא נוגעים בגוף', () => {
  const b = { name: 'x' };
  assert.equal(gapDaysError(b), null);
  assert.equal('min_gap_days' in b, false);
});

test('gapDaysError — null או ריק = ברירת המחדל הכללית (null)', () => {
  for (const v of [null, '']) {
    const b = { min_gap_days: v };
    assert.equal(gapDaysError(b), null);
    assert.equal(b.min_gap_days, null);
  }
});

test('gapDaysError — מספר שלם 1..30 עובר, ומחרוזת מהטופס הופכת למספר', () => {
  for (const [v, n] of [[1, 1], ['7', 7], [30, 30]]) {
    const b = { min_gap_days: v };
    assert.equal(gapDaysError(b), null);
    assert.equal(b.min_gap_days, n);
  }
});

test('gapDaysError — 0, 31, שבר וטקסט נדחים בעברית', () => {
  for (const v of [0, 31, 2.5, 'abc', -3]) {
    assert.match(gapDaysError({ min_gap_days: v }), /בין 1 ל-30/);
  }
});

/* ========================= נתח קבוע — אימות בשרת ========================= */

test('shareError — null/ריק = אוטומטי; 1..100 עובר ומנורמל למספר', () => {
  for (const [v, n] of [[null, null], ['', null], [1, 1], ['40', 40], [100, 100]]) {
    const b = { share_pct: v };
    assert.equal(shareError(b), null);
    assert.equal(b.share_pct, n);
  }
  assert.equal(shareError({}), null);
});

test('shareError — 0, 101, שבר וטקסט נדחים בעברית', () => {
  for (const v of [0, 101, 12.5, 'x', -5]) {
    assert.match(shareError({ share_pct: v }), /בין 1 ל-100/);
  }
});

/* ========================= העוזר — אותו אימות כמו הנתיב ========================= */

test('העוזר: min_gap_days בסכימה 1–30 או null, ונבדק בהצעה עם אותה הודעה כמו בנתיב', async () => {
  const { _internals } = await import('../src/assistant.js');
  for (const name of ['create_campaign', 'update_campaign']) {
    const tool = _internals.WRITE_TOOLS[name];
    assert.deepEqual(
      (({ type, minimum, maximum }) => ({ type, minimum, maximum }))(tool.input_schema.properties.min_gap_days),
      { type: ['integer', 'null'], minimum: 1, maximum: 30 });
    // הבדיקה נכשלת לפני כל גישה למסד
    for (const v of [0, 31, 2.5]) {
      const r = await tool.check({ endpoint_id: 1, campaign_id: 1, min_gap_days: v });
      assert.equal(r.error, gapDaysError({ min_gap_days: v }));
      assert.match(r.error, /בין 1 ל-30/);
    }
  }
});

test('tightensCampaignRules — רק הכללים שהתהדקו: חלון (סיום מוקדם / התחלה חדשה), מרווח', () => {
  const before = { starts_on: '2030-11-01', ends_on: '2030-11-30', min_gap_days: null };
  const settings = { min_gap_days: 7 };
  const t = (b) => tightensCampaignRules(before, b, settings);
  const W = { window: true };
  const G = { gap: true };
  assert.equal(t({ name: 'אחר', goal: 'x' }), null);
  assert.equal(t({ starts_on: '2030-11-01', ends_on: '2030-11-30' }), null);
  assert.equal(t({ ends_on: '2030-12-15' }), null, 'הארכה');
  assert.deepEqual(t({ ends_on: '2030-11-20' }), W, 'קיצור');
  assert.equal(t({ ends_on: null }), null, 'בלי סוף — רחב יותר');
  assert.deepEqual(tightensCampaignRules({ ...before, ends_on: null }, { ends_on: '2030-11-20' }, settings),
    W, 'סוף חדש לקמפיין פתוח');
  assert.deepEqual(tightensCampaignRules({ ...before, starts_on: null }, { starts_on: '2030-11-05' }, settings),
    W, 'התחלה חדשה לקמפיין בלי התחלה');
  assert.equal(t({ min_gap_days: 7 }), null, 'אותו מרווח בפועל (הכללי)');
  assert.deepEqual(t({ min_gap_days: 10 }), G);
  assert.equal(t({ min_gap_days: 3 }), null);
  assert.deepEqual(tightensCampaignRules({ ...before, min_gap_days: 3 }, { min_gap_days: null }, settings),
    G, 'ריק ← הכללי הגדול יותר');
  assert.deepEqual(t({ ends_on: '2030-11-20', min_gap_days: 10 }), { window: true, gap: true });
});
