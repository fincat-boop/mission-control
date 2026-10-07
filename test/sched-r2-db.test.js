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
