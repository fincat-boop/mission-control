import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 2 של שיפורי ההתנהגות (docs/behavior-improvements.md, סעיפים 4–7 וחלון
 * ההתאמה) מול Postgres אמיתי: נתח לכל ערוץ במנוע, מרווח שנגזר מהערוץ, קמפיין
 * מכירתי בערוץ קטן, וחלון ההתאמה לקמפיין שהתחיל בעבר / ארוך מ-26 שבועות.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני (אותו דגל כמו שאר בדיקות המסד):
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test --test-concurrency=1
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
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

  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('capacity-stage-2') returning id")).rows[0].id;
  // ברירות המחדל של המוצר: מרווח כללי 7, מכירתי אחד ליום, יחס 3
  await inOrg(() => db.query('insert into engine_settings default values'));

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

const { ymd, weekMeta } = await import('../src/board.js');
/** YYYY-MM-DD בעוד n ימים (זמן מקומי) */
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const weekOf = (at) => weekMeta(new Date(at)).start;

/** נקודת קצה, וערוץ חדש לכל בדיקה */
async function endpoint(name, importance = 5) {
  return (await q1('insert into endpoints (name, importance) values ($1, $2) returning id',
    [name, importance])).id;
}
async function channel(name, maxPerWeek, reserve = 20) {
  return (await q1(
    `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
     values ($1, 'manual', $2, $3) returning id`, [name, maxPerWeek, reserve])).id;
}
async function campaign(ep, name, from, to, chans, { gap = null } = {}) {
  const c = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days, structure)
     values ($1, $2, $3, $4, $5, 'general') returning id`, [ep, name, from, to, gap])).id;
  for (const ch of chans) await q('insert into campaign_channels values ($1, $2)', [c, ch]);
  return c;
}
/** פריטי תוכן מוכנים לנקודה, בקמפיין או שוטפים */
async function items(ep, ch, n, { campaignId = null, kind = 'value', prefix = 'פריט' } = {}) {
  return inOrg(async () => {
    for (let i = 1; i <= n; i += 1) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order, slot_channel_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ep, campaignId, kind, `${prefix} ${i}`, i, campaignId ? ch : null]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'x','ready')`,
        [it.id, ch]);
    }
  });
}

/* ========================= סעיף 4 — נתח לכל ערוץ במנוע ========================= */

test('סעיף 4 — קמפיין לבד בוואטסאפ מקבל את כל התקציב שם, גם כשבפייסבוק יש קמפיין של נקודה אחרת', { skip }, async () => {
  const week = weekMeta(inDays(21));
  const fb = await channel('פייסבוק 4', 8, 0);
  const wa = await channel('וואטסאפ 4', 4, 0);
  const a = await endpoint('נקודה בפייסבוק');
  const b = await endpoint('נקודה בוואטסאפ');
  const ca = await campaign(a, 'פייסבוק בלבד', week.days[0].date, week.days[6].date, [fb]);
  const cb = await campaign(b, 'וואטסאפ בלבד', week.days[0].date, week.days[6].date, [wa]);
  await items(a, fb, 10, { campaignId: ca });
  await items(b, wa, 10, { campaignId: cb });

  // מילוי מרוסן (שבוע שלא מוצג): עד הנתח של הקמפיין בכל ערוץ
  const plan = await inOrg(() => engine.planWeek(week.days[3].date,
    { holes: false, onlyCampaignId: cb }));
  const onWa = plan.placements.filter((p) => p.channel_id === wa);
  // קודם: נתח 50% על כל הערוצים → ceil(4 × 0.5) = 2
  assert.equal(onWa.length, 4, JSON.stringify(onWa.map((p) => p.date)));
  assert.ok(!plan.placements.some((p) => p.channel_id === fb));
});

/* ========================= סעיף 5 — מרווח שנגזר מהערוץ ========================= */

