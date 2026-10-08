import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 6 של שיפורי ההתנהגות (docs/behavior-improvements.md, סעיפים 33–35) מול
 * Postgres אמיתי.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test --test-concurrency=1
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה, ולכן אפשר להריץ שוב ושוב.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, org;

const inOrg = (fn) => db.withOrg(org, fn);
const q = (sql, params) => inOrg(() => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('strategy-data-test') returning id")).rows[0].id;
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (7)'));
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

const { ymd } = await import('../src/board.js');
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

const channel = (name, maxPerWeek = 5, reserve = 20) => q1(
  `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
   values ($1, 'manual', $2, $3) returning *`, [name, maxPerWeek, reserve]);
const endpoint = (name, importance = 5) => q1(
  'insert into endpoints (name, importance) values ($1, $2) returning *', [name, importance]);

const campaign = (endpointId, channels, { name = 'קמפיין', starts, ends, share = null } = {}) =>
  inOrg(async () => {
    const c = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct)
       values ($1,$2,$3,$4,$5) returning *`, [endpointId, name, starts, ends, share]);
    for (const ch of [channels].flat()) {
      await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [c.id, ch]);
    }
    return c;
  });

/** פוסט של תוכן (בקמפיין או שוטף), במועד at */
const post = (channelId, endpointId, at, { status = 'published', campaignId = null } = {}) =>
  inOrg(async () => {
    const it = await db.one(
      `insert into content_items (endpoint_id, campaign_id, kind, title)
       values ($1,$2,'value','פריט') returning id`, [endpointId, campaignId]);
    return db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, published_at, status)
       values ($1,$2,$3,'פוסט','value',$4,case when $5 = 'published' then $4::timestamptz end,$5)
       returning *`, [channelId, endpointId, it.id, at, status]);
  });

async function wipe() {
  await inOrg(async () => {
    await db.query('delete from posts');
    await db.query('delete from content_items');
    await db.query('delete from campaigns');
    await db.query('delete from channels');
    await db.query('delete from endpoints');
    await db.query('update engine_settings set min_gap_days = 7, min_value_per_promo = 3');
  });
}

/* ========================= סעיף 33 ========================= */

test('סעיף 33 — המנוע ומסך הנתונים: אותו חלון (180 יום), גם כשהתקופה במסך 14 יום', { skip }, async () => {
  await wipe();
  const perf = await import('../src/performance.js');
  const engine = await import('../src/engine.js');
  const ch = await channel('פייסבוק');
  const a = await endpoint('חזקה', 6);
  const b = await endpoint('חלשה', 6);
  const c = await endpoint('מעט תוצאות', 6);
  // 40 יום אחורה — מחוץ ל-14 הימים של המסך, בתוך 180 של המנוע
  for (const [ep, reach, n] of [[a, 2000, 5], [b, 100, 5], [c, 1050, 2]]) {
    for (let i = 0; i < n; i += 1) {
      const p = await post(ch.id, ep.id, `${inDays(-40 - i)}T10:00:00`);
      await q('insert into post_results (post_id, reach) values ($1,$2)', [p.id, reach]);
    }
  }

  const screen = await inOrg(() => perf.buildPerformance(inDays(-13), inDays(0)));
  assert.equal(screen.measured, 0, 'בתקופה של המסך אין תוצאות');
  assert.equal(screen.engine.window_days, 180);
  const shown = new Map(screen.engine.endpoints.map((e) => [e.id, e]));
  assert.equal(shown.get(a.id).nudge, 1.15);
  assert.equal(shown.get(b.id).nudge, 0.85);
  assert.equal(shown.get(c.id).n, 2);
  assert.equal(shown.get(c.id).nudge, 1, 'שתי תוצאות — לא משפיעות');

  assert.equal(screen.use_performance, true, 'תאימות API: נגזר — יש נקודה עם מכפיל ≠ 1');

  const nudges = await inOrg(() => perf.endpointNudges());
  assert.deepEqual([...nudges].sort(), [[a.id, 1.15], [b.id, 0.85]].sort());

  // במנוע: החשיבות כפול המכפיל, ונקודה בלי 5 תוצאות — בדיוק החשיבות
  const eps = await q('select * from endpoints');
  const settings = await q1('select * from engine_settings');
  const debts = await inOrg(() => engine.computeDebts(eps, settings, nudges));
  assert.ok(Math.abs(debts.parts(a.id).importance - 0.69) < 1e-12);
  assert.ok(Math.abs(debts.parts(b.id).importance - 0.51) < 1e-12);
  assert.equal(debts.parts(c.id).importance, 0.6);
  assert.equal(debts.parts(c.id).performance, null);
});

/* ========================= סעיף 34 ========================= */

