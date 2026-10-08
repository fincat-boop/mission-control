import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 4 של שיפורי ההתנהגות (docs/behavior-improvements.md) מול Postgres אמיתי:
 *   16 — נקודה / ערוץ מושבתים = כמו קמפיין מושהה (לוח, טיק, נתחים, התראות,
 *        שלב הקמפיין), הפעלה מחדש מחזירה מאושר שעבר לאישור, מחיקת נקודה
 *        מוחקת את הפוסטים העתידיים שלה.
 *   22 — מחיקת תוכן מורידה את הפוסטים העתידיים שלו שלא פורסמו.
 *   ב2 — העוזר: אותן בדיקות כמו PATCH /posts, get_tasks כמו הטאב.
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/disable-delete-db.test.js
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;
const pending = new Set();
const currentUser = { id: null, name: 'בדיקה', is_owner: true };

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

const DAY = 86400000;
/** מועד עגול: days ימים מהיום, בשעה hour (שעון מקומי) */
function at(days, hour = 10) {
  const d = new Date(Date.now() + days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();

/** נקודת קצה חדשה (שם ייחודי) */
async function endpoint(name, active = true) {
  return (await q1('insert into endpoints (name, importance, active) values ($1, 5, $2) returning id',
    [`${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, active])).id;
}

/** תוכן מוכן לערוצים (גרסה מוכנה לכל אחד) */
async function content(ep, channels, { campaign = null, title = 'תוכן' } = {}) {
  return inOrg(async () => {
    const ci = (await db.one(
      `insert into content_items (endpoint_id, campaign_id, kind, title) values ($1,$2,'value',$3) returning id`,
      [ep, campaign, title])).id;
    for (const ch of channels) {
      await db.query(
        "insert into content_variants (content_id, channel_id, status, body) values ($1,$2,'ready','טקסט מוכן')",
        [ci, ch]);
    }
    return ci;
  });
}

/** פוסט ישירות במסד. when — ISO */
async function post({ channel = ids.fb, ep, contentId = null, title = 'פוסט', when, status = 'scheduled',
                      autoHole = false, publishedAt = null } = {}) {
  return (await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status, auto_hole,
                        published_at)
     values ($1,$2,$3,$4,'value',$5,$6,$7,$8) returning id`,
    [channel, ep, contentId, title, when, status, autoHole, publishedAt])).id;
}

const statusOf = async (id) => (await q1('select status from posts where id = $1', [id]))?.status ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const routes = await Promise.all(['board', 'tasks', 'endpoints', 'channels', 'content']
    .map(async (n) => (await import(`../src/routes/${n}.js`)).default));
  const { encryptSecret } = await import('../src/publish/crypto.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('disable-delete-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ch = async (name, platform) => (await db.one(
      'insert into channels (name, platform, max_per_week) values ($1,$2,20) returning id',
      [name, platform])).id;
    const fb = await ch('פייסבוק', 'facebook');
    const ig = await ch('אינסטגרם', 'instagram');
    await db.query(
      `insert into channel_connections (channel_id, page_id, access_token_enc, auto_enabled)
       values ($1, '9', $2, true)`, [fb, encryptSecret('tok')]);
    return { fb, ig };
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
  for (const r of routes) app.use(r);
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

/* ========================= 16 — נקודה מושבתת ========================= */

test('16 — נקודה מושבתת: יורדת מהלוח לרשימת המוחזקים, ונספרת בחלון האישור', { skip }, async () => {
  const { buildBoard } = await import('../src/board.js');
  const live = await endpoint('חיה');
  const off = await endpoint('מושבתת');
  const when = at(2);
  const kept = await post({ ep: live, when, title: 'נשאר' });
  const held = await post({ ep: off, when, title: 'מוחזק' });
  const approved = await post({ ep: off, channel: ids.ig, when, title: 'מאושר', status: 'approved' });

  const impact = await call('GET', `/endpoints/${off}/delete-impact`);
  assert.equal(impact.json.impact.future_posts, 2);
  assert.equal(impact.json.impact.future_approved, 1);

  const r = await call('PATCH', `/endpoints/${off}`, { active: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const b = await inOrg(() => buildBoard(when));
  const onGrid = b.channels.flatMap((c) => c.days.flatMap((d) => d.posts.map((p) => p.id)));
  assert.ok(onGrid.includes(kept));
  assert.ok(!onGrid.includes(held) && !onGrid.includes(approved));
  const h = b.held_endpoints.find((x) => x.id === off);
  assert.equal(h?.n, 2, JSON.stringify(b.held_endpoints));
  // מה שנספר בסיכום הוא רק מה שעל הלוח
  assert.equal(b.summary.total, onGrid.length);
});

test('16 — נקודה מושבתת: הקמפיין שלה לא מתחרה על נתח, ושלב "הנקודה מושבתת"', { skip }, async () => {
  const { CAMPAIGNS_WEIGHTED_SQL, campaignsWithHealth } = await import('../src/campaigns.js');
  const { normalizeShares } = await import('../src/capacity.js');
  const live = await endpoint('נתח-חיה');
  const off = await endpoint('נתח-מושבתת');
  const start = at(-3).slice(0, 10);
  const end = at(20).slice(0, 10);
  const mk = (ep, name) => q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on) values ($1,$2,$3,$4) returning id`,
    [ep, name, start, end]);
  const cLive = (await mk(live, 'רץ')).id;
  const cOff = (await mk(off, 'בנקודה מושבתת')).id;
  await call('PATCH', `/endpoints/${off}`, { active: false });

  const today = at(0).slice(0, 10);
  const shares = normalizeShares(await qa(CAMPAIGNS_WEIGHTED_SQL), { from: today, to: today });
  assert.ok(shares.has(cLive));
  assert.ok(!shares.has(cOff), 'קמפיין של נקודה מושבתת לא מקבל נתח');

  const list = await inOrg(() => campaignsWithHealth());
  const c = list.find((x) => x.id === cOff);
  assert.equal(c.phase, 'paused');
  assert.equal(c.status.key, 'endpoint_off');
  assert.equal(c.status.label, 'הנקודה מושבתת');
  assert.equal(list.find((x) => x.id === cLive).phase, 'running');
});

test('16 — נקודה / ערוץ מושבתים: בלי התראות חסר תוכן, נכשל, ממתין לאישור ולא סומן כפורסם', { skip }, async () => {
  const { buildAlerts } = await import('../src/alerts.js');
  const { unconfirmedPosts } = await import('../src/unconfirmed.js');
  const live = await endpoint('התראות-חיה');
  const off = await endpoint('התראות-מושבתת');
  const chOff = (await q1(
    "insert into channels (name, platform, max_per_week) values ('ערוץ כבוי', 'manual', 7) returning id")).id;

  const make = async (ep, channel) => ({
    hole: await post({ ep, channel, when: minutes(60 * 5), title: 'חור', autoHole: true }),
    failed: await post({ ep, channel, when: minutes(-60), title: 'נכשל', status: 'failed' }),
    pend: await post({ ep, channel, when: at(1), title: 'ממתין', status: 'pending_approval' }),
    past: await post({ ep, channel, contentId: await content(ep, [channel]), when: minutes(-180),
                       title: 'עבר' }),
  });
  const a = await make(live, ids.fb);
  const b = await make(off, ids.fb);
  const c = await make(live, chOff);
  await call('PATCH', `/endpoints/${off}`, { active: false });
  await call('PATCH', `/channels/${chOff}`, { active: false });

  const { alerts } = await inOrg(() => buildAlerts(null));
  const has = (id) => alerts.some((x) => x.id === id);
  // הביקורת: אותם פוסטים בנקודה ובערוץ פעילים — מתריעים
  assert.ok(has(`no-text-${a.hole}`) && has(`post-failed-${a.failed}`) && has(`approval-${a.pend}`),
    alerts.map((x) => x.id).join(' '));
  for (const x of [b, c]) {
    assert.ok(!has(`no-text-${x.hole}`), 'חסר תוכן');
    assert.ok(!has(`post-failed-${x.failed}`), 'נכשל');
    assert.ok(!has(`approval-${x.pend}`), 'ממתין לאישור');
  }
  const unconf = (await inOrg(() => unconfirmedPosts())).map((p) => p.id);
  assert.ok(unconf.includes(a.past));
  assert.ok(!unconf.includes(b.past) && !unconf.includes(c.past));
});

test('16 — הטיק לא מפרסם פוסט מאושר של נקודה מושבתת', { skip }, async () => {
  const runner = await import('../src/publish/runner.js');
  const live = await endpoint('טיק-חיה');
  const off = await endpoint('טיק-מושבתת', false);
  // רק הפוסטים של הבדיקה הזו מאושרים בארגון
  await inOrg(() => db.query("update posts set status = 'scheduled' where status = 'approved'"));
  const go = await post({ ep: live, contentId: await content(live, [ids.fb]), when: minutes(-1),
                          status: 'approved', title: 'יוצא' });
  const stay = await post({ ep: off, contentId: await content(off, [ids.fb]), when: minutes(-1),
                            status: 'approved', title: 'מוחזק' });
  await inOrg(() => db.query('update engine_settings set autopublish_enabled = true'));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: `9_${calls.length}` }), { status: 200 });
  };
  try {
    await runner.publishTickForOrg(org);
  } finally {
    globalThis.fetch = realFetch;
    await inOrg(() => db.query('update engine_settings set autopublish_enabled = false'));
  }
  assert.equal(await statusOf(go), 'published');
  assert.equal(await statusOf(stay), 'approved');
  assert.equal(calls.filter((u) => u.includes('/9/feed')).length, 1);
});

test('16 — הפעלה מחדש: מאושר שהמועד שלו עבר בזמן ההשבתה חוזר לאישור; עתידי נשאר מאושר', { skip }, async () => {
  const ep = await endpoint('הפעלה', false);
  const missed = await post({ ep, when: minutes(-120), status: 'approved', title: 'פוספס' });
  const future = await post({ ep, when: at(3), status: 'approved', title: 'עתידי' });
  const r = await call('PATCH', `/endpoints/${ep}`, { active: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.approval_reset, 1);
  assert.equal(await statusOf(missed), 'scheduled');
  assert.equal(await statusOf(future), 'approved');
  // שמירה שלא משנה את מצב ההפעלה — לא נוגעת
  const again = await call('PATCH', `/endpoints/${ep}`, { importance: 6 });
  assert.equal(again.json.approval_reset, 0);

  const ch = (await q1(
    "insert into channels (name, platform, max_per_week, active) values ('חוזר', 'manual', 7, false) returning id")).id;
  const chMissed = await post({ ep, channel: ch, when: minutes(-90), status: 'approved', title: 'ערוץ פוספס' });
  const rc = await call('PATCH', `/channels/${ch}`, { active: true });
  assert.equal(rc.json.approval_reset, 1);
  assert.equal(await statusOf(chMissed), 'scheduled');
});

test('16 — ערוץ: חלון ההשבתה סופר פוסטים עתידיים שיוחזקו', { skip }, async () => {
  const ep = await endpoint('ערוץ-ספירה');
  const ch = (await q1(
    "insert into channels (name, platform, max_per_week) values ('לספירה', 'manual', 7) returning id")).id;
  await post({ ep, channel: ch, when: at(2) });
  await post({ ep, channel: ch, when: at(3), status: 'approved' });
  await post({ ep, channel: ch, when: minutes(-60) });
  await post({ ep, channel: ch, when: at(-5), status: 'published', publishedAt: at(-5) });
  const r = await call('GET', `/channels/${ch}/delete-impact`);
  assert.equal(r.json.impact.future_posts, 2);
  assert.equal(r.json.impact.future_approved, 1);
});

test('16 — מחיקת נקודה: הפוסטים העתידיים שלה שלא פורסמו נמחקים; פורסם ועבר נשארים', { skip }, async () => {
  const ep = await endpoint('למחיקה');
  const ci = await content(ep, [ids.fb]);
  const future = await post({ ep, contentId: ci, when: at(4), title: 'עתידי' });
  const futureApproved = await post({ ep, channel: ids.ig, when: at(5), status: 'approved' });
  const published = await post({ ep, contentId: ci, when: at(-4), status: 'published', publishedAt: at(-4) });
  const past = await post({ ep, when: minutes(-300), title: 'עבר' });

  const r = await call('DELETE', `/endpoints/${ep}?force=1`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.removed_posts, 2);
  const left = await qa('select id, endpoint_id, content_id from posts where id = any($1)',
    [[future, futureApproved, published, past]]);
  assert.deepEqual(left.map((p) => p.id).sort((x, y) => x - y), [published, past].sort((x, y) => x - y));
  assert.ok(left.every((p) => p.endpoint_id === null));
});

/* ========================= 22 — מחיקת תוכן ========================= */

test('22 — מחיקת תוכן: העתידיים שלא פורסמו יורדים; פורסם, ומה שהמועד שלו עבר, נשארים', { skip }, async () => {
  const ep = await endpoint('תוכן-למחיקה');
  const ci = await content(ep, [ids.fb, ids.ig]);
  const a = await post({ ep, contentId: ci, when: at(2), title: 'א' });
  const b = await post({ ep, contentId: ci, channel: ids.ig, when: at(3), status: 'approved', title: 'ב' });
  const pub = await post({ ep, contentId: ci, when: at(-3), status: 'published', publishedAt: at(-3) });
  const past = await post({ ep, contentId: ci, when: minutes(-200), title: 'עבר' });

  const imp = await call('GET', `/content/${ci}/delete-impact`);
  assert.deepEqual(imp.json.posts.map((p) => p.id), [a, b]);
  assert.ok(imp.json.posts[0].channel_name);

  const r = await call('DELETE', `/content/${ci}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.removed_posts, 2);
  const left = await qa('select id, content_id from posts where id = any($1) order by id', [[a, b, pub, past]]);
  assert.deepEqual(left.map((p) => p.id), [pub, past].sort((x, y) => x - y));
  assert.ok(left.every((p) => p.content_id === null));
});

/* ========================= ב2 — העוזר ========================= */

test('ב2 — move_post: חלון הקמפיין מוצג ומאושר; מועד שעבר = שגיאה; ביטול אישור נאמר', { skip }, async () => {
  const { _internals } = await import('../src/assistant.js');
  const tool = _internals.WRITE_TOOLS.move_post;
  const ep = await endpoint('עוזר');
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on) values ($1,'השקה',$2,$3) returning id`,
    [ep, at(1).slice(0, 10), at(6).slice(0, 10)])).id;
  const ci = await content(ep, [ids.fb, ids.ig], { campaign: camp });
  const p = await post({ ep, contentId: ci, when: at(2), title: 'בתוך החלון' });

  await inOrg(async () => {
    const out = await tool.check({ post_id: p, scheduled_at: at(9) });
    assert.ok(!out.error, out.error);
    assert.ok(out.warnings.some((w) => /שייך לקמפיין "השקה"/.test(w)), out.warnings.join(' | '));
    assert.equal(out.confirm, true);
    // אין אזהרה רכה — אין confirm_warnings בבקשה
    const quiet = await tool.check({ post_id: p, scheduled_at: at(3) });
    assert.equal(quiet.confirm, false, quiet.warnings.join(' | '));
    assert.ok(!('confirm_warnings' in tool.request({ post_id: p, scheduled_at: at(3) }, quiet).body));

    const past = await tool.check({ post_id: p, scheduled_at: minutes(-30) });
    assert.match(past.error ?? '', /זמן שעבר/);
  });

  await inOrg(() => db.query("update posts set status = 'approved' where id = $1", [p]));
  await inOrg(async () => {
    const moveCh = await tool.check({ post_id: p, channel_id: ids.ig });
    assert.ok(!moveCh.error, moveCh.error);
    assert.ok(moveCh.warnings.some((w) => /האישור לפרסום אוטומטי יבוטל/.test(w)), moveCh.warnings.join(' | '));
    const moveDay = await tool.check({ post_id: p, scheduled_at: at(4) });
    assert.ok(!moveDay.warnings.some((w) => /האישור/.test(w)), 'הזזת מועד לא מבטלת אישור');
  });
});

test('ב2 — move_post: התנגשות לפי כללי הלוח — פוסט של קמפיין מושהה לא חוסם, פוסט חי חוסם', { skip }, async () => {
  const { _internals } = await import('../src/assistant.js');
  const tool = _internals.WRITE_TOOLS.move_post;
  const ep = await endpoint('עוזר-התנגשות');
  const paused = (await q1(
    `insert into campaigns (endpoint_id, name, paused_at) values ($1,'מושהה',now()) returning id`, [ep])).id;
  await post({ ep, contentId: await content(ep, [ids.fb], { campaign: paused }), when: at(5, 9) });
  const mover = await post({ ep, when: at(4) });
  await inOrg(async () => {
    const ok = await tool.check({ post_id: mover, scheduled_at: at(5, 15) });
    assert.ok(!ok.error, ok.error);
  });
  await post({ ep, when: at(6, 9), title: 'חי' });
  await inOrg(async () => {
    const clash = await tool.check({ post_id: mover, scheduled_at: at(6, 15) });
    assert.match(clash.error ?? '', /באותו יום: חי/);
  });
});

test('ב2 — get_tasks: אותה רשימה כמו הטאב — בלי מה שנדחה ובלי מה שנפתר', { skip }, async () => {
  const { _internals } = await import('../src/assistant.js');
  const ep = await endpoint('משימות');
  const open = (await q1(
    "insert into tasks (title, kind, due_on) values ('פתוחה', 'general', current_date) returning id")).id;
  const snoozed = (await q1(
    `insert into tasks (title, kind, due_on, snoozed_until)
     values ('נדחתה', 'general', current_date, now() + interval '1 day') returning id`)).id;
  const pub = await post({ ep, when: at(-1), status: 'published', publishedAt: at(-1) });
  const resolved = (await q1(
    "insert into tasks (title, kind, post_id) values ('לכתוב', 'write', $1) returning id", [pub])).id;

  const out = await inOrg(() => _internals.READ_TOOLS.get_tasks.run({}, null));
  const shown = [...out.today, ...out.attention, ...out.upcoming].map((t) => t.id);
  assert.ok(shown.includes(open));
  assert.ok(!shown.includes(snoozed), 'משימה שנדחתה לא מוצגת');
  assert.ok(out.snoozed_count >= 1);
  assert.ok(!shown.includes(resolved), 'משימה שנפתרה נסגרת קודם (closeResolvedTasks)');
  assert.equal((await q1('select done from tasks where id = $1', [resolved])).done, true);
});

/* ========================= סבב 2 — מסירות מהסריקה, חזרה מהחזקה ========================= */

/** ערוץ ידני חדש לבדיקה (בלי שמורת דחופים) */
async function freshChannel(name, { max = 7, blocked = [] } = {}) {
  return (await q1(
    `insert into channels (name, platform, max_per_week, urgent_reserve_pct, blocked_days)
     values ($1, 'manual', $2, 0, $3::int[]) returning id`,
    [`${name}-${Date.now()}`, max, blocked])).id;
}

test('16 (מנוע) — פוסטים מוחזקים לא תופסים מקום בערוץ: המנוע משבץ במקומם', { skip }, async () => {
  const engine = await import('../src/engine.js');
  const ch = await freshChannel('מנוע', { max: 2 });
  const off = await endpoint('מנוע-מושבתת');
  const live = await endpoint('מנוע-חיה');
  const ci = await content(live, [ch], { title: 'מחכה למקום' });
  // שבוע רחוק: שני פוסטים של הנקודה (עוד פעילה) ממלאים את התקרה
  await post({ ep: off, channel: ch, when: '2031-09-16T10:00:00+03:00' });
  await post({ ep: off, channel: ch, when: '2031-09-18T10:00:00+03:00' });
  const now = new Date('2031-09-14T08:00:00+03:00');
  const placedHere = async () => (await inOrg(() => engine.planWeek('2031-09-14', { holes: false, now })))
    .placements.filter((p) => p.channel_id === ch && p.content_id === ci).length;
  assert.equal(await placedHere(), 0, 'התקרה מלאה בפוסטים חיים');
  await q1('update endpoints set active = false where id = $1 returning id', [off]);
  assert.equal(await placedHere(), 1, 'המוחזקים לא נספרים בתקרה');
});

test('16 (מכסות) — capWarning לא סופר פוסטים מוחזקים', { skip }, async () => {
  const { capWarning } = await import('../src/gap.js');
  const ch = await freshChannel('מכסה', { max: 2 });
  const off = await endpoint('מכסה-מושבתת');
  // שבוע רחוק וקבוע (שלישי–חמישי) — אותו שבוע לוח
  await post({ ep: off, channel: ch, when: '2031-10-07T09:00:00+03:00' });
  await post({ ep: off, channel: ch, when: '2031-10-08T09:00:00+03:00' });
  const when = '2031-10-09T12:00:00+03:00';
  const warnLive = await inOrg(() => capWarning({ channelId: ch, when, kind: 'value' }));
  assert.ok(warnLive?.caps.some((x) => /2 מתוך 2 פוסטים בשבוע/.test(x)), JSON.stringify(warnLive));
  await q1('update endpoints set active = false where id = $1 returning id', [off]);
  assert.equal(await inOrg(() => capWarning({ channelId: ch, when, kind: 'value' })), null);
});

test('16 (יום חסום) — פוסט מוחזק על יום חסום לא בהתראה ולא בפינוי', { skip }, async () => {
  const { postsOnBlockedDays } = await import('../src/respace.js');
  const when = at(3);
  const ch = await freshChannel('חסום', { blocked: [new Date(when).getDay()] });
  const live = await endpoint('חסום-חיה');
  const off = await endpoint('חסום-מושבתת');
  const a = await post({ ep: live, channel: ch, when });
  const b = await post({ ep: off, channel: ch, when, title: 'מוחזק' });
  await q1('update endpoints set active = false where id = $1 returning id', [off]);
  const ids = (await inOrg(() => postsOnBlockedDays())).map((p) => p.id);
  assert.ok(ids.includes(a));
  assert.ok(!ids.includes(b));
});

test('16 (הפעלה מחדש) — שום דבר לא נמחק: הפוסטים חוזרים למקומם, מאושר שעבר — לאישור', { skip }, async () => {
  const ep = await endpoint('חזרה');
  const ch = await freshChannel('חזרה');
  const ci = await content(ep, [ch], { title: 'שובץ ביד' });
  const when = at(2);
  const manual = await post({ ep, channel: ch, contentId: ci, when, title: 'ידני' });
  const kept = await post({ ep, channel: ch, when: at(4), status: 'approved', title: 'מאושר' });
  const missed = await post({ ep, channel: ch, when: minutes(-60), status: 'approved', title: 'פוספס' });
  const pub = await post({ ep, channel: ch, when: at(-2), status: 'published', publishedAt: at(-2) });
  await call('PATCH', `/endpoints/${ep}`, { active: false });
  // ההשבתה הייתה לפני שעתיים — "פוספס" (לפני שעה) נפל בזמן ההשבתה
  await q1(`update endpoints set disabled_at = now() - interval '2 hours' where id = $1 returning id`, [ep]);

  const imp = await call('GET', `/endpoints/${ep}/delete-impact`);
  assert.equal(imp.json.impact.missed_approved, 1);
  assert.equal(imp.json.impact.future_posts, 2);
  const r = await call('PATCH', `/endpoints/${ep}`, { active: true, week: when });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.back, 2);
  assert.equal(r.json.approval_reset, 1);
  const p = await q1('select status, scheduled_at, content_id from posts where id = $1', [manual]);
  assert.equal(p.status, 'scheduled', 'פוסט שובץ ביד לא נמחק');
  assert.equal(new Date(p.scheduled_at).toISOString(), when, 'ונשאר באותו מקום');
  assert.equal(p.content_id, ci);
  assert.equal(await statusOf(kept), 'approved');
  assert.equal(await statusOf(missed), 'scheduled');
  assert.equal(await statusOf(pub), 'published');

  // ערוץ: אותו כלל
  const ch2 = await freshChannel('חזרה-ערוץ');
  const s2 = await post({ ep, channel: ch2, when: at(5), title: 'בערוץ' });
  await call('PATCH', `/channels/${ch2}`, { active: false });
  const rc = await call('PATCH', `/channels/${ch2}`, { active: true });
  assert.equal(rc.json.back, 1);
  assert.equal(await statusOf(s2), 'scheduled');
});

test('16 (שייך תוכן) — תוכן של נקודה מושבתת לא מוצע', { skip }, async () => {
  const { contentCandidates } = await import('../src/engine.js');
  const ch = await freshChannel('מועמדים');
  const live = await endpoint('מועמדים-חיה');
  const off = await endpoint('מועמדים-מושבתת');
  const a = await content(live, [ch], { title: 'חי' });
  const b = await content(off, [ch], { title: 'מוחזק' });
  await q1('update endpoints set active = false where id = $1 returning id', [off]);
  const list = (await inOrg(() => contentCandidates({ channelId: ch, date: at(2).slice(0, 10) })))
    .map((c) => c.id);
  assert.ok(list.includes(a));
  assert.ok(!list.includes(b));
});

test('16 (קמפיין) — החזרה מהשהיה: מאושר שהמועד שלו עבר חוזר לאישור', { skip }, async () => {
  const ep = await endpoint('השהיה');
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, paused_at)
     values ($1, 'מושהה', $2, $3, now() - interval '3 hours') returning id`,
    [ep, at(-5).slice(0, 10), at(20).slice(0, 10)])).id;
  const ci = await content(ep, [ids.fb], { campaign: camp });
  const missed = await post({ ep, contentId: ci, when: minutes(-90), status: 'approved' });
  const imp = await call('GET', `/campaigns/${camp}/pause-impact`);
  assert.equal(imp.json.resume.missed_approved, 1);
  const r = await call('POST', `/campaigns/${camp}/resume`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.approval_reset, 1);
  assert.equal(await statusOf(missed), 'scheduled');
});

test('ייבוא חוזר שמשנה סוג — הסוג עובר לפוסטים העתידיים של הפריט', { skip }, async () => {
  const ep = await endpoint('ייבוא-סוג');
  const ch = await freshChannel('ייבוא-סוג');
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period, min_gap_days)
     values ($1, 'כללי', $2, $3, 'general', 'custom', 1) returning id`,
    [ep, at(1).slice(0, 10), at(28).slice(0, 10)])).id;
  await q1('insert into campaign_channels values ($1, $2) returning campaign_id', [camp, ch]);
  const chName = (await q1('select name from channels where id = $1', [ch])).name;

  const first = await call('POST', `/campaigns/${camp}/import`, { text: `סוג\t${chName}\nערך\tטקסט` });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const item = (await q1('select id from content_items where campaign_id = $1', [camp])).id;
  const future = await post({ ep, channel: ch, contentId: item, when: at(5) });
  const past = await post({ ep, channel: ch, contentId: item, when: minutes(-120) });

  const again = await call('POST', `/campaigns/${camp}/import`,
    { text: `סוג\t${chName}\nמכירתי\tטקסט מתוקן`, existing: 'update' });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.equal(again.json.updated, 1);
  // הפוסט שלנו, ואולי גם מה שהמילוי אחרי הייבוא הראשון שיבץ לפריט
  assert.ok(again.json.kind_posts >= 1, JSON.stringify(again.json));
  const kinds = await qa('select id, kind from posts where id = any($1)', [[future, past]]);
  assert.equal(kinds.find((p) => p.id === future).kind, 'promo');
  const stale = await qa(
    `select id from posts where content_id = $1 and kind <> 'promo'
        and status in ('scheduled','approved','failed','pending_approval') and scheduled_at > now()`, [item]);
  assert.deepEqual(stale, [], 'כל הפוסטים העתידיים של הפריט עברו לסוג החדש');
  assert.equal(kinds.find((p) => p.id === past).kind, 'value', 'מה שהמועד שלו עבר — לא נוגעים');
});

/* ========================= סבב 4 — disabled_at / paused_at ========================= */

test('16 — disabled_at: נקבע בהשבתה ומתאפס בהפעלה (טריגר)', { skip }, async () => {
  const ep = await endpoint('חותמת');
  await call('PATCH', `/endpoints/${ep}`, { active: false });
  assert.ok((await q1('select disabled_at from endpoints where id = $1', [ep])).disabled_at);
  await call('PATCH', `/endpoints/${ep}`, { importance: 4 });
  assert.ok((await q1('select disabled_at from endpoints where id = $1', [ep])).disabled_at, 'שמירה אחרת לא נוגעת');
  await call('PATCH', `/endpoints/${ep}`, { active: true });
  assert.equal((await q1('select disabled_at from endpoints where id = $1', [ep])).disabled_at, null);
  const ch = await freshChannel('חותמת');
  await call('PATCH', `/channels/${ch}`, { active: false });
  assert.ok((await q1('select disabled_at from channels where id = $1', [ch])).disabled_at);
});

test('16 — מחיקת נקודה מושבתת: מה שהוחזק נמחק, מה שלפני ההשבתה נשאר ומאושר חוזר לאישור', { skip }, async () => {
  const { unconfirmedPosts } = await import('../src/unconfirmed.js');
  const ep = await endpoint('מחיקה-מושבתת');
  const ch = await freshChannel('מחיקה-מושבתת');
  const preApproved = await post({ ep, channel: ch, when: minutes(-180), status: 'approved', title: 'לפני-מאושר' });
  const preScheduled = await post({ ep, channel: ch, when: minutes(-170), title: 'לפני' });
  await call('PATCH', `/endpoints/${ep}`, { active: false });
  // "עבר זמן": ההשבתה הייתה לפני שעתיים
  await q1(`update endpoints set disabled_at = now() - interval '2 hours' where id = $1 returning id`, [ep]);
  const heldPast = await post({ ep, channel: ch, when: minutes(-60), title: 'הוחזק' });
  const heldApproved = await post({ ep, channel: ch, when: minutes(-30), status: 'approved', title: 'הוחזק-מאושר' });
  const future = await post({ ep, channel: ch, when: at(3), title: 'עתידי' });

  const imp = (await call('GET', `/endpoints/${ep}/delete-impact`)).json.impact;
  assert.equal(imp.held_past, 2);
  assert.equal(imp.future_posts, 1);
  assert.equal(imp.past_open, 2);
  assert.equal(imp.missed_approved, 1);

  const r = await call('DELETE', `/endpoints/${ep}?force=1`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.removed_posts, 3);
  assert.equal(r.json.approval_reset, 1);
  for (const id of [heldPast, heldApproved, future]) assert.equal(await statusOf(id), null);
  assert.equal(await statusOf(preApproved), 'scheduled', 'לא יתפרסם באיחור אחרי שהנקודה נעלמה');
  assert.equal(await statusOf(preScheduled), 'scheduled');
  // אין מאושר שעבר בלי נקודה — לא "מאוחר מדי" ולא פרסום; המוחזקים לא ב"לא סומנו"
  const unconf = (await inOrg(() => unconfirmedPosts())).map((p) => p.id);
  assert.ok(!unconf.includes(heldPast) && !unconf.includes(heldApproved));
  assert.equal((await q1(
    `select count(*)::int as n from posts where id = any($1) and status = 'approved'`,
    [[preApproved, preScheduled]])).n, 0);

  // הושבתה לפני העמודה (disabled_at ריק): כל העבר שלא פורסם נחשב מוחזק
  const old = await endpoint('מושבתת-ותיקה', false);
  const oldPast = await post({ ep: old, channel: ch, when: minutes(-500), title: 'ותיק' });
  const oldPub = await post({ ep: old, channel: ch, when: at(-3), status: 'published', publishedAt: at(-3) });
  const r2 = await call('DELETE', `/endpoints/${old}?force=1`);
  assert.equal(r2.json.removed_posts, 1);
  assert.equal(await statusOf(oldPast), null);
  assert.equal(await statusOf(oldPub), 'published');
});

test('ב — החזרת קמפיין: רק מאושר שהמועד שלו אחרי ההשהיה חוזר לאישור', { skip }, async () => {
  const ep = await endpoint('השהיה-מתי');
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, paused_at)
     values ($1, 'מושהה', $2, $3, now() - interval '2 hours') returning id`,
    [ep, at(-5).slice(0, 10), at(20).slice(0, 10)])).id;
  const ci = await content(ep, [ids.fb], { campaign: camp });
  const before = await post({ ep, contentId: ci, when: minutes(-180), status: 'approved' });
  const during = await post({ ep, contentId: ci, when: minutes(-60), status: 'approved' });
  const imp = await call('GET', `/campaigns/${camp}/pause-impact`);
  assert.equal(imp.json.resume.missed_approved, 1);
  const r = await call('POST', `/campaigns/${camp}/resume`, {});
  assert.equal(r.json.approval_reset, 1);
  assert.equal(await statusOf(during), 'scheduled');
  assert.equal(await statusOf(before), 'approved', 'לפני ההשהיה — לא פוספס בגללה');
});