test('סעיף 5 — נקודה אחת, ערוץ של 5 בשבוע, תוכן שוטף: המנוע ממלא 4 בשבוע (5 פחות שמורה של 1), לא 1', { skip }, async () => {
  const week = weekMeta(inDays(28));
  const ch = await channel('ערוץ 5', 5, 20);
  const ep = await endpoint('נקודה יחידה');
  await items(ep, ch, 8, { prefix: 'שוטף' });

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const mine = plan.placements.filter((p) => p.channel_id === ch);
  // קודם: מרווח 7 קבוע → פוסט אחד בשבוע לנקודה × ערוץ
  assert.equal(mine.length, 4, JSON.stringify(mine.map((p) => p.date)));
  assert.equal(new Set(mine.map((p) => p.date)).size, 4, 'לא שניים באותו יום');

  // אזהרת המרווח בלוח — אותו כלל: יום אחרי פוסט קיים כבר לא "צמוד מדי"
  const { gapFor } = await import('../src/gap.js');
  const g = await inOrg(() => gapFor({ channelId: ch, when: `${week.days[3].date}T10:00:00` }));
  assert.deepEqual(g, { min: 1, campaign: null, derived: true });
});

test('סעיף 5 — מרווח של הקמפיין גובר על הנגזר, והלוח אומר כשהמרווח הוא המגביל', { skip }, async () => {
  const week = weekMeta(inDays(35));
  const ch = await channel('ערוץ מרווח 7', 5, 20);
  const ep = await endpoint('נקודה עם מרווח');
  const c = await campaign(ep, 'פעם בשבוע', week.days[0].date, week.days[6].date, [ch], { gap: 7 });
  await items(ep, ch, 6, { campaignId: c });

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  assert.equal(plan.placements.filter((p) => p.channel_id === ch).length, 1);

  await inOrg(() => engine.applyWeek(week.days[3].date, { holes: false }));
  const { buildBoard } = await import('../src/board.js');
  const board = await inOrg(() => buildBoard(week.days[3].date));
  const row = board.channels.find((x) => x.id === ch);
  assert.equal(row.used, 1);
  assert.equal(row.limited_by, 'gap');
  assert.equal(row.gap_limit, 1);
});

/* ========================= סעיף 6 — קמפיין מכירתי בערוץ קטן ========================= */

test('סעיף 6 — קמפיין מכירתי בערוץ של 3 בשבוע: ~1 מכירתי לכל 4 פוסטים, והרשת מבקשת רק את זה', { skip }, async () => {
  const { autoFillCampaign } = await import('../src/routes/_shared.js');
  const first = weekMeta(inDays(14));
  const last = weekMeta(inDays(14 + 7 * 7));   // 8 שבועות
  const ch = await channel('וואטסאפ 3', 3, 20);   // תקציב 2
  const ep = await endpoint('נקודת מבצעים');
  const c = await campaign(ep, 'מבצע', first.start, last.end, [ch]);
  await items(ep, ch, 20, { campaignId: c, kind: 'promo', prefix: 'מבצע' });

  // הרשת: 16 מקומות בערוץ ב-8 שבועות, יחס 3 → 4 מכירתיים (קודם: 16)
  const { campaignsWithHealth } = await import('../src/campaigns.js');
  const row = (await inOrg(() => campaignsWithHealth())).find((x) => x.id === c);
  assert.equal(row.needs[ch], 4);

  const fill = await inOrg(() => autoFillCampaign(c));
  const posts = await q('select scheduled_at, kind from posts where id = any($1::int[])',
    [fill.created_ids]);
  assert.equal(posts.length, 4, JSON.stringify(posts.map((p) => weekOf(p.scheduled_at))));
  assert.ok(posts.every((p) => p.kind === 'promo'));
  // מפוזר: לא יותר מאחד בשבוע, ולא יותר משניים בכל 4 שבועות רצופים
  const weeks = posts.map((p) => weekOf(p.scheduled_at));
  assert.equal(new Set(weeks).size, 4);
  // ההודעה אומרת איזו מגבלה עצרה — לא "חסר תוכן ערך"
  assert.ok(fill.limit_notes.length > 0);
  assert.ok(fill.limit_notes.every((n) => !/חסר תוכן ערך/.test(n)), fill.limit_notes.join(' | '));
  assert.match(fill.limit_notes.join(' '), /מכניס עד 2 מכירתיים ב-28 ימים/);
});

