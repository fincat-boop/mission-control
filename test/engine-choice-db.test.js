import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 3 של שיפורי ההתנהגות (docs/behavior-improvements.md, סעיפים 8–14 +
 * משולב/מכירתי) מול Postgres אמיתי.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test --test-concurrency=1
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
  const { default: board } = await import('../src/routes/board.js');
  const { default: channels } = await import('../src/routes/channels.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('engine-choice-test') returning id")).rows[0].id;
  // מרווח כללי של יום — כדי שנקודה אחת תוכל לקבל כמה פוסטים בשבוע
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בדיקה', is_owner: true, perm_content: true, perm_settings: true };
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
  app.use(board);
  app.use(channels);
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

const { ymd, weekMeta } = await import('../src/board.js');
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const weekOf = (at) => weekMeta(new Date(at)).start;

/** ערוץ חדש (בלי שמורה לדחופים) */
const channel = (name, maxPerWeek = 7) => q1(
  `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
   values ($1, 'manual', $2, 0) returning *`, [name, maxPerWeek]);
const endpoint = (name, importance = 5) => q1(
  'insert into endpoints (name, importance) values ($1, $2) returning *', [name, importance]);

/** פריטי תוכן מוכנים לנקודה, בקמפיין או שוטפים — גרסה מוכנה לכל ערוץ ב-channels */
async function items(endpointId, channels, n, { campaignId = null, prefix = 'פריט', kind = 'value',
                                                evergreen = false } = {}) {
  return inOrg(async () => {
    const out = [];
    for (let i = 1; i <= n; i += 1) {
      const k = Array.isArray(kind) ? kind[(i - 1) % kind.length] : kind;
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order, evergreen)
         values ($1,$2,$5,$3,$4,$6) returning id`,
        [endpointId, campaignId, `${prefix} ${i}`, i, k, evergreen]);
      for (const ch of [channels].flat()) {
        await db.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,'x','ready')`, [it.id, ch]);
      }
      out.push(it.id);
    }
    return out;
  });
}

const campaign = (endpointId, channels, { name = 'קמפיין', starts, ends, share = null,
                                          gap = null } = {}) => inOrg(async () => {
  const c = await db.one(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct, min_gap_days)
     values ($1,$2,$3,$4,$5,$6) returning *`, [endpointId, name, starts, ends, share, gap]);
  for (const ch of [channels].flat()) {
    await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [c.id, ch]);
  }
  return c;
});

const post = (channelId, endpointId, at, { status = 'published', contentId = null,
                                           kind = 'value' } = {}) => q1(
  `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, published_at, status)
   values ($1,$2,$3,'פוסט',$6,$4,case when $5 = 'published' then $4::timestamptz end,$5) returning *`,
  [channelId, endpointId, contentId, at, status, kind]);

/** מוחק את כל מה שבארגון — כל בדיקה מתחילה מלוח ריק */
async function wipe() {
  await inOrg(async () => {
    await db.query('delete from posts');
    await db.query('delete from engine_dismissals');
    await db.query('delete from content_items');
    await db.query('delete from campaigns');
    await db.query('delete from channels');
    await db.query('delete from endpoints');
    await db.query('delete from activity_log');
  });
}

const daysAgo = (n, from = new Date()) => new Date(from.getTime() - n * 86400000);

/* ========================= 8. ותק לכל נקודה × ערוץ ========================= */

test('סעיף 8 — נקודה טרייה בוואטסאפ אבל ותיקה בפייסבוק זוכה במשבצת של פייסבוק', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const start = new Date(`${week.days[0].date}T10:00:00`);
  const wa = await channel('וואטסאפ', 7);
  const fb = await channel('פייסבוק', 1);
  const a = await endpoint('שבועית בוואטסאפ');
  const b = await endpoint('פייסבוק לפני 10 ימים');
  await items(a.id, fb.id, 2, { prefix: 'א' });
  await items(b.id, fb.id, 2, { prefix: 'ב' });
  // א: וואטסאפ לפני יומיים (טרייה "בכלל"), פייסבוק לפני 60 יום. ב: פייסבוק לפני 10 ימים
  await post(wa.id, a.id, daysAgo(2, start));
  await post(fb.id, a.id, daysAgo(60, start));
  await post(fb.id, b.id, daysAgo(10, start));

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === fb.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].endpoint_id, a.id, `זכתה ${mine[0].endpoint_name} (${mine[0].reason})`);
  assert.match(mine[0].reason, /(59|60) ימים בלי פרסום בפייסבוק/);

  // החוב: בלי ערוץ — הנקודה בכלל (וואטסאפ, יומיים); בפייסבוק — 60
  const parts = await inOrg(async () => {
    const eps = await db.rows('select * from endpoints where id = any($1::int[]) order by id', [[a.id, b.id]]);
    const settings = await db.one('select * from engine_settings limit 1');
    const debts = await engine.computeDebts(eps, settings, null, week);
    return { all: debts.parts(a.id), fb: debts.parts(a.id, fb.id), wa: debts.parts(a.id, wa.id),
             bWa: debts.parts(b.id, wa.id), bFb: debts.parts(b.id, fb.id) };
  });
  assert.ok(Math.round(parts.all.daysSince) <= 3, String(parts.all.daysSince));
  assert.ok(parts.fb.daysSince >= 59, String(parts.fb.daysSince));
  assert.ok(parts.fb.staleness > parts.wa.staleness);
  // ב לא פורסמה בוואטסאפ: "עוד לא" בערוץ — לפחות 2, עד הוותיקה בערוץ
  assert.equal(parts.bWa.daysSince, null);
  assert.ok(parts.bWa.staleness >= 2, String(parts.bWa.staleness));
  await wipe();
});
