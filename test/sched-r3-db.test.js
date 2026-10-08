import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * סריקה שנייה של מערכת השיבוץ, סבב 3 (docs/scheduling-overhaul.md) מול
 * Postgres אמיתי: "בטל" על מילוי לא מוחק פוסט שנערך, סוג ונקודת קצה שעוברים
 * לפוסטים, בדיקות אותו-יום/מרווח/מכסות בשינוי נקודה/סוג/תוכן של פוסט, מרווח
 * בימי ישראל, ו-applyRespace שסופר רק מה שנכתב.
 *
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<מסד> \
 *     TZ=Asia/Jerusalem node --test --test-concurrency=1 test/sched-r3-db.test.js
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
const q1 = (sql, params) => inOrg(() => db.one(sql, params));
const q = (sql, params) => inOrg(() => db.rows(sql, params));

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: content } = await import('../src/routes/content.js');
  const { default: board } = await import('../src/routes/board.js');
  const { default: engine } = await import('../src/routes/engine.js');

  // migrate רק כשהעמודה עוד לא קיימת (קובצי מסד אחרים רצים על אותו מסד)
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'posts' and column_name = 'updated_at'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('sched-r3-test') returning id")).rows[0].id;
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
  app.use(content);
  app.use(board);
  app.use(engine);
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

