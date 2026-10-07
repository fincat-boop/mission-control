import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * סריקה שנייה של מערכת השיבוץ, סבב 2 (docs/scheduling-overhaul.md) מול
 * Postgres אמיתי: קמפיין לא פעיל, פוסט שנכשל, מבצע דחוף, ושיוך תוכן ריק.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני (אותו דגל כמו שאר בדיקות המסד):
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<db> npm test
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, engine, org;
const inOrg = (fn) => db.withOrg(org, fn);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  engine = await import('../src/engine.js');
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('sched-r2-test') returning id")).rows[0].id;
  // מרווח כללי של יום — כדי שנקודה אחת תוכל לקבל כמה פוסטים בשבוע
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/** נקודה וערוץ חדשים לכל בדיקה — שום דבר לא דולף בין בדיקות */
async function fresh(name, { maxPerWeek = 7 } = {}) {
  return inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id',
      [name])).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ($1, 'manual', $2, 0) returning id`, [`ערוץ ${name}`, maxPerWeek])).id;
    return { ep, ch };
  });
}

/** פריט תוכן עם גרסה מוכנה לערוץ (body ריק = כותרת בלבד) */
async function item(x, title, { campaignId = null, body = 'טקסט' } = {}) {
  return inOrg(async () => {
    const id = (await db.one(
      `insert into content_items (endpoint_id, campaign_id, kind, title)
       values ($1, $2, 'value', $3) returning id`, [x.ep, campaignId, title])).id;
    await db.query(`insert into content_variants (content_id, channel_id, body, status)
                    values ($1, $2, $3, 'ready')`, [id, x.ch, body]);
    return id;
  });
}

const mine = (plan, x) => plan.placements.filter((p) => p.channel_id === x.ch);

/* ========================= קמפיין לא פעיל ========================= */

test('קמפיין לא פעיל — התוכן שלו לא משובץ ולא מוצע; הפעלה מחדש — משובץ', { skip }, async () => {
  const x = await fresh('לא פעיל');
  const campaignId = await inOrg(async () => (await db.one(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, active)
     values ($1, 'כבוי', '2031-06-01', '2031-06-30', false) returning id`, [x.ep])).id);
  await inOrg(() => db.query('insert into campaign_channels (campaign_id, channel_id) values ($1, $2)',
    [campaignId, x.ch]));
  const id = await item(x, 'זווית של קמפיין כבוי', { campaignId });
  const now = new Date('2031-06-08T08:00:00');   // ראשון בבוקר

  await inOrg(async () => {
    const plan = await engine.planWeek('2031-06-08', { holes: false, now });
    assert.deepEqual(mine(plan, x), []);
    // גם "שייך תוכן" לא מציע אותו
    const list = await engine.contentCandidates({ channelId: x.ch, date: '2031-06-10' });
    assert.ok(!list.some((c) => c.id === id));
  });

  await inOrg(() => db.query('update campaigns set active = true where id = $1', [campaignId]));
  await inOrg(async () => {
    const plan = await engine.planWeek('2031-06-08', { holes: false, now });
    assert.deepEqual(mine(plan, x).map((p) => p.content_id), [id]);
    const list = await engine.contentCandidates({ channelId: x.ch, date: '2031-06-10' });
    assert.ok(list.some((c) => c.id === id));
  });
});

/* ========================= פוסט שנכשל ========================= */

/** פוסט על הלוח של הנקודה בערוץ */
const post = (x, contentId, at, status) => inOrg(() => db.query(
  `insert into posts (channel_id, endpoint_id, content_id, kind, title, status, scheduled_at)
   values ($1, $2, $3, 'value', 'פוסט', $4, $5)`, [x.ch, x.ep, contentId, status, at]));

for (const [status, expectPlaced] of [['failed', true], ['scheduled', false], ['published', false]]) {
  test(`פוסט ${status} ביום שני שעבר, max_per_week=1 — ${expectPlaced ? 'משבצת נוספת באותו שבוע' : 'אין מקום'}`,
    { skip }, async () => {
      const x = await fresh(`נכשל ${status}`, { maxPerWeek: 1 });
      const a = await item(x, `זווית א ${status}`);
      const b = await item(x, `זווית ב ${status}`);
      await post(x, a, '2031-06-16T10:00:00', status);   // שני
      await inOrg(async () => {
        const now = new Date('2031-06-18T08:00:00');      // רביעי בבוקר
        const plan = await engine.planWeek('2031-06-15', { holes: false, now });
        const got = mine(plan, x);
        if (!expectPlaced) {
          assert.deepEqual(got, []);
          return;
        }
        // התוכן של הפוסט שנכשל לא משובץ שוב לבד — המשבצת הולכת לתוכן אחר
        assert.deepEqual(got.map((p) => p.content_id), [b]);
        assert.ok(new Date(got[0].scheduled_at) > now);
      });
    });
}