test('סעיף 34 — מסך האסטרטגיה: אותו נתח כמו טופס הקמפיין, ו"בפועל" כמו שהמנוע סופר', { skip }, async () => {
  await wipe();
  const { campaignsWithHealth, currentAllocation } = await import('../src/campaigns.js');
  const fb = await channel('פייסבוק', 5);      // תקציב 4 (שמורה 1)
  const ig = await channel('אינסטגרם', 3);     // תקציב 2 (שמורה 1)
  const a = await endpoint('א', 6);
  const b = await endpoint('ב', 4);
  const a1 = await campaign(a.id, [fb.id, ig.id], { name: 'א1', starts: inDays(-10), ends: inDays(20) });
  const b1 = await campaign(b.id, [fb.id], { name: 'ב1', starts: inDays(-10), ends: inDays(5) });
  const c1 = await campaign(b.id, [ig.id], { name: 'קבוע', starts: inDays(-10), ends: inDays(40), share: 30 });
  const paused = await campaign(a.id, [fb.id], { name: 'מושהה', starts: inDays(-10), ends: inDays(20) });
  await q('update campaigns set paused_at = now() where id = $1', [paused.id]);

  // א1: פורסם + לא סומן כפורסם (מתוכנן שעבר) בפייסבוק, פורסם באינסטגרם; ב1: שניים בפייסבוק.
  // המושהה: מתוכנן שעבר — מוחזק, לא נספר
  await post(fb.id, a.id, `${inDays(-3)}T10:00:00`, { campaignId: a1.id });
  await post(fb.id, a.id, `${inDays(-2)}T10:00:00`, { campaignId: a1.id, status: 'scheduled' });
  await post(ig.id, a.id, `${inDays(-1)}T10:00:00`, { campaignId: a1.id });
  await post(fb.id, b.id, `${inDays(-4)}T10:00:00`, { campaignId: b1.id });
  await post(fb.id, b.id, `${inDays(-5)}T10:00:00`, { campaignId: b1.id });
  await post(fb.id, a.id, `${inDays(-1)}T12:00:00`, { campaignId: paused.id, status: 'scheduled' });

  const form = new Map((await inOrg(() => campaignsWithHealth())).map((c) => [c.id, c]));
  const alloc = await inOrg(() => currentAllocation());
  const row = new Map(alloc.rows.map((r) => [r.campaign_id, r]));

  assert.ok(!row.has(paused.id), 'מושהה לא בטבלה');
  // הנתח = המספר שבטופס (share_auto לאוטומטי, share_pct לקבוע)
  assert.equal(row.get(a1.id).target_pct, form.get(a1.id).share_auto);
  assert.equal(row.get(b1.id).target_pct, form.get(b1.id).share_auto);
  assert.equal(row.get(c1.id).target_pct, 30);
  assert.equal(row.get(c1.id).auto, false);

  // בפועל: פייסבוק — א1 2 מ-4 (כולל הלא מסומן), אינסטגרם — א1 1 מ-1; משוקלל בתקציבים 4 ו-2
  assert.equal(row.get(a1.id).actual_pct, Math.round(((0.5 * 4 + 1 * 2) / 6) * 100));
  assert.equal(row.get(b1.id).actual_pct, 50);
  assert.equal(row.get(c1.id).actual_pct, 0);
  assert.equal(row.get(a1.id).live, 3);
  assert.equal(row.get(a1.id).published, 2);
  assert.equal(row.get(b1.id).published, 2);
  assert.equal(alloc.window.to >= inDays(0), true, 'החלון נגמר בסוף השבוע הנוכחי');
});

test('סעיף 34 — החלפת קמפיין: הפוסטים של קמפיין שהסתיים לא מפילים את החדש ל"מפגר"', { skip }, async () => {
  await wipe();
  const { currentAllocation } = await import('../src/campaigns.js');
  const fb = await channel('פייסבוק', 5);
  const a = await endpoint('א', 5);
  const b = await endpoint('ב', 5);
  // א הסתיים לפני השבוע הנוכחי (4 פוסטים בחלון של 28 יום); ב רץ מאז, 2 פוסטים
  const old = await campaign(a.id, [fb.id], { name: 'ישן', starts: inDays(-25), ends: inDays(-8) });
  const cur = await campaign(b.id, [fb.id], { name: 'חדש', starts: inDays(-7), ends: inDays(20) });
  for (let i = 9; i <= 12; i += 1) await post(fb.id, a.id, `${inDays(-i)}T10:00:00`, { campaignId: old.id });
  await post(fb.id, b.id, `${inDays(-3)}T10:00:00`, { campaignId: cur.id });
  await post(fb.id, b.id, `${inDays(-2)}T10:00:00`, { campaignId: cur.id });

  const alloc = await inOrg(() => currentAllocation());
  assert.deepEqual(alloc.rows.map((r) => r.campaign_id), [cur.id]);
  const r = alloc.rows[0];
  assert.equal(r.target_pct, 100);
  assert.equal(r.actual_pct, 100, 'כמו campaignLag: רק מי שמתחרה השבוע בבסיס');
  assert.equal(r.lagging, false);
});

