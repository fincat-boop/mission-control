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
    channel_id: ids.fb, endpoint_id: ids.ep, title: 'בעבר', kind: 'value', scheduled_at: minutes(-5),
  });
  assert.equal(past.status, 400);
  assert.equal(past.json.error, 'אי אפשר לשבץ פוסט לזמן שעבר');
  const broken = await call('POST', '/posts', {
    channel_id: ids.fb, endpoint_id: ids.ep, title: 'שבור', kind: 'value', scheduled_at: 'לא-תאריך',
  });
  assert.equal(broken.status, 400);
  const soon = await call('POST', '/posts', {
    channel_id: ids.wa, endpoint_id: ids.ep, title: 'עוד מעט', kind: 'value', scheduled_at: minutes(2),
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

/* ========================= 1 — משימת "לפרסם היום" ========================= */

/** היום (שעון ישראל — TZ של הטסטים) בשעה h, + days ימים */
const dayAt = (h, days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, 0, 0, 0);
  return d;
};
const minutesUntil = (d) => (d.getTime() - Date.now()) / 60000;
const dayTasks = (postId) => qa(
  "select id, title, subtitle, urgent, done, due_on, meta from tasks where kind = 'publish' and post_id = $1",
  [postId]);

test('1 — בבוקר: משימה לכל פוסט של היום בערוץ ידני; לא ניוזלטר/כבוי/מושהה/בלי כותרת/מחר/אוטומטי', { skip }, async () => {
  const runner = await import('../src/publish/runner.js');
  const at18 = minutesUntil(dayAt(18));
  const ig = (await q1(
    "insert into channels (name, platform, max_per_week) values ('אינסטגרם', 'instagram', 7) returning id")).id;
  await inOrg(() => db.query(
    "insert into channel_connections (channel_id, page_id, auto_enabled) values ($1, '1', true)", [ig]));
  const paused = await inOrg(async () => {
    const ca = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, paused_at)
       values ($1, 'מושהה', current_date - 5, current_date + 5, now()) returning id`, [ids.ep2])).id;
    return (await db.one(
      "insert into content_items (endpoint_id, kind, title, campaign_id) values ($1,'value','מושהה',$2) returning id",
      [ids.ep2, ca])).id;
  });

  const p = {
    fb: await post({ title: 'פייסבוק היום', at: at18, endpoint: ids.ep2 }),
    wa: await post({ title: 'וואטסאפ היום', channel: ids.wa, at: at18, endpoint: ids.ep2 }),
    urgent: await post({ title: 'מבצע', content: null, urgent: true, at: at18, endpoint: null }),
    nl: await post({ title: 'ניוזלטר', channel: ids.nl, at: at18 }),
    off: await post({ title: 'כבוי', channel: ids.off, at: at18 }),
    paused: await post({ title: 'קמפיין מושהה', content: paused, at: at18, channel: ids.wa, endpoint: null }),
    blank: await post({ title: '  ', at: at18, channel: ids.wa, endpoint: null }),
    tomorrow: await post({ title: 'מחר', at: minutesUntil(dayAt(18, 1)), endpoint: ids.ep2 }),
    auto: await post({ title: 'אוטומטי', channel: ig, at: at18 }),
  };

  // לפני 06:00 — כלום
  await runner.manualPublishPrep(org, dayAt(5));
  assert.equal((await dayTasks(p.fb)).length, 0);

  // המתג הכללי דלוק: האינסטגרם המחובר מתפרסם לבד — בלי משימה
  await inOrg(() => db.query('update engine_settings set autopublish_enabled = true'));
  await runner.manualPublishPrep(org, dayAt(8));
  await inOrg(() => db.query('update engine_settings set autopublish_enabled = false'));
  await runner.manualPublishPrep(org, dayAt(9)); // שוב — לא כפולה

  const fb = await dayTasks(p.fb);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].title, 'לפרסם היום בפייסבוק: פייסבוק היום');
  assert.equal(fb[0].urgent, false);
  assert.equal(fb[0].meta.publish_day, true);
  assert.equal(fb[0].due_on, ymdOf(dayAt(12)));
  const wa = await dayTasks(p.wa);
  assert.equal(wa.length, 1);
  assert.equal(wa[0].title, 'לשלוח בוואטסאפ: וואטסאפ היום');
  assert.equal(wa[0].meta.wa_send, true);
  assert.equal((await dayTasks(p.urgent))[0]?.subtitle, runner.MANUAL_SUB_TITLE_ONLY);
  for (const k of ['nl', 'off', 'paused', 'blank', 'tomorrow']) {
    assert.equal((await dayTasks(p[k])).length, 0, k);
  }
  // המתג כבוי עכשיו — האינסטגרם כבר לא מתפרסם לבד, ולכן יש משימה
  assert.equal((await dayTasks(p.auto)).length, 1);
});

/** YYYY-MM-DD מקומי */
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
  String(d.getDate()).padStart(2, '0')}`;

test('1 — נסגרת לבד: פורסם, הוזז ליום אחר, נגמר היום; פוסט שנוסף מאוחר מקבל משימה', { skip }, async () => {
  const runner = await import('../src/publish/runner.js');
  const { closeResolvedTasks } = await import('../src/task-lifecycle.js');
  const at20 = minutesUntil(dayAt(20));
  const pub = await post({ title: 'יסומן', at: at20, channel: ids.wa, endpoint: null });
  const moved = await post({ title: 'יוזז', at: at20, channel: ids.wa, endpoint: null });
  const stays = await post({ title: 'יפוג', at: at20, channel: ids.wa, endpoint: null });
  await runner.manualPublishPrep(org, dayAt(10));
  for (const id of [pub, moved, stays]) assert.equal((await dayTasks(id)).length, 1);

  // נוסף מאוחר יותר באותו יום — הטיק הבא תופס אותו
  const late = await post({ title: 'מאוחר', at: at20, channel: ids.wa, endpoint: null });
  await runner.manualPublishPrep(org, dayAt(14));
  assert.equal((await dayTasks(late)).length, 1);

  await call('POST', `/posts/${pub}/publish`);
  await inOrg(() => db.query(
    "update posts set scheduled_at = scheduled_at + interval '1 day' where id = $1", [moved]));
  await inOrg(() => closeResolvedTasks(dayAt(15)));
  assert.equal((await dayTasks(pub))[0].done, true);
  const mv = (await dayTasks(moved))[0];
  assert.equal(mv.done, true);
  assert.equal(mv.meta.auto_closed, 'moved');
  assert.equal((await dayTasks(stays))[0].done, false);

  // למחרת בבוקר — פג תוקף
  await inOrg(() => closeResolvedTasks(dayAt(7, 1)));
  const ex = (await dayTasks(stays))[0];
  assert.equal(ex.done, true);
  assert.equal(ex.meta.auto_closed, 'expired');
});

/* ========================= 2 — "לא אושר שיצא" ========================= */

/** ארגון נקי לסעיפים שסופרים פוסטים — הבקשות הבאות רצות בו (org, ids) */
async function freshOrg(name) {
  org = (await db.pool.query('insert into orgs (name) values ($1) returning id', [name])).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one(
      "insert into endpoints (name, importance, created_at) values ('קורס', 9, now() - interval '60 days') returning id")).id;
    const ep2 = (await db.one(
      "insert into endpoints (name, importance, created_at) values ('ייעוץ', 9, now() - interval '60 days') returning id")).id;
    const ch = async (n, platform, active = true) => (await db.one(
      'insert into channels (name, platform, max_per_week, active) values ($1,$2,7,$3) returning id',
      [n, platform, active])).id;
    const fb = await ch('פייסבוק', 'facebook');
    const wa = await ch('וואטסאפ', 'whatsapp');
    const nl = await ch('ניוזלטר', 'newsletter');
    const off = await ch('כבוי', 'manual', false);
    const ready = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'מוכן') returning id", [ep])).id;
    return { ep, ep2, fb, wa, nl, off, ready };
  });
}

