import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 7 בשיפורי ההתנהגות (docs/behavior-improvements.md) — סעיפים 30–32 מול
 * Postgres אמיתי:
 *   30. אישור רק כשיש מה להגן עליו: ערוץ בלי פרסום אוטומטי — 409; הלוח
 *       אומר כמה ערוצים מתפרסמים לבד ("אשר את השבוע" רק כשיש).
 *   31. שינוי תוכן אחרי אישור מחזיר את הפוסטים המאושרים לאישור (טביעה
 *       בזמן האישור), והטיק מסרב לפרסם כשהטביעה לא תואמת.
 *   32. ניסיון חוזר אחד על דחייה זמנית מפורשת; כשל תצורה מרוכז; משימת
 *       "להעביר ל-HUB" יממה לפני ניוזלטר.
 * הנתיבים רצים באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת.
 *
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/autopublish-gate-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, runner, server, base, org, ids;
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
const setAuto = (on) => inOrg(() => db.query('update engine_settings set autopublish_enabled = $1', [on]));
const postRow = (id) => q1('select * from posts where id = $1', [id]);

/** תוכן חדש עם גרסה מוכנה לערוץ. channel — ברירת מחדל: הפייסבוק המחובר */
async function content({ channel = ids.fb, body = 'טקסט מוכן', title = 'תוכן' } = {}) {
  return inOrg(async () => {
    const ci = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', $2) returning id",
      [ids.ep, title])).id;
    await db.query(
      `insert into content_variants (content_id, channel_id, status, body, meta)
       values ($1,$2,'ready',$3,'{"subject":"נושא"}')`, [ci, channel, body]);
    return ci;
  });
}

/** פוסט ישירות במסד. at — דקות מעכשיו (שלילי = עבר) */
async function post({ channel = ids.fb, contentId, title = 'פוסט', at = 60 * 24 * 3,
                      status = 'scheduled' } = {}) {
  return (await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
     values ($1,$2,$3,$4,'value',$5,$6) returning id`,
    [channel, ids.ep, contentId ?? null, title, minutes(at), status])).id;
}

/** אישור דרך הנתיב — כך נשמרת הטביעה כמו בשימוש אמיתי */
async function approve(id) {
  const r = await call('POST', `/posts/${id}/approve-publish`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.post;
}

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  runner = await import('../src/publish/runner.js');
  const { encryptSecret } = await import('../src/publish/crypto.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');
  const { default: publish } = await import('../src/routes/publish.js');
  const { default: contentRoutes } = await import('../src/routes/content.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('autopublish-gate-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings (autopublish_enabled) values (true)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const fb = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 14) returning id")).id;
    const wa = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('וואטסאפ', 'whatsapp', 14) returning id")).id;
    const fbOff = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק ב', 'facebook', 14) returning id")).id;
    const nl = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('ניוזלטר', 'newsletter', 14) returning id")).id;
    await db.query(
      `insert into channel_connections (channel_id, page_id, access_token_enc, auto_enabled, last_check_ok)
       values ($1, '9', $2, true, true), ($3, '8', $2, false, true)`, [fb, encryptSecret('tok'), fbOff]);
    return { ep, fb, wa, fbOff, nl };
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
  app.use(publish);
  app.use(contentRoutes);
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

/* ========================= 30 — אישור רק כשיש מה להגן עליו ========================= */

test('30 — אישור בערוץ בלי פרסום אוטומטי (וואטסאפ, חיבור כבוי) — 409 עם הסבר; ערוץ אוטומטי — מאושר', { skip }, async () => {
  const wa = await post({ channel: ids.wa, contentId: await content({ channel: ids.wa }) });
  const off = await post({ channel: ids.fbOff, contentId: await content({ channel: ids.fbOff }) });
  for (const id of [wa, off]) {
    const r = await call('POST', `/posts/${id}/approve-publish`);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /הפרסום האוטומטי לא מופעל לערוץ הזה/);
    assert.equal((await postRow(id)).status, 'scheduled');
  }
  const ok = await post({ contentId: await content() });
  assert.equal((await approve(ok)).status, 'approved');
});

test('30 — הלוח: autopublish_channels סופר רק ערוצים פעילים שמתפרסמים לבד; מאושר בערוץ כבוי מסומן', { skip }, async () => {
  const week = minutes(60 * 24 * 3).slice(0, 10);
  const id = await post({ channel: ids.fbOff, contentId: await content({ channel: ids.fbOff }),
                          status: 'approved' });
  const r = await call('GET', `/board?week=${week}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.autopublish_channels, 1);
  const card = r.json.channels.flatMap((c) => c.days.flatMap((d) => d.posts)).find((p) => p.id === id);
  assert.equal(card.channel_auto, false);

  await inOrg(() => db.query('update channel_connections set auto_enabled = false where channel_id = $1', [ids.fb]));
  try {
    assert.equal((await call('GET', `/board?week=${week}`)).json.autopublish_channels, 0);
  } finally {
    await inOrg(() => db.query('update channel_connections set auto_enabled = true where channel_id = $1', [ids.fb]));
  }
});