/* ========================= מבצע דחוף ========================= */

/** n פוסטים מתוכננים בערוץ, החל מ-firstDay (YYYY-MM-DD), יום אחרי יום */
async function fillDays(x, firstDay, n) {
  for (let i = 0; i < n; i += 1) {
    const d = new Date(`${firstDay}T10:00:00`);
    d.setDate(d.getDate() + i);
    await inOrg(() => db.query(
      `insert into posts (channel_id, endpoint_id, kind, title, status, scheduled_at)
       values ($1, $2, 'value', 'קיים', 'scheduled', $3)`, [x.ch, x.ep, d]));
  }
}

test('דחוף עד שני — שבוע שכבר מלא שלישי–שבת לא מקבל את שני', { skip }, async () => {
  const { planUrgent } = await import('../src/urgent.js');
  const now = new Date('2031-06-15T08:00:00');   // ראשון בבוקר
  const full = await fresh('דחוף מלא', { maxPerWeek: 5 });
  await fillDays(full, '2031-06-17', 5);          // שלישי–שבת = 5 מתוך 5
  const roomy = await fresh('דחוף פנוי', { maxPerWeek: 5 });
  await fillDays(roomy, '2031-06-17', 4);         // 4 מתוך 5 — יש מקום אחד
  await inOrg(async () => {
    const input = (x) => ({ title: 'מבצע', until: '2031-06-16', channel_ids: [x.ch] });
    const a = await planUrgent(input(full), { now });
    assert.deepEqual(a.placements, []);
    assert.match(a.warnings.join(' '), /אין שטח פנוי/);
    const b = await planUrgent(input(roomy), { now });
    assert.equal(b.placements.length, 1);
    assert.ok(new Date(b.placements[0].scheduled_at) > now);
  });
});

test('דחוף — נכשל שהמועד שלו עבר לא תופס מקום', { skip }, async () => {
  const { planUrgent } = await import('../src/urgent.js');
  const now = new Date('2031-06-25T08:00:00');   // רביעי בבוקר
  const x = await fresh('דחוף נכשל', { maxPerWeek: 1 });
  await inOrg(() => db.query(
    `insert into posts (channel_id, endpoint_id, kind, title, status, scheduled_at)
     values ($1, $2, 'value', 'נכשל', 'failed', '2031-06-23T10:00:00')`, [x.ch, x.ep]));
  await inOrg(async () => {
    const plan = await planUrgent({ title: 'מבצע', until: '2031-06-26', channel_ids: [x.ch] },
      { now });
    assert.equal(plan.placements.length, 1);
  });
});

test('אישור דחוף: מילוי אחר מחזיק את נעילת המנוע — 503 בלי לכתוב', { skip }, async () => {
  const { default: express } = await import('express');
  const { default: engineRoutes } = await import('../src/routes/engine.js');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בדיקה', is_owner: true };
    db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {});
  });
  app.use(engineRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const x = await fresh('דחוף נעול');
  const commit = () => fetch(`${base}/urgent/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'מבצע נעול', channel_ids: [x.ch] }),
  });

  let release;
  const held = new Promise((r) => { release = r; });
  let locked;
  const gotLock = new Promise((r) => { locked = r; });
  const holder = db.withOrg(org, async () => {
    await db.query('select pg_advisory_xact_lock($1, $2)', [engine.ENGINE_LOCK_KEY, org]);
    locked();
    await held;
  });
  await gotLock;
  process.env.ENGINE_LOCK_TIMEOUT = '200ms';
  try {
    const res = await commit();
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /נסו לאשר שוב/);
    const n = await inOrg(() => db.one(
      "select count(*)::int as n from posts where channel_id = $1 and title = 'מבצע נעול'", [x.ch]));
    assert.equal(n.n, 0);
  } finally {
    delete process.env.ENGINE_LOCK_TIMEOUT;
    release();
    await holder;
  }
  // אחרי השחרור — נכתב כרגיל
  const ok = await commit();
  assert.equal(ok.status, 201);
  server.close();
});
