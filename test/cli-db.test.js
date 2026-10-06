import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * כלי התיקון מול Postgres אמיתי: fix-clashes נוגע רק בארגון שבו הוא רץ
 * (withOrg), ו-planRespace שולף את עמודות "קמפיין מוכן" — פוסט לא זז לפני
 * התאריך המתוכנן שלו.
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * כל הרצה בארגונים חדשים משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db;

/** ארגון עם נקודה, ערוץ ושני פוסטים לאותה נקודה באותו יום (5.3.2030) */
async function orgWithClash(name) {
  const org = (await db.pool.query('insert into orgs (name) values ($1) returning id', [name]))
    .rows[0].id;
  const posts = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings (min_gap_days) values (7)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id")).id;
    const ch = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 5) returning id")).id;
    const ids = [];
    for (const hour of ['10', '11']) {
      ids.push((await db.one(
        `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status)
         values ($1, $2, 'פוסט', 'value', $3, 'scheduled') returning id`,
        [ch, ep, `2030-03-05T${hour}:00:00+02:00`])).id);
    }
    return ids;
  });
  return { org, posts };
}

const dayOf = async (org, id) => db.withOrg(org, async () =>
  (await db.one("select to_char(scheduled_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d from posts where id = $1", [id])).d);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
});

after(async () => {
  if (RUN) await db.pool.end();
});

test('fix-clashes — מתקן רק בארגון שבו הוא רץ', { skip }, async () => {
  const { runFixClashes } = await import('../src/fix-clashes.js');
  const a = await orgWithClash('clash-a');
  const b = await orgWithClash('clash-b');
  const plan = await db.withOrg(a.org, () => runFixClashes({ apply: true, log: () => {} }));
  assert.equal(plan.moves.length, 1);
  assert.equal(await dayOf(a.org, a.posts[0]), '2030-03-05');
  assert.equal(await dayOf(a.org, a.posts[1]), '2030-03-12');   // מרווח 7
  // הארגון השני לא נגע
  assert.equal(await dayOf(b.org, b.posts[0]), '2030-03-05');
  assert.equal(await dayOf(b.org, b.posts[1]), '2030-03-05');
  // יבש — לא כותב
  const c = await orgWithClash('clash-c');
  await db.withOrg(c.org, () => runFixClashes({ apply: false, log: () => {} }));
  assert.equal(await dayOf(c.org, c.posts[1]), '2030-03-05');
});

test('planRespace — פוסט של קמפיין מוכן לא זז לפני התאריך המתוכנן שלו', { skip }, async () => {
  const { planRespace } = await import('../src/respace.js');
  const org = (await db.pool.query("insert into orgs (name) values ('respace-complete') returning id"))
    .rows[0].id;
  const postId = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings (min_gap_days) values (7)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id")).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ('פייסבוק', 'facebook', 5, 0) returning id`)).id;
    const c = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, content_complete_at)
       values ($1, 'מוכן', '2030-11-01', '2030-11-30', 'general', now()) returning id`, [ep])).id;
    await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1, $2)', [c, ch]);
    let fourth = null;
    for (let i = 1; i <= 6; i += 1) {
      const it = (await db.one(
        `insert into content_items (endpoint_id, kind, title, campaign_id, sort_order, slot_channel_id)
         values ($1, 'value', $2, $3, $4, $5) returning id`, [ep, `פריט ${i}`, c, i, ch])).id;
      if (i === 4) fourth = it;
    }
    // פריט 4 מתוך 6 מתוכנן ל-16.11 (שבת); בלי עמודות "קמפיין מוכן" ההזזה
    // הייתה מקדימה אותו לאמצע השבוע
    return (await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1, $2, $3, 'פריט 4', 'value', '2030-11-16T10:00:00+02:00', 'scheduled') returning id`,
      [ch, ep, fourth])).id;
  });
  const plan = await db.withOrg(org, () => planRespace('2030-11-13'));
  const m = plan.moves.find((x) => x.post.id === postId);
  assert.ok(m, 'הפוסט לא נבדק בכלל');
  assert.equal(m.dateKey, '2030-11-16');
});