/* ========================= חלון ההתאמה ========================= */

test('חלון ההתאמה — קמפיין שהתחיל בעבר נספר מהיום; ארוך מ-26 שבועות — מה שאחרי האופק בנפרד', { skip }, async () => {
  const ch = await channel('ערוץ חלון', 7, 0);
  const ep = await endpoint('נקודת חלון');

  // התחיל לפני 14 יום, נגמר בעוד 13 — 28 יום, מרווח 1: נספרים רק הימים שנשארו
  const past = await call('POST', '/campaigns/capacity-preview', {
    endpoint_id: ep, starts_on: inDays(-14), period: 'custom', ends_on: inDays(13),
    channel_ids: [ch], min_gap_days: 1 });
  assert.equal(past.status, 200, JSON.stringify(past.json));
  assert.equal(past.json.started_past, true);
  const late = new Date().getHours() + 1 > 22;
  assert.equal(past.json.from, inDays(late ? 1 : 0));
  assert.equal(past.json.channels[0].capacity, late ? 13 : 14);

  // שנה: עד 26 שבועות עכשיו, והשאר "יתמלאו כשיתקרבו"
  const long = await call('POST', '/campaigns/capacity-preview', {
    endpoint_id: ep, starts_on: inDays(7), period: 'custom', ends_on: inDays(7 + 364),
    channel_ids: [ch], min_gap_days: 7 });
  assert.equal(long.status, 200, JSON.stringify(long.json));
  assert.ok(long.json.later_from > long.json.to);
  assert.equal(long.json.channels[0].capacity, 26);
  assert.ok(long.json.channels[0].later >= 25);
});

/* ========================= U1 — מרווח קפוא לקמפיינים קיימים ========================= */

test('U1 — צעד חד-פעמי: קמפיין רץ בלי מרווח מקבל את הכללי; ריצה שנייה ונוצר אחר כך — לא נוגעים', { skip }, async () => {
  await db.migrate();   // הטבלה app_migrations קיימת (ובמסד הזה הצעד אולי כבר רץ)
  const ep = await endpoint('נקודת הקפאה');
  const running = await campaign(ep, 'רץ', inDays(-10), inDays(20), []);
  const ended = await campaign(ep, 'נגמר', inDays(-30), inDays(-1), []);
  const own = await campaign(ep, 'מרווח משלו', inDays(-10), inDays(20), [], { gap: 3 });
  const open = await campaign(ep, 'בלי סוף', inDays(-10), null, []);
  await db.pool.query("delete from app_migrations where key = 'freeze_campaign_gap_v1'");

  await db.migrate();
  const gaps = async () => Object.fromEntries((await q(
    'select id, min_gap_days from campaigns where endpoint_id = $1', [ep])).map((r) => [r.id, r.min_gap_days]));
  const first = await gaps();
  assert.equal(first[running], 7);   // engine_settings של הארגון — ברירת המחדל 7
  assert.equal(first[open], 7);
  assert.equal(first[ended], null);
  assert.equal(first[own], 3);

  // נוצר אחרי העלייה, ועוד ריצה של הסכימה — לא קופא, ושום דבר לא משתנה
  const later = await campaign(ep, 'חדש', inDays(1), inDays(30), []);
  await db.migrate();
  const second = await gaps();
  assert.equal(second[later], null);
  assert.deepEqual({ ...second, [later]: undefined }, { ...first, [later]: undefined });
});
