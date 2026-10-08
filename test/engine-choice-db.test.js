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

/* ========================= 9. חלון הפער מול הנתח ========================= */

test('סעיף 9 — קמפיין שהתחיל מאוחר לא זוכה כמעט בכל משבצת אחרי 8 פוסטים לכל אחד', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const start = new Date(`${week.days[0].date}T10:00:00`);
  const ch = await channel('פייסבוק', 7);
  const a = await endpoint('ותיק');
  const b = await endpoint('חדש');
  const ends = inDays(60);
  // א רץ כבר 10 שבועות (24 פוסטים), ב התחיל לפני 3 שבועות (8 פוסטים). בחודש
  // האחרון — 7 מול 8. קודם החלון התחיל ב-starts_on של א, ו-ב "פיגר" 8 מול 32
  const ca = await campaign(a.id, ch.id, { name: 'ותיק', starts: ymd(daysAgo(70, start)), ends });
  const cb = await campaign(b.id, ch.id, { name: 'חדש', starts: ymd(daysAgo(21, start)), ends });
  const ia = await items(a.id, ch.id, 24, { campaignId: ca.id, prefix: 'א' });
  const ib = await items(b.id, ch.id, 8, { campaignId: cb.id, prefix: 'ב' });
  // תוכן שוטף לשיבוץ — הפיגור נמדד לנקודה, לא לפריט (התוכן של הקמפיינים
  // מפוזר על התקופה שלהם, סעיף 10)
  await items(a.id, ch.id, 10, { prefix: 'א שוטף' });
  await items(b.id, ch.id, 10, { prefix: 'ב שוטף' });
  for (let i = 0; i < 24; i += 1) {
    await post(ch.id, a.id, daysAgo(70 - i * 3 - 1, start), { contentId: ia[i] });
  }
  for (let i = 0; i < 8; i += 1) {
    await post(ch.id, b.id, daysAgo(21 - Math.round(i * 2.6) - 1, start), { contentId: ib[i] });
  }

  const parts = await inOrg(async () => {
    const eps = await db.rows('select * from endpoints order by id');
    const settings = await db.one('select * from engine_settings limit 1');
    const debts = await engine.computeDebts(eps, settings, null, week);
    return { a: debts.parts(a.id, ch.id), b: debts.parts(b.id, ch.id) };
  });
  assert.ok(parts.b.deficit < 0.06, `ב מפגר ${parts.b.deficit}`);
  assert.ok(parts.a.deficit < 0.06, `א מפגר ${parts.a.deficit}`);

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const by = (id) => plan.placements.filter((p) => p.endpoint_id === id).length;
  assert.ok(plan.placements.length >= 6, String(plan.placements.length));
  assert.ok(Math.abs(by(a.id) - by(b.id)) <= 1,
    `א ${by(a.id)} / ב ${by(b.id)}: ${plan.placements.map((p) => p.endpoint_name).join(', ')}`);
  await wipe();
});

/* ========================= 10. פיזור קמפיין לפי קצב ========================= */

test('סעיף 10 — 4 פוסטים של קמפיין בן 10 שבועות נפרסים על כל התקופה, לא בשבועות 1–4', { skip }, async () => {
  await wipe();
  const { autoFillCampaign } = await import('../src/routes/_shared.js');
  const ch = await channel('פייסבוק', 7);
  const ep = await endpoint('נקודה');
  // מתחיל בעוד 3 שבועות (ראשון), 10 שבועות — כל השבועות מרוסנים לקמפיין
  const s = weekMeta(inDays(21)).start;
  const e = ymd(new Date(new Date(`${s}T12:00:00`).getTime() + (70 - 1) * 86400000));
  const c = await campaign(ep.id, ch.id, { starts: s, ends: e });
  const ids = await items(ep.id, ch.id, 4, { campaignId: c.id, prefix: 'קצב' });

  const fill = await inOrg(() => autoFillCampaign(c.id, null));
  const posts = await q(
    `select content_id, scheduled_at from posts where content_id = any($1::int[]) order by scheduled_at`, [ids]);
  assert.equal(posts.length, 4, JSON.stringify(fill.summary));
  const weekIdx = (at) => Math.floor((new Date(at) - new Date(`${s}T00:00:00`)) / (7 * 86400000));
  const weeks = posts.map((p) => weekIdx(p.scheduled_at));
  // פריט k מתוך 4 — לא לפני start + floor(k × 70 / 4) ימים: שבועות 0, 2, 5, 7
  assert.deepEqual(weeks, [0, 2, 5, 7], JSON.stringify(posts));
  // כל פריט לא לפני התאריך המפוזר שלו, ולפי הסדר בתור
  assert.deepEqual(posts.map((p) => p.content_id), ids);
  await wipe();
});

