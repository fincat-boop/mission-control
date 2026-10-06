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
async function items(endpointId, channelId, n, { campaignId = null, prefix = 'פריט', kind = 'value' } = {}) {
  return inOrg(async () => {
    const out = [];
    for (let i = 1; i <= n; i += 1) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
         values ($1,$2,$5,$3,$4) returning id`,
        [endpointId, campaignId, `${prefix} ${i}`, i, kind]);
      for (const ch of [channelId].flat()) {
        await db.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,'x','ready')`, [it.id, ch]);
      }
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
const { autoFillCampaign, campaignFillWeeks } = await import('../src/routes/_shared.js');
/** תחילת השבוע (YYYY-MM-DD) של פוסט */
const weekOf = (at) => weekMeta(new Date(at)).start;

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

  // מילוי הקמפיין בשמירה, כשהמשתמש מסתכל על שבוע אחר: רק תוכן בלאק פריידי
  const fill = await inOrg(() => autoFillCampaign(camp.id, inDays(0)));
  const written = await q(
    `select p.scheduled_at, ci.campaign_id from posts p join content_items ci on ci.id = p.content_id
      where p.id = any($1::int[])`, [fill.created_ids]);
  const inWeek = written.filter((p) => weekOf(p.scheduled_at) === week.start);
  assert.ok(inWeek.length >= 1, JSON.stringify(fill.summary));
  assert.ok(inWeek.every((p) => p.campaign_id === camp.id), 'שבוע שלא מוצג — רק תוכן הקמפיין');

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


test('קמפיין חדש עם תוכן (שכפול) ממלא את כל השבועות שלו — רק בתוכן שלו — ו"בטל" אחד מוריד הכול', { skip }, async () => {
  // ערוץ של פוסט אחד בשבוע — כל שבוע מקבל לכל היותר פוסט אחד
  const x = await fresh('שלושה שבועות', { maxPerWeek: 1 });
  // מקור שכבר נגמר: התוכן שלו לא משובץ, והשכפול מעתיק אותו
  const src = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on)
     values ($1, 'מקור', $2, $3) returning id`, [x.ep, inDays(-60), inDays(-40)]);
  await q('insert into campaign_channels values ($1, $2)', [src.id, x.ch]);
  await items(x.ep, x.ch, 5, { campaignId: src.id, prefix: 'מקור' });
  // תוכן שוטף של נקודה אחרת באותו ערוץ — לא נכנס לשבועות שלא מוצגים
  const other = await q1("insert into endpoints (name, importance) values ('שוטפת', 9) returning id");
  await items(other.id, x.ch, 5, { prefix: 'שוטף' });

  // ראשון בעוד 3 שבועות, ועד השבת שאחרי שבועיים — בדיוק 3 שבועות
  const first = weekMeta(inDays(21));
  const ends = weekMeta(inDays(35)).end;
  const viewed = weekMeta(inDays(0)).start;
  const r = await call('POST', `/campaigns/${src.id}/duplicate`, {
    endpoint_id: x.ep, name: 'שלושה שבועות', starts_on: first.start, ends_on: ends,
    period: 'custom', channel_ids: [x.ch], week: inDays(0),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const copyId = r.json.campaign.id;
  const fill = r.json.engine;
  const posts = await q(
    `select p.id, p.scheduled_at, ci.campaign_id from posts p
       join content_items ci on ci.id = p.content_id where p.id = any($1::int[])`, [fill.created_ids]);
  const campWeeks = campaignFillWeeks({ active: true, starts_on: first.start, ends_on: ends });
  const inCamp = posts.filter((p) => campWeeks.includes(weekOf(p.scheduled_at)));
  assert.deepEqual(inCamp.map((p) => weekOf(p.scheduled_at)).sort(), campWeeks, JSON.stringify(fill.summary));
  assert.ok(inCamp.every((p) => p.campaign_id === copyId), 'בשבועות שלא מוצגים — רק התוכן של הקמפיין');
  // מחוץ לשבועות של הקמפיין — רק השבוע שמוצג, שמתמלא במלואו כמו קודם
  assert.ok(posts.every((p) => campWeeks.includes(weekOf(p.scheduled_at)) || weekOf(p.scheduled_at) === viewed));
  assert.equal(fill.placed, posts.length);
  assert.ok(fill.weeks >= 3);

  assert.deepEqual(fill.covered_weeks, [viewed, ...campWeeks].sort());
  const undo = await call('POST', '/engine/undo',
    { created: fill.created_items, attached: fill.attached_items, weeks: fill.covered_weeks });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.equal(undo.json.removed, fill.placed);
  assert.equal((await q('select id from posts where id = any($1::int[])', [fill.created_ids])).length, 0);
  // הוויתור נרשם לכל השבועות שהמילוי עבר עליהם — השמירה הבאה לא מחזירה
  // את התוכן שבוטל לשום שבוע בתקופה (קודם: עבר לשבוע הסמוך)
  const undone = new Set(fill.created_items.map((c) => c.content_id));
  const again = await inOrg(() => autoFillCampaign(copyId, inDays(0)));
  const back = await q('select content_id from posts where id = any($1::int[])', [again.created_ids]);
  assert.deepEqual(back.filter((p) => undone.has(p.content_id)), [], 'תוכן שבוטל חזר');
  // שבוש בגוף הבקשה לא מפיל את "בטל"
  const junk = await call('POST', '/engine/undo', { created: [{ post_id: 999999 }], weeks: ['2026-13-45', 7] });
  assert.equal(junk.status, 200, JSON.stringify(junk.json));
  await inOrg(async () => {
    await db.query('delete from content_items where endpoint_id = $1', [other.id]);
    await db.query('delete from endpoints where id = $1', [other.id]);
  });
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
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on)
     values ($1, 'רץ', $2, $3) returning id`, [x.ep, inDays(-10), inDays(10)]);
  await q('insert into campaign_channels values ($1, $2)', [c.id, x.ch]);
  await items(x.ep, x.ch, 10, { campaignId: c.id });
  const started = new Date();
  const r = await call('PATCH', `/campaigns/${c.id}`, { min_gap_days: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.engine.placed >= 1, JSON.stringify(r.json.engine));
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

test('כשל באמצע המילוי: תשובה ריקה, והטרנזקציה של הבקשה ממשיכה (savepoint)', { skip }, async () => {
  const { EMPTY_FILL } = await import('../src/routes/_shared.js');
  const errors = console.error;
  console.error = () => {};   // השגיאה הצפויה לא מלכלכת את הפלט
  try {
    await inOrg(async () => {
      // מזהה לא מספרי — שגיאת SQL בתוך המילוי
      assert.equal(await autoFillCampaign('לא מספר'), EMPTY_FILL);
      // הטרנזקציה לא נשברה: אפשר להמשיך לכתוב ולקרוא
      const ok = await db.one('select 1 as n');
      assert.equal(ok.n, 1);
    });
  } finally {
    console.error = errors;
  }
});

/* ========================= ביקורת: שער היחס בשבוע מרוסן ========================= */

test('קמפיין שכולו מכירתי: בשבועות מרוסנים מקבל מכירתיים עד התקרה הצפויה, והחסומים נספרים', { skip }, async () => {
  const x = await fresh('כולו מכירתי');
  const ch2 = await q1(
    `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
     values ('ערוץ מכירתי ב', 'manual', 7, 0) returning id`);
  // שני ערוצים × 7 = 14; יחס 3 ערך לכל מכירתי → 3 מכירתיים בשבוע
  const first = weekMeta(inDays(21));
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days)
     values ($1, 'מבצע', $2, $3, 1) returning id`, [x.ep, first.start, weekMeta(inDays(28)).end]);
  for (const ch of [x.ch, ch2.id]) await q('insert into campaign_channels values ($1, $2)', [c.id, ch]);
  await items(x.ep, [x.ch, ch2.id], 10, { campaignId: c.id, kind: 'promo', prefix: 'מבצע' });

  const fill = await inOrg(() => autoFillCampaign(c.id));
  const posts = await q('select scheduled_at, kind from posts where id = any($1::int[])', [fill.created_ids]);
  const perWeek = new Map();
  for (const p of posts) perWeek.set(weekOf(p.scheduled_at), (perWeek.get(weekOf(p.scheduled_at)) ?? 0) + 1);
  assert.deepEqual([...perWeek.entries()].sort(),
    [[first.start, 3], [weekMeta(inDays(28)).start, 3]], JSON.stringify(fill.summary));
  assert.ok(posts.every((p) => p.kind === 'promo'));
  assert.ok(fill.promo_blocked > 0, 'החסומים נספרים — לא בשקט');

  await q('delete from posts where channel_id = $1', [ch2.id]);
  await cleanup(x);
  await q('delete from channels where id = $1', [ch2.id]);
});

test('שבוע מרוסן: הקמפיין לא תופס בערוץ יותר מ-ceil(תקציב × הנתח שלו)', { skip }, async () => {
  const x = await fresh('נתח 40', { maxPerWeek: 10 });
  const otherEp = await q1("insert into endpoints (name, importance) values ('קמפיין שכן', 5) returning id");
  const first = weekMeta(inDays(21));
  const ends = weekMeta(inDays(28)).end;
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct, min_gap_days)
     values ($1, 'נתח 40', $2, $3, 40, 1) returning id`, [x.ep, first.start, ends]);
  const sib = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on)
     values ($1, 'שכן', $2, $3) returning id`, [otherEp.id, first.start, ends]);
  for (const id of [c.id, sib.id]) await q('insert into campaign_channels values ($1, $2)', [id, x.ch]);
  await items(x.ep, x.ch, 20, { campaignId: c.id });

  const fill = await inOrg(() => autoFillCampaign(c.id));
  const posts = await q('select scheduled_at from posts where id = any($1::int[])', [fill.created_ids]);
  const perWeek = new Map();
  for (const p of posts) perWeek.set(weekOf(p.scheduled_at), (perWeek.get(weekOf(p.scheduled_at)) ?? 0) + 1);
  // 10 × 40% = 4 בכל שבוע (בלי התקרה — 7, יום אחד לכל נקודה בערוץ)
  assert.deepEqual([...perWeek.entries()].sort(),
    [[first.start, 4], [weekMeta(inDays(28)).start, 4]], JSON.stringify(fill.summary));

  await q('delete from campaigns where id = $1', [sib.id]);
  await q('delete from endpoints where id = $1', [otherEp.id]);
  await cleanup(x);
});

test('נקודה ותיקה שלא פורסמה: הוותק שלה נעצר ב-3 — לא בולעת נקודה שחיכתה 40 יום', { skip }, async () => {
  const week = weekMeta(inDays(14));
  const a = await fresh('ותיקה שלא פורסמה', { maxPerWeek: 1 });
  const b = await q1("insert into endpoints (name, importance) values ('40 יום בלי', 5) returning id");
  // א: נוצרה לפני שנה ומעולם לא פורסמה (בלי תקרה — 365/12 ≈ 30). ב: פורסמה 40 יום לפני השבוע (3.3)
  await q("update endpoints set created_at = now() - interval '365 days' where id = $1", [a.ep]);
  await items(a.ep, a.ch, 2, { prefix: 'א' });
  await items(b.id, a.ch, 2, { prefix: 'ב' });
  const start = new Date(`${week.days[0].date}T10:00:00`);
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, published_at, status)
     values ($1, $2, 'פורסם', 'value', $3, $3, 'published')`,
    [a.ch, b.id, new Date(start.getTime() - 40 * 86400000)]);

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === a.ch);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].endpoint_id, b.id, `זכתה ${mine[0].endpoint_name} (${mine[0].reason})`);

  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1', [b.id]);
    await db.query('delete from content_items where endpoint_id = $1', [b.id]);
    await db.query('delete from endpoints where id = $1', [b.id]);
  });
  await cleanup(a);
});

