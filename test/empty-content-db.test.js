import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * סעיפים 20–21 מול Postgres אמיתי: טיוטה עם כותרת בלבד (בלי טקסט ובלי מדיה)
 * היא "חסר תוכן" — בהתראה ובלוח; וגרסה "מוכן" שלא תעבור את בדיקת הפרסום
 * מגיעה ללוח עם הסיבה (ready_warn) — אותה בדיקה כמו התא בטבלה.
 *
 * רץ רק במפורש, מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/empty-content-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, org, ids;
const inOrg = (fn) => db.withOrg(org, fn);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('empty-content-db-test') returning id")).rows[0].id;

  ids = await inOrg(async () => {
    await db.query('insert into engine_settings (min_gap_days) values (7)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id")).id;
    const fb = (await db.one(
      `insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 7) returning id`)).id;
    const ig = (await db.one(
      `insert into channels (name, platform, max_per_week) values ('אינסטגרם', 'instagram', 7) returning id`)).id;

    /** תוכן שוטף עם גרסה לערוץ, ופוסט שלו בעוד h שעות */
    const make = async (title, ch, { body = '', status = 'draft', image = false, h }) => {
      const c = (await db.one(
        `insert into content_items (endpoint_id, kind, title) values ($1, 'value', $2) returning id`,
        [ep, title])).id;
      const v = (await db.one(
        `insert into content_variants (content_id, channel_id, status, body)
         values ($1, $2, $3, $4) returning id`, [c, ch, status, body])).id;
      if (image) {
        await db.query(
          `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data)
           values ($1, $2, 'a.png', 'image/png', 1, '\\x00')`, [c, v]);
      }
      const p = (await db.one(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
         values ($1, $2, $3, $4, 'value', $5, 'scheduled') returning id`,
        [ch, ep, c, title, hoursFromNow(h)])).id;
      return p;
    };
    return {
      fb, ig,
      emptyDraft: await make('כותרת בלבד', fb, { h: 20 }),
      spaces: await make('רווחים בלבד', fb, { body: '   \n ', h: 21 }),
      withText: await make('יש טקסט', fb, { body: 'שלום', h: 22 }),
      imageOnly: await make('רק תמונה', fb, { image: true, h: 23 }),
      igReadyNoImage: await make('מוכן בלי תמונה', ig, { body: 'כיתוב', status: 'ready', h: 24 }),
      igReadyOk: await make('מוכן עם תמונה', ig, { body: 'כיתוב', status: 'ready', image: true, h: 25 }),
    };
  });
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

test('סעיף 20 — טיוטה בלי טקסט ובלי מדיה מקבלת "חסר תוכן"; טקסט או תמונה — לא', { skip }, async () => {
  const alerts = await import('../src/alerts.js');
  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  const byId = new Map(shown.map((a) => [a.id, a]));
  for (const id of [ids.emptyDraft, ids.spaces]) {
    const a = byId.get(`no-text-${id}`);
    assert.ok(a, `אין התראת חסר תוכן לפוסט ${id}`);
    assert.equal(a.level, 'crit'); // בתוך 48 השעות
    assert.match(a.detail, /יש רק כותרת/);
  }
  for (const id of [ids.withText, ids.imageOnly, ids.igReadyNoImage, ids.igReadyOk]) {
    assert.ok(!byId.has(`no-text-${id}`), `no-text-${id}`);
  }
});

test('סעיף 20 — משימת "לכתוב" פתוחה מכסה גם התראה על טיוטה ריקה', { skip }, async () => {
  const alerts = await import('../src/alerts.js');
  await inOrg(() => db.query(
    `insert into tasks (title, kind, post_id) values ('לכתוב', 'write', $1)`, [ids.spaces]));
  const { alerts: shown } = await inOrg(() => alerts.buildAlerts(null));
  assert.ok(!shown.some((a) => a.id === `no-text-${ids.spaces}`));
  assert.ok(shown.some((a) => a.id === `no-text-${ids.emptyDraft}`));
});

test('סעיפים 20–21 — הלוח: content_empty, ו-ready_warn מאותה בדיקה כמו הטבלה', { skip }, async () => {
  const { buildBoard } = await import('../src/board.js');
  const seen = new Map();
  // הפוסטים בתוך 25 השעות הקרובות — לכל היותר שני שבועות על הלוח
  for (const anchor of [new Date(), hoursFromNow(25)]) {
    const b = await inOrg(() => buildBoard(anchor));
    for (const ch of b.channels) {
      for (const d of ch.days) for (const p of d.posts) seen.set(p.id, p);
    }
  }
  assert.equal(seen.get(ids.emptyDraft).content_empty, true);
  assert.equal(seen.get(ids.spaces).content_empty, true);
  assert.equal(seen.get(ids.withText).content_empty, false);
  assert.equal(seen.get(ids.imageOnly).content_empty, false);
  // טיוטה — אין "מוכן ⚠" גם כשחסר משהו
  assert.equal(seen.get(ids.withText).ready_warn, null);
  assert.match(seen.get(ids.igReadyNoImage).ready_warn, /אינסטגרם דורש תמונה או וידאו/);
  assert.equal(seen.get(ids.igReadyOk).ready_warn, null);
  // הגוף והמטא של הגרסה לא יוצאים בתשובת הלוח
  assert.ok(!('variant_body' in seen.get(ids.withText)));
});
