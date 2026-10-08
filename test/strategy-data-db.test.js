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