test('2 — התראה מרוכזת אחת: מי נספר ומי לא; משימת היום מכסה; חלון האישור = אותה רשימה', { skip }, async () => {
  await freshOrg('unconfirmed-test');
  const day = 60 * 24;
  const paused = await inOrg(async () => {
    const ca = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, paused_at)
       values ($1, 'מושהה', current_date - 10, current_date + 5, now()) returning id`, [ids.ep])).id;
    return (await db.one(
      "insert into content_items (endpoint_id, kind, title, campaign_id) values ($1,'value','מ',$2) returning id",
      [ids.ep, ca])).id;
  });
  const p = {
    a: await post({ title: 'לפני יומיים', at: -2 * day }),
    urgent: await post({ title: 'דחוף', channel: ids.wa, content: null, urgent: true, at: -40 * day }),
    approved: await post({ title: 'מאושר', status: 'approved', at: -3 * day, channel: ids.wa }),
    manualNoContent: await post({ title: 'ידני בלי תוכן', content: null, at: -4 * day, channel: ids.wa }),
    old: await post({ title: 'לפני 100 יום', at: -100 * day }),
    grace: await post({ title: 'לפני 10 דקות', at: -10, channel: ids.wa }),
    nl: await post({ title: 'ניוזלטר', channel: ids.nl, at: -2 * day }),
    off: await post({ title: 'ערוץ כבוי', channel: ids.off, at: -2 * day }),
    paused: await post({ title: 'מושהה', content: paused, at: -2 * day, channel: ids.wa }),
    hole: await post({ title: 'ממלא מקום', content: null, autoHole: true, at: -day, channel: ids.wa }),
    pending: await post({ title: 'ממתין', status: 'pending_approval', at: -2 * day, channel: ids.wa }),
    tasked: await post({ title: 'עם משימה', at: -90, channel: ids.wa, endpoint: ids.ep2 }),
  };
  const task = await q1(
    `insert into tasks (title, kind, post_id, due_on, meta)
     values ('לפרסם היום', 'publish', $1, current_date, '{"publish_day": true}') returning id`, [p.tasked]);

  const expected = [p.urgent, p.manualNoContent, p.approved, p.a].sort((x, y) => x - y);
  const { buildAlerts } = await import('../src/alerts.js');
  let { alerts } = await inOrg(() => buildAlerts(null));
  const agg = alerts.filter((a) => a.id === 'unconfirmed');
  assert.equal(agg.length, 1);
  assert.equal(agg[0].title, '4 פוסטים לא סומנו כפורסמו');
  assert.ok(!alerts.some((a) => a.id.startsWith('post-missed-')));
  // אותה רשימה בחלון
  const list = await call('GET', '/posts/unconfirmed');
  assert.deepEqual(list.json.posts.map((x) => x.id).sort((x, y) => x - y), expected);

  // המשימה פגה — עכשיו גם הוא ברשימה
  await inOrg(() => db.query('update tasks set done = true where id = $1', [task.id]));
  ({ alerts } = await inOrg(() => buildAlerts(null)));
  assert.equal(alerts.find((a) => a.id === 'unconfirmed').title, '5 פוסטים לא סומנו כפורסמו');

  // משתמש בלי הרשאת תוכן לא רואה אותה (אין לו מה לעשות איתה)
  const viewer = { is_owner: false, perm_content: false };
  ({ alerts } = await inOrg(() => buildAlerts(viewer)));
  assert.ok(!alerts.some((a) => a.id === 'unconfirmed'));
});

test('2 — "סמן שפורסמו": מרוכז, אותו כלל סטטוס, published_at = המועד, משימות נסגרות', { skip }, async () => {
  const day = 60 * 24;
  const a = await post({ title: 'מרוכז א', at: -2 * day, channel: ids.wa });
  const b = await post({ title: 'מרוכז ב', at: -3 * day, channel: ids.wa, status: 'approved' });
  const pend = await post({ title: 'ממתין לאישור', at: -2 * day, channel: ids.wa, status: 'pending_approval' });
  await q1("insert into tasks (title, kind, post_id) values ('x', 'general', $1) returning id", [a]);

  assert.equal((await call('POST', '/posts/publish-bulk', { ids: [] })).status, 400);
  assert.equal((await call('POST', '/posts/publish-bulk', { ids: ['x'] })).status, 400);
  currentUser = { id: null, is_owner: false, perm_content: false };
  assert.equal((await call('POST', '/posts/publish-bulk', { ids: [a] })).status, 403);
  currentUser = { id: null, name: 'בדיקה', is_owner: true };

  const r = await call('POST', '/posts/publish-bulk', { ids: [a, b, pend, 99999999] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { marked: 2, skipped: 2 });
  for (const id of [a, b]) {
    const row = await q1('select status, published_at, scheduled_at from posts where id = $1', [id]);
    assert.equal(row.status, 'published');
    assert.equal(new Date(row.published_at).getTime(), new Date(row.scheduled_at).getTime());
  }
  assert.equal((await q1('select status from posts where id = $1', [pend])).status, 'pending_approval');
  assert.equal((await q1('select count(*)::int as n from tasks where post_id = $1 and not done', [a])).n, 0);
});

test('2 — לא ידוע ≠ לא יצא: נקודה שהפוסט שלה לא סומן לא "לא מפרסמת", והוותק במנוע נמדד ממנו', { skip }, async () => {
  const day = 60 * 24;
  const ep = async (n) => (await q1(
    "insert into endpoints (name, importance, created_at) values ($1, 9, now() - interval '60 days') returning id",
    [n])).id;
  const unmarked = await ep('לא סומן');   // פוסט אחד לפני 3 ימים שלא סומן
  const offOnly = await ep('ערוץ כבוי');  // אותו פוסט, בערוץ מושבת — לא נספר
  await post({ title: 'יצא ולא סומן', endpoint: unmarked, at: -3 * day, channel: ids.wa });
  await post({ title: 'ערוץ מושבת', endpoint: offOnly, at: -3 * day, channel: ids.off });

  const { buildAlerts } = await import('../src/alerts.js');
  const { alerts } = await inOrg(() => buildAlerts(null));
  assert.ok(!alerts.some((a) => a.id === `endpoint-air-${unmarked}`), 'לא סומן — נספר כאילו יצא');
  assert.ok(alerts.some((a) => a.id === `endpoint-air-${offOnly}`), 'ערוץ מושבת — לא נספר');

  const engine = await import('../src/engine.js');
  const eps = await qa('select * from endpoints where id = any($1)', [[unmarked, offOnly]]);
  const settings = await q1('select * from engine_settings limit 1');
  const debts = await inOrg(() => engine.computeDebts(eps, settings, null));
  const since = debts.parts(unmarked).daysSince;
  assert.ok(since != null && Math.abs(since - 3) < 0.1, `daysSince=${since}`);
  assert.equal(debts.parts(offOnly).daysSince, null);
});

/* ========================= 28 — סימן אחד לפוסט ========================= */

test('28 — הצעת החלפה פתוחה מכסה את "חסר תוכן" של הפוסט שלה', { skip }, async () => {
  const id = await post({ title: 'בלי תוכן בקרוב', content: null, at: 120, channel: ids.wa, endpoint: null });
  const { buildAlerts } = await import('../src/alerts.js');
  let { alerts } = await inOrg(() => buildAlerts(null));
  assert.ok(alerts.some((a) => a.id === `no-text-${id}`));
  await q1("insert into tasks (title, kind, post_id) values ('הצעה', 'swap', $1) returning id", [id]);
  ({ alerts } = await inOrg(() => buildAlerts(null)));
  assert.ok(!alerts.some((a) => a.id === `no-text-${id}`));
});

/* ========================= 27 — רשימת המשימות ========================= */

test('27 — המונה סופר רק "דורש טיפול" (היום/באיחור/בלי יעד); דחוף של מערכת לפי היעד; פג תוקף בנפרד', { skip }, async () => {
  await freshOrg('tasks-list-test');
  const ins = (kind, due, x = {}) => q1(
    `insert into tasks (title, kind, due_on, urgent, done, done_at, meta, post_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [`${kind} ${due}`, kind, due, x.urgent ?? true, x.done ?? false, x.done ? new Date() : null,
     x.meta ?? null, x.post ?? null]);
  const today = ymdOf(new Date());
  const later = ymdOf(dayAt(12, 5));
  const earlier = ymdOf(dayAt(12, -1));
  const soonPost = await post({ title: 'בעוד 3 ימים', at: 60 * 24 * 3, channel: ids.wa, status: 'pending_approval' });
  const t = {
    todayWrite: (await ins('write', today)).id,
    lateSwap: (await ins('swap', earlier)).id,
    soonSwap: (await ins('swap', later)).id,                                       // בקרוב, לא דחוף
    approveSoon: (await ins('approve', null, { post: soonPost })).id,              // יעד = יום הפוסט
    manual: (await ins('general', null, { urgent: false })).id,                    // בלי יעד — דורש טיפול
    expired: (await ins('publish', earlier, { done: true, meta: { publish_day: true, auto_closed: 'expired' } })).id,
  };
  const c = await call('GET', '/tasks/count');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(c.json, { open_count: 3, urgent_count: 2 });

  const g = (await call('GET', '/tasks')).json;
  assert.deepEqual(g.today.map((x) => x.id), [t.todayWrite]);
  assert.deepEqual(g.attention.map((x) => x.id).sort((a, b) => a - b), [t.lateSwap, t.manual]);
  assert.deepEqual(g.upcoming.map((x) => x.id).sort((a, b) => a - b), [t.soonSwap, t.approveSoon]);
  assert.equal(g.upcoming.find((x) => x.id === t.soonSwap).urgent, false);
  assert.equal(g.open_count, 3);
  assert.ok(!g.done_this_week.some((x) => x.id === t.expired));
  assert.deepEqual(g.expired_this_week.map((x) => x.id), [t.expired]);
});

/* ========================= 29 + קבלה: שבוע ידני רגיל ========================= */

test('29 — נקודה לא מפרסמת: שקט כשפוסט חי מתוכנן בתוך הקצב; warn מעל הקצב; crit בכפול', { skip }, async () => {
  const day = 60 * 24;
  const ep = async (n) => (await q1(
    "insert into endpoints (name, importance, created_at) values ($1, 9, now() - interval '60 days') returning id",
    [n])).id; // חשיבות 9 → כל 7 ימים
  const coming = await ep('בדרך');
  const warn = await ep('מעל הקצב');
  const crit = await ep('בכפול');
  await post({ title: 'פורסם מזמן', endpoint: coming, at: -20 * day, status: 'published', channel: ids.wa });
  await post({ title: 'בעוד 3 ימים', endpoint: coming, at: 3 * day, channel: ids.wa });
  await inOrg(() => db.query(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, published_at, status) values
       ($1, $2, 'לפני 9 ימים', 'value', now() - interval '9 days', now() - interval '9 days', 'published'),
       ($1, $3, 'לפני 15 יום', 'value', now() - interval '15 days', now() - interval '15 days', 'published')`,
    [ids.wa, warn, crit]));
  const { buildAlerts } = await import('../src/alerts.js');
  const { alerts } = await inOrg(() => buildAlerts(null));
  const level = (id) => alerts.find((a) => a.id === `endpoint-air-${id}`)?.level ?? null;
  assert.equal(level(coming), null);
  assert.equal(level(warn), 'warn');
  assert.equal(level(crit), 'crit');
});

test('קבלה — שבוע ידני רגיל (25 פוסטים, רובם לא סומנו): התראה מרוכזת אחת, משימות להיום, בלי "לא מפרסמת" חוסם ובלי קצב', { skip }, async () => {
  await freshOrg('manual-week-test');
  const runner = await import('../src/publish/runner.js');
  const { buildAlerts } = await import('../src/alerts.js');
  // קמפיין שרץ (התחיל לפני שבוע, נגמר בעוד שלושה) על שני הערוצים, וכל פוסט עם תוכן משלו.
  // מרווח 7 על הקמפיין — הקצב שהשבוע הידני הזה בנוי עליו (פוסט בשבוע לנקודה×ערוץ);
  // ברירת המחדל נגזרת עכשיו מהערוץ (סעיף 5) ודורשת יותר פוסטים מהשבוע הזה
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, min_gap_days)
     values ($1, 'השקה', current_date - 7, current_date + 21, 'general', 7) returning id`, [ids.ep])).id;
  await inOrg(async () => {
    for (const ch of [ids.fb, ids.wa]) {
      await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [camp, ch]);
    }
  });
  const item = async (i, ch, ep, campaign) => {
    const c = (await q1(
      `insert into content_items (endpoint_id, kind, title, campaign_id, slot_channel_id, sort_order)
       values ($1,'value',$2,$3,$4,$5) returning id`, [ep, `פריט ${i}`, campaign, campaign ? ch : null, i])).id;
    await inOrg(() => db.query(
      "insert into content_variants (content_id, channel_id, status, body) values ($1,$2,'ready','טקסט')", [c, ch]));
    return c;
  };
  // 25 פוסטים, מ-7 ימים אחורה ועד 7 קדימה, בשני הערוצים ובשתי הנקודות; 3 סומנו "פורסם"
  const todays = [];
  for (let i = 0; i < 25; i += 1) {
    const d = -7 + Math.floor(i * 14 / 25);
    const ch = i % 2 ? ids.wa : ids.fb;
    const ep = i % 3 === 0 ? ids.ep2 : ids.ep;
    const content = await item(i, ch, ep, ep === ids.ep ? camp : null);
    const when = dayAt(10 + (i % 8), d);
    const marked = d < 0 && i % 7 === 0;
    const id = await post({ title: `פוסט ${i}`, channel: ch, endpoint: ep, content,
      at: minutesUntil(when), status: marked ? 'published' : 'scheduled' });
    if (marked) await inOrg(() => db.query('update posts set published_at = scheduled_at where id = $1', [id]));
    if (d === 0) todays.push(id);
  }

  await runner.manualPublishPrep(org, dayAt(8));
  for (const id of todays) assert.equal((await dayTasks(id)).length, 1, `משימה להיום לפוסט ${id}`);

  const { alerts } = await inOrg(() => buildAlerts(null));
  const ids2 = alerts.map((a) => `${a.id}:${a.level}`);
  assert.equal(alerts.filter((a) => a.id === 'unconfirmed').length, 1, ids2.join(' | '));
  assert.ok(!alerts.some((a) => a.id.startsWith('endpoint-air-') && a.level === 'crit'), ids2.join(' | '));
  assert.ok(!alerts.some((a) => a.id === `campaign-pace-${camp}`), ids2.join(' | '));
  assert.ok(!alerts.some((a) => a.id.startsWith('post-missed-')));
});