test('סעיף 34 — נתח קבוע שמוקטן (סך הקבועים בערוץ > 100%): מה שנקבע + מה שהמנוע נותן', { skip }, async () => {
  await wipe();
  const { currentAllocation } = await import('../src/campaigns.js');
  const fb = await channel('פייסבוק', 5);
  const a = await endpoint('א', 5);
  const b = await endpoint('ב', 5);
  const c80 = await campaign(a.id, [fb.id], { name: '80', starts: inDays(-5), ends: inDays(20), share: 80 });
  const c60 = await campaign(b.id, [fb.id], { name: '60', starts: inDays(-5), ends: inDays(20), share: 60 });
  const row = new Map((await inOrg(() => currentAllocation())).rows.map((r) => [r.campaign_id, r]));
  assert.deepEqual([row.get(c80.id).fixed_pct, row.get(c80.id).target_pct, row.get(c80.id).scaled],
    [80, Math.round((80 / 140) * 100), true]);
  assert.deepEqual([row.get(c60.id).fixed_pct, row.get(c60.id).target_pct, row.get(c60.id).scaled],
    [60, Math.round((60 / 140) * 100), true]);
  // בלי הקטנה — scaled false
  await q('update campaigns set share_pct = 20 where id = $1', [c60.id]);
  const again = new Map((await inOrg(() => currentAllocation())).rows.map((r) => [r.campaign_id, r]));
  assert.equal(again.get(c80.id).scaled, false);
  assert.equal(again.get(c80.id).target_pct, 80);
});

/* ========================= סעיף 35 ========================= */

test('סעיף 35 — POST /settings/consequences: אותם מספרים כמו capacity.js והמנוע', { skip }, async () => {
  await wipe();
  const { default: express } = await import('express');
  const { default: settingsRoutes } = await import('../src/routes/settings.js');
  const cap = await import('../src/capacity.js');
  const { loadGapContext, CAMPAIGNS_WEIGHTED_SQL } = await import('../src/capacity-db.js');
  const { strategyTargets } = await import('../src/engine.js');
  const { weekMeta } = await import('../src/board.js');

  const fb = await channel('פייסבוק', 5);
  const ig = await channel('אינסטגרם', 3);
  const a = await endpoint('א', 7);
  const b = await endpoint('ב', 3);
  await campaign(a.id, [fb.id, ig.id], { name: 'א1', starts: inDays(-10), ends: inDays(30) });
  await campaign(b.id, [fb.id], { name: 'ב1', starts: inDays(-10), ends: inDays(30) });

  const app = express();
  app.use(express.json());
  const pending = new Set();
  app.use((req, res, next) => {
    req.user = { id: null, is_owner: true, perm_settings: true };
    const p = db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(settingsRoutes);
  const server = app.listen(0);
  const post35 = async (body) => {
    const res = await fetch(`http://localhost:${server.address().port}/settings/consequences`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    await Promise.all([...pending]);
    return Object.assign(json, { _status: res.status });
  };
  try {
    const week = weekMeta(new Date());
    const from = week.days[0].date;
    const to = week.days[6].date;
    const c = await post35({});

    // ערוץ: המרווח והתקציב — כמו המנוע (loadGapContext + effectiveGap)
    const ctx = await inOrg(() => loadGapContext(from, to));
    for (const ch of [fb, ig]) {
      const row = c.channels.find((x) => x.id === ch.id);
      assert.equal(row.gap_days, cap.effectiveGap(null, ctx.settings, cap.gapOn(ctx, ch.id)));
      assert.equal(row.budget, cap.channelBudget(ch));
    }
    // נקודה: היעד של המנוע לשבוע (strategyTargets) בכל ערוץ, משוקלל בתקציבים
    const campaigns = await q(CAMPAIGNS_WEIGHTED_SQL);
    const { targetPct } = strategyTargets(campaigns, week, { channelIds: [fb.id, ig.id] });
    const per = new Map([[fb.id, targetPct.get(fb.id).get(a.id) / 100],
                         [ig.id, targetPct.get(ig.id).get(a.id) / 100]]);
    assert.equal(c.endpoints.find((e) => e.id === a.id).share_pct,
      Math.round(cap.blendShares(per, [fb, ig]) * 100));

    // טיוטה: חשיבות 3 לנקודה א — 50% בפייסבוק, ולא נשמר כלום
    const d = await post35({ endpoints: { [a.id]: 3 }, settings: { min_gap_days: 1 } });
    assert.equal(d.endpoints.find((e) => e.id === a.id).share_pct,
      Math.round(((0.5 * 4 + 1 * 2) / 6) * 100));
    assert.ok(d.channels.every((ch) => ch.gap_days <= 1));
    assert.equal((await q1('select importance from endpoints where id = $1', [a.id])).importance, 7);
    assert.equal((await q1('select min_gap_days from engine_settings')).min_gap_days, 7);

    // קלט לא תקין — 400, לא 500; מחוץ לטווח — נחתך
    assert.equal((await post35({ endpoints: [] }))._status, 400);
    assert.equal((await post35({ channels: { [fb.id]: 'x' } }))._status, 400);
    assert.equal((await post35({ endpoints: { [a.id]: 'abc' } }))._status, 400);
    const big = await post35({ endpoints: { [a.id]: 99 } });
    assert.equal(big._status, 200);
    assert.equal(big.endpoints.find((e) => e.id === a.id).importance, 10);
  } finally {
    server.close();
  }
});
