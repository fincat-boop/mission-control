import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 3 של מערכת השיבוץ (docs/scheduling-overhaul.md) מול Postgres אמיתי:
 * בלי שיבוץ לימים שעברו, ותק (staleness) ביחס לשבוע המתוכנן, ומילוי כל
 * תקופת הקמפיין בשמירה — כולל "בטל" על כל השבועות.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני (אותו דגל כמו שאר בדיקות המסד):
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה, ולכן אפשר להריץ שוב ושוב.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, engine, server, base, org;
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
  engine = await import('../src/engine.js');
  const { default: express } = await import('express');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: content } = await import('../src/routes/content.js');
  const { default: engineRoutes } = await import('../src/routes/engine.js');

  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('fill-period-test') returning id")).rows[0].id;
  // מרווח כללי של יום — כדי שנקודה אחת תוכל לקבל כמה פוסטים בשבוע
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
  app.use(engineRoutes);
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

/** נקודת קצה וערוץ חדשים לכל בדיקה — שום דבר לא דולף בין בדיקות */
async function fresh(name, { importance = 5, maxPerWeek = 7 } = {}) {
  return inOrg(async () => {
    const ep = await db.one(
      'insert into endpoints (name, importance) values ($1, $2) returning id', [name, importance]);
    const ch = await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ($1, 'manual', $2, 0) returning id`, [`ערוץ ${name}`, maxPerWeek]);
    return { ep: ep.id, ch: ch.id };
  });
}

/** פריטי תוכן מוכנים (ערך) לנקודה, בקמפיין או שוטפים */
async function items(endpointId, channelId, n, { campaignId = null, prefix = 'פריט' } = {}) {
  return inOrg(async () => {
    const out = [];
    for (let i = 1; i <= n; i += 1) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
         values ($1,$2,'value',$3,$4) returning id`,
        [endpointId, campaignId, `${prefix} ${i}`, i]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status)
         values ($1,$2,'x','ready')`, [it.id, channelId]);
      out.push(it.id);
    }
    return out;
  });
}

/** מוחק את כל מה שנוצר לנקודה ולערוץ */
async function cleanup({ ep, ch }) {
  await inOrg(async () => {
    await db.query('delete from posts where channel_id = $1 or endpoint_id = $2', [ch, ep]);
    await db.query('delete from content_items where endpoint_id = $1', [ep]);
    await db.query('delete from campaigns where endpoint_id = $1', [ep]);
    await db.query('delete from channels where id = $1', [ch]);
    await db.query('delete from endpoints where id = $1', [ep]);
  });
}

/* ========================= 1. בלי ימים שעברו ========================= */

test('המנוע לא מציע משבצת לפני עכשיו — לא ימים שעברו ולא שעה שעברה היום', { skip }, async () => {
  const x = await fresh('עבר');
  await items(x.ep, x.ch, 7);
  await inOrg(async () => {
    // "עכשיו" = רביעי 20.11.2030 בצהריים: ראשון–שלישי עברו, ו-10:00 של רביעי גם
    const now = new Date('2030-11-20T12:00:00');
    const plan = await engine.planWeek('2030-11-20', { holes: false, now });
    const mine = plan.placements.filter((p) => p.channel_id === x.ch);
    assert.ok(mine.length >= 1, 'משהו נכנס');
    for (const p of mine) {
      assert.ok(p.date > '2030-11-20', `${p.date} כבר עבר`);
      assert.ok(new Date(p.scheduled_at) > now);
    }
  });

  // ביצוע אמיתי על השבוע הנוכחי: אף פוסט לא נכתב לפני עכשיו
  const startedAt = new Date();
  const res = await inOrg(() => engine.applyWeek(startedAt, { holes: false }));
  const created = await q('select scheduled_at from posts where id = any($1::int[])', [res.created_ids]);
  for (const p of created) assert.ok(new Date(p.scheduled_at) > startedAt, String(p.scheduled_at));
  await cleanup(x);
});

/* ========================= 2. ותק ביחס לשבוע המתוכנן ========================= */

const { ymd, weekMeta } = await import('../src/board.js');
/** YYYY-MM-DD בעוד n ימים (זמן מקומי) */
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

test('בלאק פריידי: שבוע עתידי של הקמפיין — הנקודה שפורסמה לאחרונה מקבלת משבצות מול נקודות שמעולם לא פורסמו', { skip }, async () => {
  const week = weekMeta(inDays(42));
  const bf = await fresh('בלאק פריידי', { importance: 9, maxPerWeek: 4 });
  const ch = bf.ch;
  const others = await inOrg(async () => {
    const out = [];
    for (const imp of [8, 7, 6]) {
      out.push((await db.one(
        'insert into endpoints (name, importance) values ($1, $2) returning id',
        [`שוטפת ${imp}`, imp])).id);
    }
    return out;
  });
  const camp = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct)
     values ($1, 'בלאק פריידי', $2, $3, 40) returning id`,
    [bf.ep, week.days[0].date, week.days[6].date]);
  await q('insert into campaign_channels values ($1, $2)', [camp.id, ch]);
  await items(bf.ep, ch, 6, { campaignId: camp.id, prefix: 'מבצע' });
  for (const ep of others) await items(ep, ch, 6, { prefix: `שוטף ${ep}` });
  // הנקודה של הקמפיין פורסמה לפני 3 ימים; האחרות — אף פעם
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, published_at, status)
     values ($1, $2, 'פורסם', 'value', now() - interval '3 days', now() - interval '3 days', 'published')`,
    [ch, bf.ep]);

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === ch);
  const per = (ep) => mine.filter((p) => p.endpoint_id === ep).length;
  assert.equal(mine.length, 4, JSON.stringify(mine.map((p) => p.endpoint_name)));
  // קודם: 0/4 — הוותק נמדד מהיום (3 ימים) מול 2 קבוע לנקודות שלא פורסמו
  assert.ok(per(bf.ep) >= 1, `בלאק פריידי קיבל ${per(bf.ep)}/4`);

  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = any($1::int[])', [others]);
    await db.query('delete from content_items where endpoint_id = any($1::int[])', [others]);
    await db.query('delete from endpoints where id = any($1::int[])', [others]);
  });
  await cleanup(bf);
});

test('פוסט שמשובץ יומיים לפני השבוע המתוכנן — פחות ותק מנקודה בלי כלום 30 יום', { skip }, async () => {
  const week = weekMeta(inDays(7));
  const start = new Date(`${week.days[0].date}T10:00:00`);
  const a = await fresh('יומיים לפני', { maxPerWeek: 1 });
  const b = await inOrg(async () => (await db.one(
    "insert into endpoints (name, importance) values ('חודש בלי', 5) returning id")).id);
  await items(a.ep, a.ch, 2, { prefix: 'א' });
  await items(b, a.ch, 2, { prefix: 'ב' });
  // א: משובץ (לא פורסם) יומיים לפני השבוע. ב: פורסם 30 יום לפני השבוע.
  // הקוד הקודם התעלם מהשיבוץ של א ("עוד לא פורסמה" = 2) — ו-א זכה במשבצת
  const twoBefore = new Date(start.getTime() - 2 * 86400000);
  const monthBefore = new Date(start.getTime() - 30 * 86400000);
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status)
     values ($1, $2, 'משובץ', 'value', $3, 'scheduled')`, [a.ch, a.ep, twoBefore]);
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, published_at, status)
     values ($1, $2, 'פורסם', 'value', $3, $3, 'published')`, [a.ch, b, monthBefore]);

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === a.ch);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].endpoint_id, b, `זכתה ${mine[0].endpoint_name} (${mine[0].reason})`);
  assert.match(mine[0].reason, /(29|30) ימים בלי פרסום/);

  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1', [b]);
    await db.query('delete from content_items where endpoint_id = $1', [b]);
    await db.query('delete from endpoints where id = $1', [b]);
  });
  await cleanup(a);
});

/* ========================= 3. מילוי כל תקופת הקמפיין ========================= */

const { autoFillCampaign, campaignFillWeeks } = await import('../src/routes/_shared.js');
/** תחילת השבוע (YYYY-MM-DD) של פוסט */
const weekOf = (at) => weekMeta(new Date(at)).start;

test('יצירת קמפיין ממלאת את כל השבועות שלו, ו"בטל" אחד מוריד את כולם', { skip }, async () => {
  // ערוץ של פוסט אחד בשבוע — כל שבוע מקבל בדיוק פוסט אחד
  const x = await fresh('שלושה שבועות', { maxPerWeek: 1 });
  await items(x.ep, x.ch, 5);
  // ראשון בעוד 3 שבועות, ועד השבת שאחרי שבועיים — בדיוק 3 שבועות
  const first = weekMeta(inDays(21));
  const ends = weekMeta(inDays(35)).end;
  const r = await call('POST', '/campaigns', {
    endpoint_id: x.ep, name: 'שלושה שבועות', starts_on: first.start, ends_on: ends,
    period: 'custom', channel_ids: [x.ch], week: inDays(0),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const fill = r.json.engine;
  assert.equal(fill.placed, 3, JSON.stringify(fill));
  assert.equal(fill.weeks, 3);
  assert.equal(fill.created_items.length, 3);
  const posts = await q('select id, scheduled_at from posts where id = any($1::int[])', [fill.created_ids]);
  assert.deepEqual([...new Set(posts.map((p) => weekOf(p.scheduled_at)))].sort(),
    campaignFillWeeks({ active: true, starts_on: first.start, ends_on: ends }));

  const undo = await call('POST', '/engine/undo',
    { created: fill.created_items, attached: fill.attached_items });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.equal(undo.json.removed, 3);
  assert.equal((await q('select id from posts where id = any($1::int[])', [fill.created_ids])).length, 0);
  // הוויתור נרשם לכל שבוע בנפרד — המילוי הבא לא מחזיר תוכן לשבוע שממנו בוטל
  const undone = new Set(posts.map((p) =>
    `${fill.created_items.find((c) => c.post_id === p.id).content_id}:${weekOf(p.scheduled_at)}`));
  const again = await inOrg(() => autoFillCampaign(r.json.campaign.id));
  const back = await q('select content_id, scheduled_at from posts where id = any($1::int[])',
    [again.created_ids]);
  for (const p of back) {
    assert.ok(!undone.has(`${p.content_id}:${weekOf(p.scheduled_at)}`), 'תוכן שבוטל חזר לאותו שבוע');
  }
  await cleanup(x);
});

test('תוכן חדש בקמפיין ממלא את כל התקופה — לא רק השבוע שמוצג', { skip }, async () => {
  const x = await fresh('תוכן בקמפיין', { maxPerWeek: 1 });
  const first = weekMeta(inDays(21));
  const ends = weekMeta(inDays(35)).end;
  const c = (await call('POST', '/campaigns', {
    endpoint_id: x.ep, name: 'תוכן בקמפיין', starts_on: first.start, ends_on: ends,
    period: 'custom', channel_ids: [x.ch],
  })).json.campaign;
  const placedWeeks = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await call('POST', '/content', {
      title: `פוסט ${i}`, kind: 'value', campaign_id: c.id, slot_channel_id: x.ch,
      sort_order: i, body: 'טקסט', status: 'ready', week: inDays(0),
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.engine.placed, 1, `פריט ${i}: ${JSON.stringify(r.json.engine)}`);
    const [p] = await q('select scheduled_at from posts where id = $1', [r.json.engine.created_ids[0]]);
    placedWeeks.push(weekOf(p.scheduled_at));
  }
  // השבוע שמוצג (היום) לא בתקופה — הכול נחת בשבועות של הקמפיין, אחד בכל שבוע
  assert.deepEqual(placedWeeks.sort(), [first.start, weekMeta(inDays(28)).start, weekMeta(inDays(35)).start]);
  await cleanup(x);
});

test('קמפיין שכבר רץ: שום פוסט לא נכתב לפני עכשיו', { skip }, async () => {
  const x = await fresh('רץ');
  await items(x.ep, x.ch, 10);
  const started = new Date();
  const r = await call('POST', '/campaigns', {
    endpoint_id: x.ep, name: 'רץ', starts_on: inDays(-10), ends_on: inDays(10),
    period: 'custom', channel_ids: [x.ch],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.engine.placed >= 1);
  const posts = await q('select scheduled_at from posts where id = any($1::int[])', [r.json.engine.created_ids]);
  for (const p of posts) assert.ok(new Date(p.scheduled_at) > started, String(p.scheduled_at));
  await cleanup(x);
});

test('קמפיין מושהה לא מתמלא — גם לא בעריכה שלו', { skip }, async () => {
  const x = await fresh('מושהה');
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, paused_at)
     values ($1, 'מושהה', $2, $3, now()) returning id`, [x.ep, inDays(14), inDays(35)]);
  await q('insert into campaign_channels values ($1, $2)', [c.id, x.ch]);
  const mine = await items(x.ep, x.ch, 4, { campaignId: c.id });
  const r = await call('PATCH', `/campaigns/${c.id}`, { min_gap_days: 2, week: inDays(21) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const direct = await inOrg(() => autoFillCampaign(c.id));
  assert.equal(direct.weeks, undefined, 'בלי תקופה למלא — רק השבוע שמוצג');
  const placed = await q('select id from posts where content_id = any($1::int[])', [mine]);
  assert.equal(placed.length, 0);
  await cleanup(x);
});

