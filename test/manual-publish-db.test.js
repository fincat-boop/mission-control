import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 1 של שיפורי ההתנהגות (docs/behavior-improvements.md) מול Postgres אמיתי:
 * פרסום ידני — שמירת הסטטוס בנתיבים (ב1), משימת "לפרסם היום" (1), "לא אושר
 * שיצא" (2), מבצע דחוף בלי תוכן (26), רשימת המשימות (27), סימן אחד לפוסט
 * (28) וכיול ההתראות (29). הנתיבים רצים באפליקציית express קטנה, כל בקשה
 * בתוך withOrg — כמו בשרת (כמו content-db).
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/manual-publish-db.test.js
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;
const pending = new Set();
let currentUser = { id: null, name: 'בדיקה', is_owner: true };

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

/** פוסט ישירות במסד. at — דקות מעכשיו (שלילי = עבר) */
async function post({ channel = ids.fb, endpoint = ids.ep, title = 'פוסט', at = 60, status = 'scheduled',
                      content = ids.ready, urgent = false, autoHole = false } = {}) {
  return (await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status, urgent, auto_hole)
     values ($1,$2,$3,$4,'value',$5,$6,$7,$8) returning id`,
    [channel, endpoint, content, title, minutes(at), status, urgent, autoHole])).id;
}

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');
  const { default: tasks } = await import('../src/routes/tasks.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('manual-publish-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const ep2 = (await db.one("insert into endpoints (name, importance) values ('ייעוץ', 9) returning id")).id;
    const ch = async (name, platform, active = true) => (await db.one(
      'insert into channels (name, platform, max_per_week, active) values ($1,$2,7,$3) returning id',
      [name, platform, active])).id;
    const fb = await ch('פייסבוק', 'facebook');
    const wa = await ch('וואטסאפ', 'whatsapp');
    const nl = await ch('ניוזלטר', 'newsletter');
    const off = await ch('כבוי', 'manual', false);
    const ready = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'מוכן') returning id",
      [ep])).id;
    for (const c of [fb, wa, nl, off]) {
      await db.query(
        "insert into content_variants (content_id, channel_id, status, body) values ($1,$2,'ready','טקסט מוכן')",
        [ready, c]);
    }
    return { ep, ep2, fb, wa, nl, off, ready };
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    const p = db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(board);
  app.use(tasks);
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

/* ========================= ב1 — הנתיבים שומרים על הסטטוס ========================= */

test('ב1 — POST /posts מתעלם מ-status בגוף: פוסט ידני נולד מתוכנן', { skip }, async () => {
  const r = await call('POST', '/posts', {
    channel_id: ids.fb, endpoint_id: ids.ep2, title: 'ניסיון לעקוף', kind: 'value',
    scheduled_at: minutes(60 * 24 * 20), status: 'approved',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.post.status, 'scheduled');
});

test('ב1 — POST /posts דוחה מועד שעבר; אותו יום בשעה מאוחרת יותר — בסדר', { skip }, async () => {
  const past = await call('POST', '/posts', {
    channel_id: ids.fb, title: 'בעבר', kind: 'value', scheduled_at: minutes(-5),
  });
  assert.equal(past.status, 400);
  assert.equal(past.json.error, 'אי אפשר לשבץ פוסט לזמן שעבר');
  const broken = await call('POST', '/posts', {
    channel_id: ids.fb, title: 'שבור', kind: 'value', scheduled_at: 'לא-תאריך',
  });
  assert.equal(broken.status, 400);
  const soon = await call('POST', '/posts', {
    channel_id: ids.wa, title: 'עוד מעט', kind: 'value', scheduled_at: minutes(2),
  });
  assert.equal(soon.status, 201, JSON.stringify(soon.json));
});

test('ב1 — "סמן שפורסם" רק ממתוכנן/מאושר/נכשל; אחרת 409 עם הסבר', { skip }, async () => {
  for (const st of ['pending_approval', 'publishing', 'published']) {
    const id = await post({ title: `סטטוס ${st}`, status: st, at: -90 });
    const r = await call('POST', `/posts/${id}/publish`);
    assert.equal(r.status, 409, st);
    assert.ok(r.json.error, st);
    const after = await q1('select status from posts where id = $1', [id]);
    assert.equal(after.status, st, 'הסטטוס לא השתנה');
  }
  for (const st of ['scheduled', 'approved', 'failed']) {
    const id = await post({ title: `מותר ${st}`, status: st, at: -90 });
    const r = await call('POST', `/posts/${id}/publish`);
    assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.post.status, 'published');
  }
  assert.equal((await call('POST', '/posts/99999999/publish')).status, 404);
});

test('ב1 — published_at: מועד שעבר = המועד עצמו; מועד עתידי = עכשיו', { skip }, async () => {
  const pastId = await post({ title: 'עבר', at: -60 * 30 });
  const r = await call('POST', `/posts/${pastId}/publish`);
  assert.equal(r.status, 200);
  const p = await q1('select published_at, scheduled_at from posts where id = $1', [pastId]);
  assert.equal(new Date(p.published_at).getTime(), new Date(p.scheduled_at).getTime());

  const futureId = await post({ title: 'עתיד', at: 60 * 5 });
  await call('POST', `/posts/${futureId}/publish`);
  const f = await q1('select published_at from posts where id = $1', [futureId]);
  assert.ok(Math.abs(new Date(f.published_at).getTime() - Date.now()) < 60000);
});

/* ========================= 26 — מבצע דחוף: כותרת בלבד בכוונה ========================= */

test('26 — מבצע דחוף בלי תוכן: לא "חסר תוכן" ולא משימת החלפה; פוסט רגיל — כן', { skip }, async () => {
  const urgentId = await post({ title: 'מבצע בזק', content: null, urgent: true, at: 120, endpoint: ids.ep2 });
  const plainId = await post({ title: 'בלי תוכן', content: null, at: 150, channel: ids.wa, endpoint: ids.ep2 });
  // תוכן מוכן להציע — בערוץ של שני הפוסטים
  await inOrg(async () => {
    const c = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1,'value','חלופה') returning id",
      [ids.ep])).id;
    for (const ch of [ids.fb, ids.wa]) {
      await db.query(
        "insert into content_variants (content_id, channel_id, status, body) values ($1,$2,'ready','x')", [c, ch]);
    }
  });

  const { buildAlerts } = await import('../src/alerts.js');
  const { alerts } = await inOrg(() => buildAlerts(null));
  assert.ok(!alerts.some((a) => a.id === `no-text-${urgentId}`), 'דחוף לא מקבל "חסר תוכן"');
  assert.ok(alerts.some((a) => a.id === `no-text-${plainId}`), 'פוסט רגיל בלי תוכן — כן');

  const { suggestContentSwaps } = await import('../src/maintenance.js');
  await suggestContentSwaps();
  const swaps = await qa("select post_id from tasks where kind = 'swap' and post_id = any($1)",
    [[urgentId, plainId]]);
  assert.deepEqual(swaps.map((t) => t.post_id), [plainId]);
});