/** נקודה וערוץ חדשים לכל בדיקה — שום דבר לא דולף בין בדיקות */
async function fresh(name, { maxPerWeek = 7, maxValue = null } = {}) {
  return inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id',
      [name])).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct, max_value_per_week)
       values ($1, 'manual', $2, 0, $3) returning id`, [`ערוץ ${name}`, maxPerWeek, maxValue])).id;
    return { ep, ch };
  });
}

/** פוסט על הלוח של הנקודה בערוץ */
const post = (x, { day, h = 10, content = null, kind = 'value', title = 'פוסט', status = 'scheduled',
                   endpoint = x.ep } = {}) => q1(
  `insert into posts (channel_id, endpoint_id, content_id, kind, title, status, scheduled_at)
   values ($1, $2, $3, $4, $5, $6, $7) returning *`,
  [x.ch, endpoint, content, kind, title, status, at(day, h)]);

/* ========================= א: "בטל" על מילוי ========================= */

test('בטל: פוסט שנגרר / ששינו לו כותרת אחרי המילוי נשאר; פוסט שלא נגעו בו — נמחק', { skip }, async () => {
  const x = await fresh('בטל');
  // "המילוי": שלושה פוסטים בטרנזקציה אחת (כמו applyWeek בבקשה אחת)
  const [a, b, c] = await inOrg(async () => {
    const out = [];
    for (const [i, title] of ['א', 'ב', 'ג'].entries()) {
      out.push(await db.one(
        `insert into posts (channel_id, endpoint_id, kind, title, status, scheduled_at)
         values ($1, $2, 'value', $3, 'scheduled', $4) returning id, content_id, created_at, updated_at`,
        [x.ch, x.ep, title, at(3 + i * 2)]));
    }
    return out;
  });
  assert.equal(+a.updated_at, +a.created_at);

  // ב — נגרר ליום אחר; ג — כותרת חדשה
  const moved = await call('PATCH', `/posts/${b.id}`, { scheduled_at: at(4).toISOString() });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const retitled = await call('PATCH', `/posts/${c.id}`, { title: 'כותרת שלי' });
  assert.equal(retitled.status, 200, JSON.stringify(retitled.json));

  const created = [a, b, c].map((p) => ({ post_id: p.id, content_id: p.content_id }));
  const r = await call('POST', '/engine/undo', { created });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.removed, 1);
  assert.equal(r.json.kept, 2);
  const left = (await q('select id from posts where id = any($1::int[]) order by id',
    [[a.id, b.id, c.id]])).map((p) => p.id);
  assert.deepEqual(left, [b.id, c.id]);
});

/* ========================= ד: מרווח בימי ישראל ========================= */

test('gapWarning: פוסט ב-01:00 בישראל נמדד ליום שלו גם כשהחיבור ב-UTC', { skip }, async () => {
  const { gapWarning } = await import('../src/gap.js');
  const x = await fresh('מרווח 01');
  const near = await post(x, { day: 11, h: 1 });   // 01:00 בישראל = 22:00 UTC יום קודם
  await inOrg(async () => {
    // החיבור בפרודקשן ב-UTC (מסד הבדיקה מקומי בשעון ישראל)
    await db.query("set local timezone = 'UTC'");
    // מרווח 2 של קמפיין
    const camp = await db.one(
      `insert into campaigns (endpoint_id, name, min_gap_days) values ($1, 'מרווח 2', 2) returning id`,
      [x.ep]);
    const base = { endpointId: x.ep, channelId: x.ch, campaignId: camp.id };
    // יום אחד לפני (10:00) — בתוך המרווח: אזהרה של יום אחד
    const w = await gapWarning({ ...base, when: at(10).toISOString() });
    assert.ok(w, 'צריך אזהרה — הפוסט יום אחרי');
    assert.equal(w.days, 1);
    assert.equal(w.other.id, near.id);
    // יומיים לפני — מחוץ למרווח (ב-UTC היה נראה כיום אחד)
    assert.equal(await gapWarning({ ...base, when: at(9).toISOString() }), null);
    await db.query('delete from campaigns where id = $1', [camp.id]);
  });
});

/* ========================= ה: applyRespace ========================= */

test('applyRespace סופר רק מה שנכתב: פוסט שבינתיים בפרסום — 0', { skip }, async () => {
  const { applyRespace } = await import('../src/respace.js');
  const x = await fresh('ריווח');
  const p = await post(x, { day: 5, status: 'publishing' });
  const s = await post(x, { day: 6 });
  const move = (row, toDay) => ({
    post: row, from: ymd(new Date(row.scheduled_at)), dateKey: inDays(toDay), hour: 10, to: at(toDay),
  });
  const n = await inOrg(() => applyRespace([move(p, 7), move(s, 8)]));
  assert.equal(n, 1);
  const after = await q1('select scheduled_at from posts where id = $1', [p.id]);
  assert.equal(+after.scheduled_at, +at(5));
});

/* ========================= ג: שינוי נקודה / סוג / תוכן בלי הזזה ========================= */

test('PATCH /posts: נקודת קצה אחרת שכבר יש לה פוסט באותו יום בערוץ — נחסם, גם בהחלפת תוכן', { skip }, async () => {
  const x = await fresh('נקודה אחרת');
  const other = (await q1("insert into endpoints (name, importance) values ('נקודה ב', 5) returning id")).id;
  await post(x, { day: 5, title: 'קיים' });
  const mine = await post(x, { day: 5, h: 14, endpoint: other, title: 'שלי' });

  const r = await call('PATCH', `/posts/${mine.id}`, { endpoint_id: x.ep });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /באותו יום: קיים/);

  // החלפת תוכן ממשימת תחזוקה: content_id + endpoint_id בבקשה אחת
  const it = await q1(
    `insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'מוצע') returning id`, [x.ep]);
  const swap = await call('PATCH', `/posts/${mine.id}`,
    { content_id: it.id, endpoint_id: x.ep, title: 'מוצע', kind: 'value', confirm_warnings: true });
  assert.equal(swap.status, 400, JSON.stringify(swap.json));
  const row = await q1('select endpoint_id, content_id from posts where id = $1', [mine.id]);
  assert.deepEqual(row, { endpoint_id: other, content_id: null });

  // נקודה בלי פוסט באותו יום — עובר
  const ok = await call('PATCH', `/posts/${mine.id}`, { title: 'רק כותרת' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('PATCH /posts: סוג אחר שחורג מהתקרה לסוג — אזהרה שאפשר לאשר', { skip }, async () => {
  const x = await fresh('סוג', { maxValue: 1 });
  const other = (await q1("insert into endpoints (name, importance) values ('נקודה ג', 5) returning id")).id;
  await post(x, { day: 5, kind: 'value' });
  const promo = await post(x, { day: 5, h: 14, kind: 'promo', endpoint: other });

  const r = await call('PATCH', `/posts/${promo.id}`, { kind: 'value' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.needs_confirm, true);
  assert.match(r.json.error, /פוסטים מסוג ערך/);
  const ok = await call('PATCH', `/posts/${promo.id}`, { kind: 'value', confirm_warnings: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.post.kind, 'value');
});
