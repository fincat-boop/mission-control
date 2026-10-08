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

/* ========================= 31 — שינוי תוכן אחרי אישור ========================= */

/** פוסטים מאושרים אחרים לא יוצאים בטיק של הבדיקה */
async function onlyThese(...keep) {
  await inOrg(() => db.query(
    `update posts set status = 'scheduled' where status in ('approved', 'publishing') and not (id = any($1))`,
    [keep]));
}

/** Graph מדומה: כל קריאה מצליחה (או לפי onCall) ונרשמת */
async function withGraph(onCall, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const path = new URL(u).pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ path });
    const out = await onCall?.(path, calls.length);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ id: `9_${calls.length}` }), { status: 200 });
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return calls;
}

/** פוסט מאושר (דרך הנתיב) על תוכן חדש — מחזיר { ci, id } */
async function approvedPost(opts = {}) {
  const ci = await content(opts);
  const id = await post({ contentId: ci, at: opts.at ?? 60 * 24 * 3 });
  await approve(id);
  return { ci, id };
}

const putVariant = (ci, body) => call('PUT', `/content/${ci}/variants/${ids.fb}`, body);

test('31 — שינוי טקסט בגרסה: מאושר עתידי חוזר לאישור (approval_reset); שמירה בלי שינוי — לא', { skip }, async () => {
  const { ci, id } = await approvedPost();
  const same = await putVariant(ci, { body: 'טקסט מוכן', status: 'ready' });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.equal(same.json.approval_reset, 0);
  assert.equal((await postRow(id)).status, 'approved');

  const r = await putVariant(ci, { body: 'טקסט אחר', status: 'ready' });
  assert.equal(r.json.approval_reset, 1);
  const p = await postRow(id);
  assert.equal(p.status, 'scheduled');
  assert.equal(p.approved_at, null);
  assert.equal(p.approved_digest, null);
});

test('31 — meta (תגובה ראשונה) וחזרה לטיוטה מחזירים לאישור', { skip }, async () => {
  const a = await approvedPost();
  const r1 = await putVariant(a.ci, { status: 'ready', meta: { first_comment: 'תגובה' } });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.approval_reset, 1);
  assert.equal((await postRow(a.id)).status, 'scheduled');

  const b = await approvedPost();
  const r2 = await putVariant(b.ci, { status: 'draft' });
  assert.equal(r2.json.approval_reset, 1);
  assert.equal((await postRow(b.id)).status, 'scheduled');
});

test('31 — קובץ שנוסף או נמחק מחזיר לאישור; מה שעבר / פורסם לא זז', { skip }, async () => {
  const { ci, id } = await approvedPost();
  // פוסטים נוספים על אותו תוכן: מאושר שהמועד שלו עבר, ופורסם
  const past = await post({ contentId: ci, at: -60, status: 'approved' });
  const pub = await post({ contentId: ci, at: -60 * 24, status: 'published' });

  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'a.png');
  const res = await fetch(`${base}/content/${ci}/variants/${ids.fb}/assets`, { method: 'POST', body: fd });
  const up = await res.json();
  await Promise.all([...pending]);
  assert.equal(res.status, 201, JSON.stringify(up));
  assert.equal(up.approval_reset, 1);
  assert.equal((await postRow(id)).status, 'scheduled');
  assert.equal((await postRow(past)).status, 'approved');
  assert.equal((await postRow(pub)).status, 'published');
  await inOrg(() => db.query("update posts set status = 'scheduled' where id = $1", [past]));

  // אישור מחדש עם הקובץ — ואז מחיקתו
  await approve(id);
  const del = await call('DELETE', `/assets/${up.assets[0].id}`);
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(del.json.approval_reset, 1);
  assert.equal((await postRow(id)).status, 'scheduled');
});

test('31 — משבצת מקושרת: עריכה במקור מחזירה לאישור את הפוסט של העוקבת', { skip }, async () => {
  const { src, fol } = await inOrg(async () => {
    const camp = (await db.one(
      `insert into campaigns (name, endpoint_id, structure, starts_on, ends_on)
       values ('כללי', $1, 'general', current_date, current_date + 30) returning id`, [ids.ep])).id;
    for (const ch of [ids.wa, ids.fb]) {
      await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [camp, ch]);
    }
    const s = (await db.one(
      `insert into content_items (endpoint_id, campaign_id, slot_channel_id, sort_order, kind, title)
       values ($1,$2,$3,1,'value','מקור') returning id`, [ids.ep, camp, ids.wa])).id;
    const f = (await db.one(
      `insert into content_items (endpoint_id, campaign_id, slot_channel_id, sort_order, kind, title, linked_to_id)
       values ($1,$2,$3,1,'value','מקור',$4) returning id`, [ids.ep, camp, ids.fb, s])).id;
    await db.query(
      `insert into content_variants (content_id, channel_id, status, body) values ($1,$2,'ready','משותף'),
              ($3,$4,'ready','משותף')`, [s, ids.wa, f, ids.fb]);
    return { src: s, fol: f };
  });
  const id = await post({ contentId: fol });
  await approve(id);

  const r = await call('PUT', `/content/${src}/variants/${ids.wa}`, { body: 'משותף — מתוקן', status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.approval_reset, 1);
  assert.equal((await postRow(id)).status, 'scheduled');
});

test('31 — הטיק: טביעה שלא תואמת (שינוי שעקף את הנתיבים) — לא מפרסם; חוזר למתוכנן עם "לאשר מחדש"', { skip }, async () => {
  const { ci, id } = await approvedPost();
  // שינוי ישיר במסד (כמו ייבוא) ומועד שהגיע
  await inOrg(() => db.query(
    `update content_variants set body = 'שונה בשקט' where content_id = $1 and channel_id = $2`, [ci, ids.fb]));
  await inOrg(() => db.query(`update posts set scheduled_at = now() - interval '1 minute' where id = $1`, [id]));
  await onlyThese(id);

  const calls = await withGraph(null, () => runner.publishTickForOrg(org));
  assert.equal(calls.length, 0, 'שום דבר לא נשלח');
  const p = await postRow(id);
  assert.equal(p.status, 'scheduled');
  assert.equal(p.approved_at, null);
  assert.equal(p.publishing_started_at, null);
  const tasks = await qa(`select title, done from tasks where post_id = $1 and kind = 'approve'
                            and meta->>'reapprove' = 'true'`, [id]);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /לאשר מחדש/);
  // סימן אחד: לא נכנס ל"לא סומנו כפורסמו" כל עוד המשימה פתוחה
  await inOrg(() => db.query(`update posts set scheduled_at = now() - interval '2 hours' where id = $1`, [id]));
  const { unconfirmedPosts } = await import('../src/unconfirmed.js');
  assert.equal((await inOrg(() => unconfirmedPosts())).some((x) => x.id === id), false);
  await inOrg(() => db.query('delete from posts where id = $1', [id]));
});

test('31 — הטיק: טביעה תואמת — מפרסם כרגיל', { skip }, async () => {
  const { id } = await approvedPost();
  await inOrg(() => db.query(`update posts set scheduled_at = now() - interval '1 minute' where id = $1`, [id]));
  await onlyThese(id);
  const calls = await withGraph(null, () => runner.publishTickForOrg(org));
  assert.ok(calls.some((c) => c.path === '9/feed'));
  assert.equal((await postRow(id)).status, 'published');
});