test('תקרה: קמפיין של שנה ממולא רק 26 שבועות קדימה', { skip }, async () => {
  const x = await fresh('שנה', { maxPerWeek: 1 });
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on)
     values ($1, 'שנה', $2, $3) returning *`, [x.ep, inDays(0), inDays(400)]);
  await q('insert into campaign_channels values ($1, $2)', [c.id, x.ch]);
  await items(x.ep, x.ch, 40, { campaignId: c.id });
  const fill = await inOrg(() => autoFillCampaign(c.id));
  const weeks = campaignFillWeeks(c);
  assert.equal(weeks.length, 26);
  const posts = await q('select scheduled_at from posts where id = any($1::int[])', [fill.created_ids]);
  assert.ok(posts.length >= 20, `${posts.length} פוסטים`);
  for (const p of posts) assert.ok(weekOf(p.scheduled_at) <= weeks[25], String(p.scheduled_at));
  await cleanup(x);
});

test('ביצועים: מילוי קמפיין של 61 יום (3 ערוצים, 30 פריטים)', { skip }, async () => {
  const base = await fresh('ביצועים');
  const extra = await inOrg(async () => {
    const out = [];
    for (const n of ['ב', 'ג']) {
      out.push((await db.one(
        `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
         values ($1, 'manual', 5, 0) returning id`, [`ערוץ ביצועים ${n}`])).id);
    }
    return out;
  });
  const chans = [base.ch, ...extra];
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days)
     values ($1, 'ביצועים', $2, $3, 2) returning id`, [base.ep, inDays(7), inDays(67)]);
  for (const ch of chans) await q('insert into campaign_channels values ($1, $2)', [c.id, ch]);
  await inOrg(async () => {
    for (let i = 1; i <= 30; i += 1) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
         values ($1,$2,'value',$3,$4) returning id`, [base.ep, c.id, `פריט ${i}`, i]);
      for (const ch of chans) {
        await db.query(`insert into content_variants (content_id, channel_id, body, status)
                        values ($1,$2,'x','ready')`, [it.id, ch]);
      }
    }
  });
  const t0 = performance.now();
  const fill = await inOrg(() => autoFillCampaign(c.id));
  const ms = Math.round(performance.now() - t0);
  console.log(`autoFillCampaign — 61 ימים, ${fill.weeks} שבועות, ${fill.placed} פוסטים: ${ms}ms`);
  assert.ok(fill.placed > 0);
  await inOrg(async () => {
    await db.query('delete from posts where channel_id = any($1::int[])', [extra]);
    await db.query('delete from content_items where endpoint_id = $1', [base.ep]);
    await db.query('delete from channels where id = any($1::int[])', [extra]);
  });
  await cleanup(base);
});