test('סעיף 10 — יותר תוכן ממשבצות: הקמפיין עדיין ממלא כמה שאפשר בתקופה', { skip }, async () => {
  await wipe();
  const { autoFillCampaign } = await import('../src/routes/_shared.js');
  const ch = await channel('פייסבוק', 7);
  const ep = await endpoint('נקודה');
  // שבועיים, מרווח 3 ימים בין פוסטים → 5 משבצות לכל היותר; 12 פריטים
  const s = weekMeta(inDays(21)).start;
  const e = ymd(new Date(new Date(`${s}T12:00:00`).getTime() + 13 * 86400000));
  const c = await campaign(ep.id, ch.id, { starts: s, ends: e, gap: 3 });
  const ids = await items(ep.id, ch.id, 12, { campaignId: c.id, prefix: 'הרבה' });
  await inOrg(() => autoFillCampaign(c.id, null));
  const posts = await q(
    'select content_id, scheduled_at from posts where content_id = any($1::int[]) order by scheduled_at', [ids]);
  // כמה שהמרווח מאפשר בתקופה (channelCapacity — אותו חשבון כמו הרשת)
  const { channelCapacity } = await import('../src/capacity.js');
  const cap = channelCapacity({ from: s, to: e, channel: ch, share: 1, gapDays: 3 }).gapCap;
  assert.equal(cap, 5);
  assert.equal(posts.length, cap, JSON.stringify(posts));
  // התור מתקדם לפי הסדר — הפריטים הראשונים, לא דילוג לסוף (בתוך שבוע המנוע
  // ממלא ממרכז השבוע לקצוות, ולכן לא בהכרח לפי סדר הימים)
  assert.deepEqual(posts.map((p) => p.content_id).sort((x, y) => x - y), ids.slice(0, 5));
  await wipe();
});

/* ========================= 11. בחירת תוכן בתוך נקודה ========================= */

test('סעיף 11 — תוכן של קמפיין רץ קודם לתוכן שוטף ותיק (evergreen)', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const ch = await channel('פייסבוק', 1);
  const ep = await endpoint('נקודה');
  // השוטף נוצר קודם (ותיק יותר) — קודם הוא ניצח בשוויון
  const [old] = await items(ep.id, ch.id, 1, { prefix: 'ותיק', evergreen: true });
  const c = await campaign(ep.id, ch.id, { starts: inDays(-7), ends: inDays(30) });
  const [mine] = await items(ep.id, ch.id, 1, { campaignId: c.id, prefix: 'קמפיין' });
  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const p = plan.placements.filter((x) => x.channel_id === ch.id);
  assert.equal(p.length, 1);
  assert.equal(p[0].content_id, mine, `נבחר ${p[0].title} (הוותיק: ${old})`);
  await wipe();
});

