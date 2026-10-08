import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שתי החלטות המשתמש מ-8.10.26 מול Postgres אמיתי:
 *   א. אין פוסט בלי נקודת קצה — POST /posts, PATCH /posts ומבצע דחוף דוחים
 *      פוסט בלי נקודה, והצעד החד-פעמי orphan_posts_v1 מנקה את הקיים.
 *   ב. אין פרסום אוטומטי כשמתג-העל כבוי — אישור / אישור השבוע / פרסם עכשיו /
 *      העבר ל-HUB נדחים (409), כיבוי המתג מחזיר מאושר ונכשל למתוכנן, והצעד
 *      manual_only_v1 עושה את אותו ניקוי פעם אחת.
 * הנתיבים רצים באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת.
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/manual-only-db.test.js
 * הצעדים החד-פעמיים רצים שוב (המפתח נמחק מ-app_migrations) — על כל הארגונים
 * במסד הבדיקה, ולכן רק על עותק.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;
const pending = new Set();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);
  return { status: res.status, json };
}

const inOrg = (fn) => db.withOrg(org, fn);
const q1 = (sql, params) => inOrg(() => db.one(sql, params));
const qa = (sql, params) => inOrg(() => db.rows(sql, params));
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const days = (d) => minutes(d * 24 * 60);
const setAuto = (on) => inOrg(() => db.query('update engine_settings set autopublish_enabled = $1', [on]));

/** פוסט ישירות במסד. at — דקות מעכשיו (שלילי = עבר) */
async function post({ channel = ids.fb, endpoint = ids.ep, content = ids.ready, title = 'פוסט',
                      at = 60 * 24 * 3, status = 'scheduled', error = null } = {}) {
  return (await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status,
                        publish_error, approved_at)
     values ($1,$2,$3,$4,'value',$5,$6,$7, case when $6 = 'approved' then now() end) returning id`,
    [channel, endpoint, content, title, minutes(at), status, error])).id;
}
const statusOf = async (id) => (await q1('select status from posts where id = $1', [id]))?.status ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');
  const { default: engine } = await import('../src/routes/engine.js');
  const { default: publish } = await import('../src/routes/publish.js');
  const { default: settings } = await import('../src/routes/settings.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('manual-only-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const ep2 = (await db.one("insert into endpoints (name, importance) values ('ייעוץ', 9) returning id")).id;
    const off = (await db.one(
      "insert into endpoints (name, importance, active) values ('מושבתת', 5, false) returning id")).id;
    const fb = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 7) returning id")).id;
    const nl = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('ניוזלטר', 'newsletter', 7) returning id")).id;
    const ready = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'מוכן') returning id", [ep])).id;
    const other = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'של ייעוץ') returning id",
      [ep2])).id;
    for (const [c, ch] of [[ready, fb], [ready, nl], [other, fb]]) {
      await db.query(
        `insert into content_variants (content_id, channel_id, status, body, meta)
         values ($1,$2,'ready','טקסט מוכן','{"subject":"נושא"}')`, [c, ch]);
    }
    return { ep, ep2, off, fb, nl, ready, other };
  });

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
  app.use(engine);
  app.use(publish);
  app.use(settings);
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

/* ========================= א — אין פוסט בלי נקודת קצה ========================= */

test('א — POST /posts: בלי נקודה 400; נקודה מושבתת 409; תוכן של נקודה אחרת 400; תקין 201', { skip }, async () => {
  const base1 = { channel_id: ids.fb, title: 'ידני', kind: 'value', scheduled_at: days(10) };
  const none = await call('POST', '/posts', base1);
  assert.equal(none.status, 400);
  assert.match(none.json.error, /אין פוסט בלי נקודת קצה/);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: '' })).status, 400);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: ids.off })).status, 409);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: 999999 })).status, 404);

  const mismatch = await call('POST', '/posts', { ...base1, endpoint_id: ids.ep, content_id: ids.other });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /נקודת קצה אחרת/);

  const ok = await call('POST', '/posts', { ...base1, endpoint_id: ids.ep2, content_id: ids.other });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.post.endpoint_id, ids.ep2);
});

test('א — PATCH /posts: אי אפשר לאפס נקודה או להחליף לתוכן של נקודה אחרת; כותרת לפוסט ישן בלי נקודה — כן', { skip }, async () => {
  const id = await post({ at: 60 * 24 * 12, title: 'לעריכה' });
  const cleared = await call('PATCH', `/posts/${id}`, { endpoint_id: null });
  assert.equal(cleared.status, 400);
  assert.match(cleared.json.error, /אין פוסט בלי נקודת קצה/);
  const swapped = await call('PATCH', `/posts/${id}`, { content_id: ids.other });
  assert.equal(swapped.status, 400);
  assert.match(swapped.json.error, /נקודת קצה אחרת/);
  // החלפה יחד עם הנקודה של התוכן (כמו "החלף בתוכן המוצע") — עוברת
  const both = await call('PATCH', `/posts/${id}`, { content_id: ids.other, endpoint_id: ids.ep2,
                                                         confirm_warnings: true });
  assert.equal(both.status, 200, JSON.stringify(both.json));
  assert.equal(both.json.post.endpoint_id, ids.ep2);

  // פוסט שפורסם לפני הכלל ונשאר בלי נקודה (הנקודה נמחקה) — עדיין נערך בכותרת
  const legacy = await post({ endpoint: null, content: null, status: 'published', at: -60 * 24 * 30 });
  const titled = await call('PATCH', `/posts/${legacy}`, { title: 'כותרת חדשה' });
  assert.equal(titled.status, 200, JSON.stringify(titled.json));
});

test('א — מבצע דחוף בלי נקודה: התצוגה המקדימה מסבירה, האישור נדחה ולא נכתב כלום', { skip }, async () => {
  const body = { title: 'מבצע בלי נקודה', channel_ids: [ids.fb] };
  const preview = await call('POST', '/urgent/preview', body);
  assert.equal(preview.json.ok, false);
  assert.ok(preview.json.errors.includes('צריך לבחור נקודת קצה'));
  const commit = await call('POST', '/urgent/commit', body);
  assert.equal(commit.status, 400);
  assert.match(commit.json.error, /צריך לבחור נקודת קצה/);
  const disabled = await call('POST', '/urgent/preview', { ...body, endpoint_id: ids.off });
  assert.deepEqual(disabled.json.errors, ['נקודת הקצה שנבחרה מושבתת']);
  const n = await q1("select count(*)::int as n from posts where title = 'מבצע בלי נקודה'");
  assert.equal(n.n, 0);

  const ok = await call('POST', '/urgent/commit', { ...body, endpoint_id: ids.ep, title: 'מבצע עם נקודה' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.ok(ok.json.posts.every((p) => p.endpoint_id === ids.ep));
});
