import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * מרכז ההתראות מול Postgres אמיתי (שלב 4): "תוכן שלא ייכנס" מחושב מהמסד
 * (unplaced), קמפיין שהסתיים עם תוכן מוכן שלא יצא, ו"חסר תוכן" על פוסטים
 * שהמנוע פתח (scheduled + auto_hole) — כולל משימת "לכתוב" שמכסה אותה.
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, alerts, org, ids;
const inOrg = (fn) => db.withOrg(org, fn);

/** YYYY-MM-DD מקומי, היום + n ימים */
const dayPlus = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
};
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  alerts = await import('../src/alerts.js');
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('alerts-db-test') returning id")).rows[0].id;

  ids = await inOrg(async () => {
    await db.query('insert into engine_settings (min_gap_days) values (7)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id")).id;
    const ep2 = (await db.one("insert into endpoints (name, importance) values ('ייעוץ', 5) returning id")).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ('פייסבוק', 'facebook', 5, 20) returning id`)).id;

    // קמפיין שרץ: שבועיים, מרווח 7 → מקום ל-2; 4 משבצות מוכנות → 2 לא ייכנסו.
    // המרווח על הקמפיין עצמו: ברירת המחדל נגזרת מהערוץ (סעיף 5 — כאן 1)
    const campaign = async (name, from, to, items) => {
      const c = (await db.one(
        `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, min_gap_days)
         values ($1, $2, $3, $4, 'general', 7) returning id`, [ep, name, from, to])).id;
      await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1, $2)', [c, ch]);
      for (let i = 1; i <= items; i += 1) {
        const it = (await db.one(
          `insert into content_items (endpoint_id, kind, title, campaign_id, sort_order, slot_channel_id)
           values ($1, 'value', $2, $3, $4, $5) returning id`, [ep, `${name} ${i}`, c, i, ch])).id;
        await db.query(
          "insert into content_variants (content_id, channel_id, status, body) values ($1, $2, 'ready', 'x')",
          [it, ch]);
      }
      return c;
    };
    const running = await campaign('רץ', dayPlus(0), dayPlus(13), 4);
    const ended = await campaign('נגמר', dayPlus(-30), dayPlus(-3), 1);
    const old = await campaign('ישן', dayPlus(-60), dayPlus(-20), 1);

    // פוסטים בלי תוכן (נקודה אחרת, כדי לא לגעת בקמפיינים)
    const post = async (at, autoHole) => (await db.one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status, auto_hole)
       values ($1, $2, 'חסר תוכן', 'value', $3, 'scheduled', $4) returning id`,
      [ch, ep2, at, autoHole])).id;
    const holeSoon = await post(hoursFromNow(24 * 3), true);
    const holeFar = await post(hoursFromNow(24 * 10), true);
    const holePast = await post(hoursFromNow(-24), true);
    const manualSoon = await post(hoursFromNow(20), false);
    const manualLater = await post(hoursFromNow(24 * 4), false);
    const holeTasked = await post(hoursFromNow(24 * 5), true);
    // עבר המועד ויש משימת "לכתוב" פתוחה — "חסר תוכן" מוסתר, "עבר המועד" נשאר
    const holePastTasked = await post(hoursFromNow(-30), true);
    for (const id of [holeTasked, holePastTasked]) {
      await db.query(
        `insert into tasks (title, kind, post_id, endpoint_id) values ('לכתוב', 'write', $1, $2)`,
        [id, ep2]);
    }
    return { running, ended, old, holeSoon, holeFar, holePast, manualSoon, manualLater, holeTasked,
             holePastTasked };
  });
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

test('תוכן שלא ייכנס — מחושב מהמסד, warn, ונוסף כסיבה בתג', { skip }, async () => {
  const { campaignsWithHealth } = await import('../src/campaigns.js');
  const list = await inOrg(() => campaignsWithHealth());
  const c = list.find((x) => x.id === ids.running);
  assert.equal(c.unplaced, 2);
  assert.equal(c.waiting, 2);
  assert.match(c.status.reason, /2 פוסטים לא ייכנסו עד סוף הקמפיין/);

  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  const a = shown.find((x) => x.id === `campaign-unplaced-${ids.running}`);
  assert.ok(a, 'אין התראת "תוכן שלא ייכנס"');
  assert.equal(a.level, 'warn');
  assert.equal(a.campaign_id, ids.running);
});

test('קמפיין שהסתיים — info על מוכן שלא פורסם, רק בשבועיים שאחרי הסוף', { skip }, async () => {
  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  const a = shown.find((x) => x.id === `campaign-leftover-${ids.ended}`);
  assert.ok(a);
  assert.equal(a.level, 'info');
  assert.equal(a.title, 'פוסט מוכן אחד של נגמר לא פורסם');
  assert.ok(!shown.some((x) => x.id === `campaign-leftover-${ids.old}`));
});

test('חסר תוכן — auto_hole בשבוע הקרוב / שעבר ביומיים; בקרוב לכל פוסט; משימה מכסה', { skip }, async () => {
  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  const byId = new Map(shown.map((a) => [a.id, a]));
  assert.equal(byId.get(`no-text-${ids.holeSoon}`)?.level, 'warn');
  assert.equal(byId.get(`no-text-${ids.holePast}`)?.level, 'crit');
  assert.equal(byId.get(`no-text-${ids.manualSoon}`)?.level, 'crit');
  // מעבר לשבוע / פוסט ידני מעבר ל-48 שעות / מכוסה במשימת "לכתוב" — לא
  for (const id of [ids.holeFar, ids.manualLater, ids.holeTasked]) {
    assert.ok(!byId.has(`no-text-${id}`), `no-text-${id}`);
  }
  // סימן אחד: ממלא מקום שהמועד שלו עבר — "חסר תוכן", ולא נכנס ל"לא אושר שיצא"
  // (התראה לכל פוסט "עבר המועד" כבר לא קיימת — סעיף 2)
  assert.ok(!shown.some((a) => a.id.startsWith('post-missed-')));
  assert.ok(!shown.some((a) => a.id.startsWith('hole-')));
  assert.ok(!shown.some((a) => a.id === 'unconfirmed'));
  // משימת "לכתוב" פתוחה מכסה את "חסר תוכן" — היא הסימן שלו
  assert.ok(!byId.has(`no-text-${ids.holePastTasked}`));
});