test('סעיף 11 — בין שני קמפיינים של הנקודה: המפגר מהנתח שלו קודם, לא הוותיק', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const start = new Date(`${week.days[0].date}T10:00:00`);
  const ch = await channel('פייסבוק', 1);
  const ep = await endpoint('נקודה');
  const old = await campaign(ep.id, ch.id, { name: 'ותיק', starts: inDays(-30), ends: inDays(30) });
  const late = await campaign(ep.id, ch.id, { name: 'חדש', starts: inDays(-30), ends: inDays(30) });
  // לוותיק 3 פוסטים בחלון, לחדש אף אחד. הפריט הפנוי ראשון בתור (מגיע עכשיו)
  const oi = await items(ep.id, ch.id, 4, { campaignId: old.id, prefix: 'ותיק' });
  const [li] = await items(ep.id, ch.id, 1, { campaignId: late.id, prefix: 'חדש' });
  for (let i = 1; i <= 3; i += 1) {
    await post(ch.id, ep.id, daysAgo(4 * i, start), { contentId: oi[i] });
  }
  const parts = await inOrg(async () => {
    const eps = await db.rows('select * from endpoints');
    const settings = await db.one('select * from engine_settings limit 1');
    const debts = await engine.computeDebts(eps, settings, null, week);
    return { old: debts.campaignLag(old.id, ch.id), late: debts.campaignLag(late.id, ch.id) };
  });
  assert.ok(parts.late > 0 && parts.old < 0, JSON.stringify(parts));

  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const p = plan.placements.filter((x) => x.channel_id === ch.id);
  assert.equal(p.length, 1);
  assert.equal(p[0].content_id, li, `נבחר ${p[0].title}`);
  await wipe();
});

test('סעיף 11 — מרווח: פוסט מכבד גם את המרווח הגדול של השכן', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const ch = await channel('פייסבוק', 7);
  const ep = await endpoint('נקודה');
  const wide = await campaign(ep.id, ch.id, { name: 'מרווח 7', starts: inDays(-7), ends: inDays(30), gap: 7 });
  const tight = await campaign(ep.id, ch.id, { name: 'מרווח 1', starts: inDays(-7), ends: inDays(30), gap: 1 });
  const [w] = await items(ep.id, ch.id, 1, { campaignId: wide.id, prefix: 'רחב' });
  await items(ep.id, ch.id, 6, { campaignId: tight.id, prefix: 'צפוף' });
  // הפוסט של "מרווח 7" ביום רביעי של השבוע המתוכנן — כל השבוע בתוך 7 ימים ממנו
  const wed = new Date(`${week.days[3].date}T10:00:00`);
  await post(ch.id, ep.id, wed, { status: 'scheduled', contentId: w });
  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const p = plan.placements.filter((x) => x.channel_id === ch.id);
  assert.deepEqual(p.map((x) => `${x.title} ${x.date}`), []);
  // ו"לא נכנס" בגלל מרווח הוא המצב הרגיל — לא הודעה
  assert.equal(plan.notes.filter((n) => /מרווח/.test(n)).length, 0);
  await wipe();
});

/* ========================= 12. שעת פרסום לכל ערוץ ========================= */

test('סעיף 12 — המנוע משבץ בשעת הערוץ; בלי שעה — 10:00; חור שעתיים אחרי; דחוף בלי שעה — לפי הערוץ', { skip }, async () => {
  await wipe();
  const week = weekMeta(inDays(7));
  const morning = await channel('בוקר', 7);
  const plain = await channel('רגיל', 7);
  await q('update channels set default_hour = 8 where id = $1', [morning.id]);
  const ep = await endpoint('נקודה');
  await items(ep.id, [morning.id, plain.id], 3);
  const plan = await inOrg(() => engine.planWeek(week.days[3].date, { holes: false }));
  const at = (ch) => plan.placements.filter((p) => p.channel_id === ch).map((p) => p.time);
  assert.ok(at(morning.id).length >= 1 && at(morning.id).every((t) => t === '08:00'),
    JSON.stringify(at(morning.id)));
  assert.ok(at(plain.id).length >= 1 && at(plain.id).every((t) => t === '10:00'),
    JSON.stringify(at(plain.id)));

  // פוסט חסר תוכן (חלון "מלא את השבוע") לנקודה בלי תוכן — שעתיים אחרי שעת הערוץ
  await q('delete from content_items');
  await q('delete from channels where id = $1', [plain.id]);
  await q("update endpoints set created_at = now() - interval '200 days'");
  const withHoles = await inOrg(() => engine.planWeek(week.days[3].date, { holes: true }));
  assert.ok(withHoles.holes.length >= 1, JSON.stringify(withHoles.notes));
  assert.ok(withHoles.holes.every((h) => new Date(h.scheduled_at).getHours() === 10),
    JSON.stringify(withHoles.holes.map((h) => h.scheduled_at)));

  // מבצע דחוף בלי שעה — כל ערוץ בשעה שלו; עם שעה — השעה שנבחרה
  const { planUrgent } = await import('../src/urgent.js');
  const other = await channel('ערב', 7);
  await q('update channels set default_hour = 19 where id = $1', [other.id]);
  const now = new Date(`${week.days[0].date}T06:00:00`);
  const u = await inOrg(() => planUrgent({ title: 'מבצע', channel_ids: [morning.id, other.id] }, { now }));
  assert.deepEqual(u.placements.map((p) => p.time).sort(), ['08:00', '19:00']);
  const fixed = await inOrg(() => planUrgent(
    { title: 'מבצע', channel_ids: [morning.id], time: '12:30' }, { now }));
  assert.equal(fixed.placements[0].time, '12:30');
  await wipe();
});

