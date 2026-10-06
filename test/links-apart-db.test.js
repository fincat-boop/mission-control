import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * פוסטים מקושרים לא באותו יום (links_apart) ומכסות לפוסט ידני, מול Postgres
 * אמיתי: המנוע (planWeek) משבץ מקור ועוקבת בימים שונים, ומאפשר אותו יום כשהקמפיין
 * כיבה את הכלל; בלוח — אזהרות שאפשר לאשר (פוסט מקושר, פוסטים בשבוע, תקרה
 * לסוג, מכירתי ליום) וחסימות של פוסט ידני (יום חסום, אותה נקודה באותו יום).
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org;
const pending = new Set();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);   // ה-commit קורה אחרי שהתשובה נשלחה (כמו בשרת)
  return { status: res.status, json };
}

const inOrg = (fn) => db.withOrg(org, fn);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');

  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'links_apart'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('links-apart-test') returning id")).rows[0].id;
  await inOrg(() => db.query('insert into engine_settings default values'));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בדיקה', is_owner: true };
    const p = db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(board);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (!RUN) return;
  server?.close();
  await db.pool.end();
});

/**
 * נקודה, שני ערוצים (חסומים בכל הימים חוץ מ-open), קמפיין כללי בשבוע
 * 17–23.11.2030 על שניהם, ומקור (ערוץ A) + עוקבת מקושרת (ערוץ B) מוכנים.
 */
async function linkedSetup({ apart = true, openA = null, openB = null, name = 'קישור' } = {}) {
  const blocked = (open) => (open ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !open.includes(d)) : []);
  return inOrg(async () => {
    const ep = (await db.one(
      "insert into endpoints (name, importance) values ($1, 5) returning id", [name])).id;
    const mkCh = async (n, open) => (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct, blocked_days)
       values ($1, 'manual', 7, 0, $2) returning id`, [n, blocked(open)])).id;
    const a = await mkCh(`${name} A`, openA);
    const b = await mkCh(`${name} B`, openB);
    const camp = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, links_apart)
       values ($1, $2, '2030-11-17', '2030-11-23', 'general', $3) returning id`,
      [ep, name, apart])).id;
    await db.query('insert into campaign_channels values ($1,$2), ($1,$3)', [camp, a, b]);
    const mkItem = async (title, ch, linkedTo = null) => {
      const it = (await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, slot_channel_id, linked_to_id)
         values ($1,$2,'value',$3,$4,$5) returning id`, [ep, camp, title, ch, linkedTo])).id;
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'x','ready')`,
        [it, ch]);
      return it;
    };
    const root = await mkItem(`${name} מקור`, a);
    const follower = await mkItem(`${name} עוקבת`, b, root);
    return { ep, a, b, camp, root, follower };
  });
}

async function cleanup(s) {
  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1 or channel_id = any($2::int[])',
      [s.ep, [s.a, s.b]]);
    await db.query('update content_items set linked_to_id = null where campaign_id = $1', [s.camp]);
    await db.query('delete from content_items where campaign_id = $1', [s.camp]);
    await db.query('delete from campaigns where id = $1', [s.camp]);
    await db.query('delete from channels where id = any($1::int[])', [[s.a, s.b]]);
    await db.query('delete from endpoints where id = $1', [s.ep]);
  });
}

const NOW = new Date('2030-11-01T08:00:00');
const plan = () => inOrg(async () => {
  const { planWeek } = await import('../src/engine.js');
  return planWeek('2030-11-19', { holes: false, now: NOW });
});

test('המנוע: מקור ועוקבת בשני ערוצים, שבוע פנוי — בימים שונים', { skip }, async () => {
  const s = await linkedSetup({ name: 'פנוי' });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [s.root, s.follower].includes(x.content_id));
    assert.equal(mine.length, 2, JSON.stringify(mine.map((x) => [x.title, x.date])));
    assert.notEqual(mine[0].date, mine[1].date);
  } finally {
    await cleanup(s);
  }
});

test('המנוע: שני הערוצים פתוחים רק ביום שני — אחד בלבד; links_apart כבוי — שניהם באותו יום', { skip }, async () => {
  const on = await linkedSetup({ name: 'שני', openA: [1], openB: [1] });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [on.root, on.follower].includes(x.content_id));
    assert.equal(mine.length, 1, JSON.stringify(mine.map((x) => [x.title, x.date])));
  } finally {
    await cleanup(on);
  }

  const off = await linkedSetup({ name: 'כבוי', openA: [1], openB: [1], apart: false });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [off.root, off.follower].includes(x.content_id));
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((x) => x.date), ['2030-11-18', '2030-11-18']);
  } finally {
    await cleanup(off);
  }
});

test('המנוע: מול פוסט קיים של המקור, ושיוך לפוסט חסר תוכן באותו יום — לא', { skip }, async () => {
  const s = await linkedSetup({ name: 'קיים', openB: [1] });
  try {
    await inOrg(async () => {
      // המקור כבר יוצא ב-18.11 בערוץ A; ב-B פוסט חסר תוכן של המנוע באותו יום
      await db.query(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
         values ($1,$2,$3,'מקור','value','2030-11-18T10:00:00+02:00')`, [s.a, s.ep, s.root]);
      await db.query(
        `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, auto_hole)
         values ($1,$2,'חסר תוכן','value','2030-11-18T12:00:00+02:00', true)`, [s.b, s.ep]);
    });
    const p = await plan();
    assert.ok(!p.attachments.some((x) => x.content_id === s.follower), 'לא משויכת לחסר התוכן');
    assert.ok(!p.placements.some((x) => x.content_id === s.follower), 'ולא משובצת (B פתוח רק ב-18.11)');

    // links_apart כבוי — השיוך עובר
    await inOrg(() => db.query('update campaigns set links_apart = false where id = $1', [s.camp]));
    const p2 = await plan();
    assert.ok(p2.attachments.some((x) => x.content_id === s.follower));
  } finally {
    await cleanup(s);
  }
});
