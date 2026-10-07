import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * הזזת קמפיין בזמן (PATCH /campaigns/:id עם starts_on חדש) מול Postgres
 * אמיתי: פוסט זז רק לאן שהמנוע היה משבץ אותו — לא לעבר, לא ליום חסום, לא
 * ליום של פוסט אחר של אותה נקודה באותו ערוץ. מה שלא מתאים יורד מהלוח
 * והמילוי של הקמפיין משבץ אותו מחדש. פורסם לא זז לעולם.
 *
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<מסד> \
 *     TZ=Asia/Jerusalem node --test test/campaign-shift-db.test.js
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
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
const q = (sql, params) => inOrg(() => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: campaigns } = await import('../src/routes/campaigns.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('campaign-shift-test') returning id")).rows[0].id;
  // מרווח כללי של יום — אותו יום אסור, כל יום אחר מותר
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));

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
  app.use(campaigns);
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

const { ymd } = await import('../src/board.js');
/** YYYY-MM-DD בעוד n ימים (זמן מקומי) */
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
/** מועד בעוד n ימים בשעה h מקומית */
const at = (n, h = 10) => new Date(`${inDays(n)}T${String(h).padStart(2, '0')}:00:00`);

/**
 * נקודה, ערוץ וקמפיין כללי חדשים, ופוסט לכל אחד מ-posts: {day, status?}.
 * לכל פוסט פריט תוכן משלו (מוכן לערוץ), כדי שהמילוי יוכל לשבץ אותו מחדש.
 */