/* ========================= 13. מילוי אוטומטי: השבוע והבא ========================= */

test('סעיף 13 — שינוי ערוץ כשמוצג שבוע +5 ממלא את השבוע הנוכחי והבא, לא את +5', { skip }, async () => {
  await wipe();
  const { nearWeeks } = await import('../src/routes/_shared.js');
  const ch = await channel('פייסבוק', 7);
  const ep = await endpoint('נקודה');
  await items(ep.id, ch.id, 10, { prefix: 'שוטף' });
  const far = weekMeta(inDays(35)).start;
  const res = await call('PATCH', `/channels/${ch.id}`, { max_per_week: 7, week: far });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const near = nearWeeks();
  const posts = await q('select scheduled_at from posts where channel_id = $1', [ch.id]);
  const weeks = new Set(posts.map((p) => weekOf(p.scheduled_at)));
  assert.ok(!weeks.has(far), 'השבוע המוצג לא התמלא');
  assert.ok([...weeks].every((w) => near.includes(w)), JSON.stringify([...weeks]));
  assert.ok(weeks.has(near[1]), 'השבוע הבא התמלא');
  // התשובה מכסה את שני השבועות — "בטל" אחד לכולם
  assert.deepEqual(res.json.engine.covered_weeks, near);
  assert.equal(res.json.engine.created_ids.length, posts.length);
  await wipe();
});

test('סעיף 13 — המילוי היומי ממלא את השבוע והבא פעם אחת; ריצה חוזרת לא מוסיפה', { skip }, async () => {
  await wipe();
  const { nearWeeks } = await import('../src/routes/_shared.js');
  const { dailyFillOrg } = await import('../src/maintenance.js');
  const ch = await channel('פייסבוק', 3);
  const ep = await endpoint('נקודה');
  await items(ep.id, ch.id, 12, { prefix: 'שוטף' });
  const first = await inOrg(() => dailyFillOrg());
  assert.ok(first.placed >= 3, JSON.stringify(first.summary));
  const posts = await q('select scheduled_at from posts where channel_id = $1', [ch.id]);
  const near = nearWeeks();
  assert.ok(posts.every((p) => near.includes(weekOf(p.scheduled_at))));
  assert.ok(posts.some((p) => weekOf(p.scheduled_at) === near[1]));
  const second = await inOrg(() => dailyFillOrg());
  assert.equal(second.placed, 0);
  assert.equal((await q('select id from posts')).length, posts.length);
  // ביומן הפעולות — פעם אחת, כמערכת
  const log = await q("select via, summary from activity_log where entity = 'engine'");
  assert.equal(log.length, 1);
  assert.equal(log[0].via, 'system');
  assert.match(log[0].summary, /מילוי יומי/);
  await wipe();
});
