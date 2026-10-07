import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * פוסט מאושר על יום שנחסם (relocateBlocked / postsOnBlockedDays / התראה)
 * ושעת 22:00 תפוסה במנוע — מול Postgres אמיתי. קודם מאושר לא נבחר בכלל:
 * לא זז, לא הופיע בהתראה, והטיק פרסם אותו ביום הסגור.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<db> npm test
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, engine, respace, alerts, org;
const inOrg = (fn) => db.withOrg(org, fn);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  engine = await import('../src/engine.js');
  respace = await import('../src/respace.js');
  alerts = await import('../src/alerts.js');
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('blocked-approved-test') returning id")).rows[0].id;
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/** תאריך מקומי בעוד n ימים, בשעה h */
const daysAhead = (n, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, 0, 0, 0);
  return d;
};

async function setup(name) {
  return inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id',
      [name])).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ($1, 'manual', 7, 0) returning id`, [`ערוץ ${name}`])).id;
    return { ep, ch };
  });
}

const addPost = (x, at, status, title = 'פוסט מאושר') => inOrg(async () => (await db.one(
  `insert into posts (channel_id, endpoint_id, kind, title, status, scheduled_at)
   values ($1, $2, 'value', $3, $4, $5) returning id`, [x.ch, x.ep, title, status, at])).id);

const block = (x, days) => inOrg(() =>
  db.query('update channels set blocked_days = $2 where id = $1', [x.ch, days]));

test('חסימת יום עם פוסט מאושר — הפוסט זז, נשאר מאושר, ולא לעבר', { skip }, async () => {
  const x = await setup('זז');
  const at = daysAhead(10);
  const id = await addPost(x, at, 'approved');
  await block(x, [at.getDay()]);

  const before = await inOrg(() => respace.postsOnBlockedDays());
  assert.deepEqual(before.map((p) => [p.id, p.status]), [[id, 'approved']]);

  const { moved, stuck } = await inOrg(() => respace.relocateBlocked());
  assert.equal(moved, 1);
  assert.deepEqual(stuck, []);
  const p = await inOrg(() => db.one('select status, scheduled_at from posts where id = $1', [id]));
  assert.equal(p.status, 'approved');
  assert.ok(new Date(p.scheduled_at) > new Date());
  assert.notEqual(new Date(p.scheduled_at).getDay(), at.getDay());
  assert.deepEqual(await inOrg(() => respace.postsOnBlockedDays()), []);
});

test('אין יום חוקי — המאושר נשאר במקום, וההתראה מציגה אותו', { skip }, async () => {
  const x = await setup('תקוע');
  const at = daysAhead(12);
  const id = await addPost(x, at, 'approved', 'מאושר בלי מקום');
  await block(x, [0, 1, 2, 3, 4, 5, 6]);

  const { moved, stuck } = await inOrg(() => respace.relocateBlocked());
  assert.equal(moved, 0);
  assert.deepEqual(stuck.map((s) => s.id), [id]);
  const p = await inOrg(() => db.one('select status, scheduled_at from posts where id = $1', [id]));
  assert.equal(p.status, 'approved');
  assert.equal(new Date(p.scheduled_at).getTime(), at.getTime());

  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  const a = shown.find((x2) => x2.id === `blocked-day-${id}`);
  assert.ok(a, 'יש התראה');
  assert.equal(a.level, 'crit');
  assert.equal(a.title, 'פוסט מאושר ביום שנחסם — יתפרסם ביום הזה אם לא יוזז');
  assert.match(a.detail, /מאושר בלי מקום/);
});

test('המנוע — 22:00 תפוסה ביום היחיד שנשאר: לא משבץ עליה פוסט שני', { skip }, async () => {
  const x = await setup('שעה');
  const other = await setup('שעה-אחר');
  // ערוץ פתוח רק ברביעי 20.11.2030; עכשיו 21:10 באותו יום — השעה הבאה 22:00
  await block(x, [0, 1, 2, 4, 5, 6]);
  await inOrg(async () => {
    const it = await db.one(
      `insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'זווית') returning id`,
      [x.ep]);
    await db.query(`insert into content_variants (content_id, channel_id, body, status)
                    values ($1, $2, 'x', 'ready')`, [it.id, x.ch]);
  });
  const now = new Date('2030-11-20T21:10:00');
  const plan = () => inOrg(() => engine.planWeek('2030-11-20', { holes: false, now }));
  // בלי תפוס — נכנס ב-22:00
  const free = (await plan()).placements.filter((p) => p.channel_id === x.ch);
  assert.deepEqual(free.map((p) => p.time), ['22:00']);
  // 22:00 תפוסה בפוסט של נקודה אחרת באותו ערוץ — אין משבצת
  await addPost({ ch: x.ch, ep: other.ep }, new Date('2030-11-20T22:00:00'), 'scheduled', 'תופס');
  const taken = (await plan()).placements.filter((p) => p.channel_id === x.ch);
  assert.deepEqual(taken, []);
});