async function setup(name, { starts, ends, posts, blockedDays = [], gap = null }) {
  return inOrg(async () => {
    const ep = (await db.one(
      'insert into endpoints (name, importance) values ($1, 5) returning id', [name])).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct, blocked_days)
       values ($1, 'manual', 7, 0, $2) returning id`, [`ערוץ ${name}`, blockedDays])).id;
    const camp = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct, structure, min_gap_days)
       values ($1, $2, $3, $4, 100, 'general', $5) returning id`,
      [ep, name, inDays(starts), inDays(ends), gap])).id;
    await db.query('insert into campaign_channels values ($1, $2)', [camp, ch]);
    const out = [];
    for (const [i, p] of posts.entries()) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order, slot_channel_id)
         values ($1, $2, 'value', $3, $4, $5) returning id`, [ep, camp, `${name} ${i + 1}`, i + 1, ch]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status)
         values ($1, $2, 'x', 'ready')`, [it.id, ch]);
      const post = await db.one(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status,
                            published_at)
         values ($1, $2, $3, $4, 'value', $5, $6, case when $6 = 'published' then now() end)
         returning id`,
        [ch, ep, it.id, `${name} ${i + 1}`, at(p.day, p.hour ?? 10), p.status ?? 'scheduled']);
      out.push({ post: post.id, content: it.id });
    }
    return { ep, ch, camp, posts: out };
  });
}

async function cleanup({ ep, ch }) {
  await inOrg(async () => {
    await db.query('delete from posts where channel_id = $1 or endpoint_id = $2', [ch, ep]);
    await db.query('delete from content_items where endpoint_id = $1', [ep]);
    await db.query('delete from campaigns where endpoint_id = $1', [ep]);
    await db.query('delete from channels where id = $1', [ch]);
    await db.query('delete from endpoints where id = $1', [ep]);
  });
}

const postsOf = (contentId) => q(
  'select id, status, scheduled_at from posts where content_id = $1 order by scheduled_at', [contentId]);

test('הזזה אחורה: שום פוסט לא נוחת בעבר — מה שהיה נוחת שם משובץ מחדש בעתיד', { skip }, async () => {
  const x = await setup('אחורה', {
    starts: 3, ends: 30,
    posts: [{ day: 4, status: 'approved' }, { day: 12 }],
  });
  const startedAt = new Date();
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(-5) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // 4 → ‎-4 (עבר) יורד; 12 → 4 זז
  assert.deepEqual(r.json.shift, { moved: 1, rescheduled: 1, approved: 1 });
  assert.equal(r.json.moved_posts, 1);

  const all = await q(
    `select p.id, p.status, p.scheduled_at from posts p
       join content_items ci on ci.id = p.content_id where ci.campaign_id = $1`, [x.camp]);
  for (const p of all) {
    assert.ok(new Date(p.scheduled_at) > startedAt, `פוסט ${p.id} בעבר: ${p.scheduled_at}`);
  }
  // הפוסט שזז — אותה שורה, 8 ימים קודם, באותה שעה
  const moved = await q1('select scheduled_at from posts where id = $1', [x.posts[1].post]);
  assert.equal(ymd(new Date(moved.scheduled_at)), inDays(4));
  assert.equal(new Date(moved.scheduled_at).getHours(), 10);
  // המאושר ירד מהלוח, והתוכן שלו חזר בשיבוץ חדש (מתוכנן — בלי האישור)
  assert.equal(await q1('select id from posts where id = $1', [x.posts[0].post]), null);
  const again = await postsOf(x.posts[0].content);
  assert.equal(again.length, 1, 'התוכן שובץ מחדש');
  assert.equal(again[0].status, 'scheduled');
  assert.ok(new Date(again[0].scheduled_at) > startedAt);
  await cleanup(x);
});

test('הזזה ליום חסום בערוץ: הפוסט משובץ מחדש ביום מותר', { skip }, async () => {
  const blocked = new Date(`${inDays(12)}T12:00:00`).getDay();
  const x = await setup('חסום', {
    starts: 1, ends: 40, blockedDays: [blocked],
    posts: [{ day: 5 }],
  });
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(8) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.shift, { moved: 0, rescheduled: 1, approved: 0 });
  assert.equal(await q1('select id from posts where id = $1', [x.posts[0].post]), null);
  const again = await postsOf(x.posts[0].content);
  assert.equal(again.length, 1, 'התוכן שובץ מחדש');
  const day = new Date(again[0].scheduled_at);
  assert.notEqual(day.getDay(), blocked, `נחת על יום חסום: ${again[0].scheduled_at}`);
  assert.ok(ymd(day) >= inDays(8), 'בתוך החלון החדש');
  await cleanup(x);
});

test('הזזה ליום של פוסט מקמפיין אחר של אותה נקודה באותו ערוץ: משובץ מחדש ביום אחר', { skip }, async () => {
  const x = await setup('התנגשות', { starts: 1, ends: 40, posts: [{ day: 5 }] });
  // קמפיין שני של אותה נקודה, עם פוסט ב-12 באותו ערוץ
  const other = await inOrg(async () => {
    const c = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure)
       values ($1, 'אחר', $2, $3, 'general') returning id`, [x.ep, inDays(1), inDays(40)]);
    const it = await db.one(
      `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
       values ($1, $2, 'value', 'אחר', 1) returning id`, [x.ep, c.id]);
    return db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
       values ($1, $2, $3, 'אחר', 'value', $4) returning id`, [x.ch, x.ep, it.id, at(12, 15)]);
  });
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(8) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.shift, { moved: 0, rescheduled: 1, approved: 0 });
  const again = await postsOf(x.posts[0].content);
  assert.equal(again.length, 1, 'התוכן שובץ מחדש');
  assert.notEqual(ymd(new Date(again[0].scheduled_at)), inDays(12), 'לא באותו יום כמו האחר');
  // הפוסט של הקמפיין האחר לא נגע
  const kept = await q1('select scheduled_at from posts where id = $1', [other.id]);
  assert.equal(new Date(kept.scheduled_at).getTime(), at(12, 15).getTime());
  await cleanup(x);
});

test('הזזה קדימה בלי התנגשויות: הכול זז באותה שעה, ומאושר נשאר מאושר', { skip }, async () => {
  const x = await setup('קדימה', {
    starts: 2, ends: 30,
    posts: [{ day: 3, status: 'approved', hour: 9 }, { day: 6 }, { day: 9, status: 'pending_approval' }],
  });
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(9) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.shift, { moved: 3, rescheduled: 0, approved: 0 });
  const rows = await q('select id, status, scheduled_at from posts where id = any($1::int[]) order by id',
    [x.posts.map((p) => p.post)]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'approved');
  assert.equal(rows[2].status, 'pending_approval');
  assert.equal(new Date(rows[0].scheduled_at).getTime(), at(10, 9).getTime());
  assert.equal(new Date(rows[1].scheduled_at).getTime(), at(13).getTime());
  assert.equal(new Date(rows[2].scheduled_at).getTime(), at(16).getTime());
  await cleanup(x);
});

test('פורסם לא זז — לא קדימה ולא אחורה', { skip }, async () => {
  const x = await setup('פורסם', {
    starts: 2, ends: 30,
    posts: [{ day: 3, status: 'published' }, { day: 6 }],
  });
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(5) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.shift, { moved: 1, rescheduled: 0, approved: 0 });
  const pub = await q1('select status, scheduled_at from posts where id = $1', [x.posts[0].post]);
  assert.equal(pub.status, 'published');
  assert.equal(new Date(pub.scheduled_at).getTime(), at(3).getTime());

  const back = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: inDays(3) });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  const still = await q1('select scheduled_at from posts where id = $1', [x.posts[0].post]);
  assert.equal(new Date(still.scheduled_at).getTime(), at(3).getTime());
  await cleanup(x);
});

test('תאריך שבור בעריכה — 400 עם הודעה, לא 500', { skip }, async () => {
  const x = await setup('תאריך', { starts: 2, ends: 30, posts: [] });
  const r = await call('PATCH', `/campaigns/${x.camp}`, { starts_on: '2030-02-31' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /לא תקין/);
  const r2 = await call('PATCH', `/campaigns/${x.camp}`, { ends_on: 'מחר' });
  assert.equal(r2.status, 400);
  await cleanup(x);
});
