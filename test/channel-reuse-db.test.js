import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * תוכן חד-פעמי = פעם אחת בכל ערוץ (reusable במנוע), מול Postgres אמיתי.
 * קודם "פעם אחת" נספר על כל הערוצים: זווית שיצאה בפייסבוק לא שובצה
 * באינסטגרם לעולם, בזמן שהרשת הראתה אותה ממתינה.
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
  org = (await db.pool.query("insert into orgs (name) values ('channel-reuse-test') returning id")).rows[0].id;
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/** נקודה, שני ערוצים (פייסבוק, אינסטגרם) ופריט עם גרסה מוכנה לשניהם */
async function setup(name, { evergreen = false } = {}) {
  return inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id',
      [name])).id;
    const ch = async (n) => (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ($1, 'manual', 7, 0) returning id`, [`${n} ${name}`])).id;
    const fb = await ch('פייסבוק');
    const ig = await ch('אינסטגרם');
    const item = (await db.one(
      `insert into content_items (endpoint_id, kind, title, evergreen, reuse_after_days)
       values ($1, 'value', $2, $3, $4) returning id`,
      [ep, `זווית ${name}`, evergreen, evergreen ? 14 : null])).id;
    for (const c of [fb, ig]) {
      await db.query(`insert into content_variants (content_id, channel_id, body, status)
                      values ($1, $2, 'x', 'ready')`, [item, c]);
    }
    return { ep, fb, ig, item };
  });
}

const post = (x, channel, at, status = 'published') => inOrg(() => db.query(
  `insert into posts (channel_id, endpoint_id, content_id, kind, title, status, scheduled_at)
   values ($1, $2, $3, 'value', 'פוסט', $4, $5)`, [channel, x.ep, x.item, status, at]));

const placedOn = (plan, x) => plan.placements
  .filter((p) => p.content_id === x.item).map((p) => p.channel_id);

test('חד-פעמי שיצא בפייסבוק משובץ באינסטגרם בריצה הבאה — ולא שוב בפייסבוק', { skip }, async () => {
  const x = await setup('חד');
  // יצא בפייסבוק לפני שבועיים (גרירה ידנית / לא היה מקום באינסטגרם)
  await post(x, x.fb, '2031-03-05T10:00:00');
  await inOrg(async () => {
    const now = new Date('2031-03-16T08:00:00');   // ראשון בבוקר
    const plan = await engine.planWeek('2031-03-16', { holes: false, now });
    assert.deepEqual(placedOn(plan, x), [x.ig]);
    const ig = plan.placements.find((p) => p.content_id === x.item);
    assert.ok(new Date(ig.scheduled_at) > now);
  });

  // יצא גם באינסטגרם — מעכשיו לא נכנס לשום ערוץ
  await post(x, x.ig, '2031-03-17T10:00:00', 'scheduled');
  await inOrg(async () => {
    const plan = await engine.planWeek('2031-03-23',
      { holes: false, now: new Date('2031-03-23T08:00:00') });
    assert.deepEqual(placedOn(plan, x), []);
  });
});

test('evergreen — חוזר באותו ערוץ רק אחרי reuse_after_days מהפעם הקרובה', { skip }, async () => {
  const x = await setup('ירוק', { evergreen: true });
  // לפני 3 ימים בפייסבוק, ופוסט רחוק בעתיד שקודם (max) הסתיר את הקרוב
  await post(x, x.fb, '2031-05-01T10:00:00');
  await post(x, x.fb, '2031-07-01T10:00:00', 'scheduled');
  await post(x, x.ig, '2031-04-01T10:00:00');
  await inOrg(async () => {
    const plan = await engine.planWeek('2031-05-04',
      { holes: false, now: new Date('2031-05-04T08:00:00') });
    // פייסבוק: 3–9 ימים מ-1.5 < 14 — לא; אינסטגרם: חודש מאז — כן
    assert.deepEqual(placedOn(plan, x), [x.ig]);
  });
});