test('ותק: פוסט שנכשל או שהמועד שלו עבר ולא יצא לא נספר — הנקודה עדיין מחכה', { skip }, async () => {
  const week = weekMeta(inDays(7));
  const a = await fresh('רק נכשלו', { maxPerWeek: 1 });
  const b = await q1("insert into endpoints (name, importance) values ('פורסמה לפני 12 יום', 5) returning id");
  await items(a.ep, a.ch, 2, { prefix: 'א' });
  await items(b.id, a.ch, 2, { prefix: 'ב' });
  // א: נכשל שלשום, ומתוכנן שהמועד שלו עבר אתמול ולא יצא. ב: פורסם לפני 12 יום (עד השבוע ≈ 16/12 ≈ 1.3)
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status) values
       ($1, $2, 'נכשל', 'value', now() - interval '2 days', 'failed'),
       ($1, $2, 'באיחור', 'value', now() - interval '1 day', 'scheduled')`, [a.ch, a.ep]);
  await q(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, published_at, status)
     values ($1, $2, 'פורסם', 'value', now() - interval '12 days', now() - interval '12 days', 'published')`,
    [a.ch, b.id]);

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === a.ch);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].endpoint_id, a.ep, `זכתה ${mine[0].endpoint_name} (${mine[0].reason})`);
  assert.match(mine[0].reason, /עוד לא פורסמה מעולם/);

  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1', [b.id]);
    await db.query('delete from content_items where endpoint_id = $1', [b.id]);
    await db.query('delete from endpoints where id = $1', [b.id]);
  });
  await cleanup(a);
});
