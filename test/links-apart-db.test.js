import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * פוסטים מקושרים לא באותו יום (links_apart) ומכסות לפוסט ידני, מול Postgres
 * אמיתי: המנוע (planWeek) משבץ מקור ועוקבת בימים שונים, ומאפשר אותו יום כשהקמפיין
 * כיבה את הכלל; בלוח — אזהרות שאפשר לאשר (פוסט מקושר, פוסטים בשבוע, תקרה
 * לסוג, מכירתי ליום) וחסימות של פוסט ידני (יום חסום, אותה נקודה באותו יום).
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * כל הרצה בארגון חדש משלה.
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

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');

  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'links_apart'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('links-apart-test') returning id")).rows[0].id;
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
  app.use(board);
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

/**
 * נקודה, שני ערוצים (חסומים בכל הימים חוץ מ-open), קמפיין כללי בשבוע
 * 17–23.11.2030 על שניהם, ומקור (ערוץ A) + עוקבת מקושרת (ערוץ B) מוכנים.
 */
async function linkedSetup({ apart = true, openA = null, openB = null, name = 'קישור' } = {}) {
  const blocked = (open) => (open ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !open.includes(d)) : []);
  return inOrg(async () => {
    const ep = (await db.one(
      "insert into endpoints (name, importance) values ($1, 5) returning id", [name])).id;
    const mkCh = async (n, open) => (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct, blocked_days)
       values ($1, 'manual', 7, 0, $2) returning id`, [n, blocked(open)])).id;
    const a = await mkCh(`${name} A`, openA);
    const b = await mkCh(`${name} B`, openB);
    const camp = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, links_apart)
       values ($1, $2, '2030-11-17', '2030-11-23', 'general', $3) returning id`,
      [ep, name, apart])).id;
    await db.query('insert into campaign_channels values ($1,$2), ($1,$3)', [camp, a, b]);
    const mkItem = async (title, ch, linkedTo = null) => {
      const it = (await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, slot_channel_id, linked_to_id)
         values ($1,$2,'value',$3,$4,$5) returning id`, [ep, camp, title, ch, linkedTo])).id;
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'x','ready')`,
        [it, ch]);
      return it;
    };
    const root = await mkItem(`${name} מקור`, a);
    const follower = await mkItem(`${name} עוקבת`, b, root);
    return { ep, a, b, camp, root, follower };
  });
}

async function cleanup(s) {
  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1 or channel_id = any($2::int[])',
      [s.ep, [s.a, s.b]]);
    await db.query('update content_items set linked_to_id = null where campaign_id = $1', [s.camp]);
    await db.query('delete from content_items where campaign_id = $1', [s.camp]);
    await db.query('delete from campaigns where id = $1', [s.camp]);
    await db.query('delete from channels where id = any($1::int[])', [[s.a, s.b]]);
    await db.query('delete from endpoints where id = $1', [s.ep]);
  });
}

const NOW = new Date('2030-11-01T08:00:00');
const plan = () => inOrg(async () => {
  const { planWeek } = await import('../src/engine.js');
  return planWeek('2030-11-19', { holes: false, now: NOW });
});

test('המנוע: מקור ועוקבת בשני ערוצים, שבוע פנוי — בימים שונים', { skip }, async () => {
  const s = await linkedSetup({ name: 'פנוי' });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [s.root, s.follower].includes(x.content_id));
    assert.equal(mine.length, 2, JSON.stringify(mine.map((x) => [x.title, x.date])));
    assert.notEqual(mine[0].date, mine[1].date);
  } finally {
    await cleanup(s);
  }
});

test('המנוע: שני הערוצים פתוחים רק ביום שני — אחד בלבד; links_apart כבוי — שניהם באותו יום', { skip }, async () => {
  const on = await linkedSetup({ name: 'שני', openA: [1], openB: [1] });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [on.root, on.follower].includes(x.content_id));
    assert.equal(mine.length, 1, JSON.stringify(mine.map((x) => [x.title, x.date])));
  } finally {
    await cleanup(on);
  }

  const off = await linkedSetup({ name: 'כבוי', openA: [1], openB: [1], apart: false });
  try {
    const p = await plan();
    const mine = p.placements.filter((x) => [off.root, off.follower].includes(x.content_id));
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((x) => x.date), ['2030-11-18', '2030-11-18']);
  } finally {
    await cleanup(off);
  }
});

test('המנוע: מול פוסט קיים של המקור, ושיוך לפוסט חסר תוכן באותו יום — לא', { skip }, async () => {
  const s = await linkedSetup({ name: 'קיים', openB: [1] });
  try {
    await inOrg(async () => {
      // המקור כבר יוצא ב-18.11 בערוץ A; ב-B פוסט חסר תוכן של המנוע באותו יום
      await db.query(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
         values ($1,$2,$3,'מקור','value','2030-11-18T10:00:00+02:00')`, [s.a, s.ep, s.root]);
      await db.query(
        `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, auto_hole)
         values ($1,$2,'חסר תוכן','value','2030-11-18T12:00:00+02:00', true)`, [s.b, s.ep]);
    });
    const p = await plan();
    assert.ok(!p.attachments.some((x) => x.content_id === s.follower), 'לא משויכת לחסר התוכן');
    assert.ok(!p.placements.some((x) => x.content_id === s.follower), 'ולא משובצת (B פתוח רק ב-18.11)');

    // links_apart כבוי — השיוך עובר
    await inOrg(() => db.query('update campaigns set links_apart = false where id = $1', [s.camp]));
    const p2 = await plan();
    assert.ok(p2.attachments.some((x) => x.content_id === s.follower));
  } finally {
    await cleanup(s);
  }
});

/* ========================= אזהרות ידניות ========================= */

const at = (d, h = 10) => `2030-11-${d}T${String(h).padStart(2, '0')}:00:00+02:00`;
const insertPost = (x) => inOrg(async () => (await db.one(
  `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
   values ($1,$2,$3,$4,$5,$6,coalesce($7,'scheduled')) returning id`,
  [x.channel, x.ep ?? null, x.content ?? null, x.title ?? 'פוסט', x.kind ?? 'value', x.at,
   x.status ?? null])).id);

test('linkDayWarning — פוסט מקושר באותו יום (בכל ערוץ); יום אחר, links_apart כבוי ואותו פריט — לא', { skip }, async () => {
  const { linkDayWarning } = await import('../src/gap.js');
  const s = await linkedSetup({ name: 'אזהרת קישור' });
  try {
    const rootPost = await insertPost({ channel: s.a, ep: s.ep, content: s.root, title: 'המקור', at: at(18) });
    await inOrg(async () => {
      const w = await linkDayWarning({ contentId: s.follower, when: at(18, 20) });
      assert.match(w.message, /פוסט מקושר \("המקור", אזהרת קישור A\) כבר יוצא באותו יום/);
      assert.equal(w.other.id, rootPost);
      assert.equal(await linkDayWarning({ contentId: s.follower, when: at(19) }), null);
      // אותו פריט (המקור עצמו בערוץ אחר) — לא "מקושר"
      assert.equal(await linkDayWarning({ contentId: s.root, when: at(18, 20) }), null);
      // הפוסט עצמו לא נספר
      assert.equal(await linkDayWarning({ contentId: s.follower, when: at(18), excludePostId: rootPost }),
        null);
      // נכשל לא נספר
      await db.query("update posts set status = 'failed' where id = $1", [rootPost]);
      assert.equal(await linkDayWarning({ contentId: s.follower, when: at(18) }), null);
      await db.query("update posts set status = 'scheduled' where id = $1", [rootPost]);
      await db.query('update campaigns set links_apart = false where id = $1', [s.camp]);
      assert.equal(await linkDayWarning({ contentId: s.follower, when: at(18) }), null);
    });
  } finally {
    await cleanup(s);
  }
});

/** ערוץ עם מכסות לבדיקות המכסה: 2 בשבוע, מכירתי אחד בשבוע */
async function capSetup(name) {
  return inOrg(async () => {
    const ep = (await db.one("insert into endpoints (name, importance) values ($1, 5) returning id",
      [name])).id;
    const ep2 = (await db.one("insert into endpoints (name, importance) values ($1, 5) returning id",
      [`${name} 2`])).id;
    const ch = (await db.one(
      `insert into channels (name, platform, max_per_week, max_promo_per_week, urgent_reserve_pct,
                             blocked_days)
       values ($1, 'manual', 2, 1, 0, '{6}') returning id`, [name])).id;
    const other = (await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ($1, 'manual', 7, 0) returning id`, [`${name} אחר`])).id;
    return { ep, ep2, ch, other };
  });
}
const capCleanup = (s) => inOrg(async () => {
  await db.query('delete from posts where channel_id = any($1::int[])', [[s.ch, s.other]]);
  await db.query('delete from channels where id = any($1::int[])', [[s.ch, s.other]]);
  await db.query('delete from endpoints where id = any($1::int[])', [[s.ep, s.ep2]]);
});

test('capWarning — פוסטים בשבוע, תקרה לסוג, מכירתי ליום; הזזה בתוך אותה משבצת — בלי אזהרה', { skip }, async () => {
  const { capWarning } = await import('../src/gap.js');
  const s = await capSetup('מכסות');
  try {
    const p1 = await insertPost({ channel: s.ch, ep: s.ep, kind: 'promo', at: at(18) });
    await insertPost({ channel: s.ch, ep: s.ep2, kind: 'value', at: at(19) });
    // בשבוע אחר (24.11 = ראשון הבא) — לא נספר
    await insertPost({ channel: s.ch, ep: s.ep, kind: 'value', at: at(24) });
    await inOrg(async () => {
      const w = await capWarning({ channelId: s.ch, when: at(20), kind: 'promo' });
      assert.equal(w.caps.length, 2, w.message);
      assert.match(w.message, /בשבוע הזה כבר 2 מתוך 2 פוסטים בשבוע במכסות\./);
      assert.match(w.message, /כבר 1 מתוך 1 פוסטים מסוג מכירתי במכסות/);
      // value — רק התקציב השבועי
      const v = await capWarning({ channelId: s.ch, when: at(20), kind: 'value' });
      assert.equal(v.caps.length, 1);
      // שבוע הבא — 1 מתוך 2, אין אזהרה
      assert.equal(await capWarning({ channelId: s.ch, when: at(25), kind: 'value' }), null);
      // הפוסט עצמו זז בתוך אותו שבוע ואותו ערוץ — לא שואלים שוב
      assert.equal(await capWarning({ channelId: s.ch, when: at(21), kind: 'promo', excludePostId: p1 }),
        null);
      // מכירתי ליום — בכל הערוצים (ברירת מחדל 1)
      const d = await capWarning({ channelId: s.other, when: at(18, 15), kind: 'promo' });
      assert.match(d.message, /ביום הזה כבר פוסט מכירתי אחד בכל הערוצים, והמקסימום ליום הוא 1/);
      assert.equal(await capWarning({ channelId: s.other, when: at(19, 15), kind: 'promo' }), null);
    });
  } finally {
    await capCleanup(s);
  }
});

test('POST /posts — יום חסום ואותה נקודה באותו יום נחסמים; מכסה — אזהרה ואישור (confirm_warnings / confirm_gap)', { skip }, async () => {
  const s = await capSetup('ידני');
  try {
    // 23.11.2030 = שבת, חסומה בערוץ
    const sat = await call('POST', '/posts',
      { channel_id: s.ch, endpoint_id: s.ep, title: 'שבת', kind: 'value', scheduled_at: at(23) });
    assert.equal(sat.status, 400);
    assert.match(sat.json.error, /לא מקבל תוכן בימי שבת/);

    const first = await call('POST', '/posts',
      { channel_id: s.ch, endpoint_id: s.ep, title: 'ראשון', kind: 'value', scheduled_at: at(18) });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const same = await call('POST', '/posts',
      { channel_id: s.ch, endpoint_id: s.ep, title: 'שני', kind: 'value', scheduled_at: at(18, 15) });
    assert.equal(same.status, 400);
    assert.match(same.json.error, /כבר יש פוסט לאותה נקודת קצה/);

    await call('POST', '/posts',
      { channel_id: s.ch, endpoint_id: s.ep2, title: 'שני', kind: 'value', scheduled_at: at(19) });
    const over = { channel_id: s.ch, title: 'שלישי', kind: 'value', scheduled_at: at(20) };
    const warn = await call('POST', '/posts', over);
    assert.equal(warn.status, 409, JSON.stringify(warn.json));
    assert.equal(warn.json.needs_confirm, true);
    assert.match(warn.json.error, /2 מתוך 2 פוסטים בשבוע/);
    const ok = await call('POST', '/posts', { ...over, confirm_warnings: true });
    assert.equal(ok.status, 201);
    const legacy = await call('POST', '/posts', { ...over, title: 'רביעי', confirm_gap: true });
    assert.equal(legacy.status, 201);
  } finally {
    await capCleanup(s);
  }
});

test('PATCH /posts — הזזה לשבוע מלא: אזהרת מכסה; הזזה בתוך אותו שבוע — בלי', { skip }, async () => {
  const s = await capSetup('הזזה');
  try {
    await insertPost({ channel: s.ch, ep: s.ep, at: at(18) });
    await insertPost({ channel: s.ch, ep: s.ep2, at: at(19) });
    const mover = await insertPost({ channel: s.ch, at: at(25) });
    const inWeek = await insertPost({ channel: s.ch, at: at(26) });

    const warn = await call('PATCH', `/posts/${mover}`, { scheduled_at: at(20) });
    assert.equal(warn.status, 409, JSON.stringify(warn.json));
    assert.match(warn.json.error, /2 מתוך 2 פוסטים בשבוע/);
    const ok = await call('PATCH', `/posts/${mover}`, { scheduled_at: at(20), confirm_warnings: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    // עכשיו 3 בשבוע; הזזה של אחד מהם בתוך השבוע — אין אזהרה חוזרת
    const again = await call('PATCH', `/posts/${mover}`, { scheduled_at: at(21) });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    // שבוע 24–30 עם פוסט אחד — הזזה בתוכו בסדר
    assert.equal((await call('PATCH', `/posts/${inWeek}`, { scheduled_at: at(27) })).status, 200);
  } finally {
    await capCleanup(s);
  }
});

test('הלוח: פוסט מקושר באותו יום — הזזה ושיוך תוכן מזהירים, ואישור אחד לכל האזהרות', { skip }, async () => {
  const s = await linkedSetup({ name: 'לוח קישור' });
  try {
    await insertPost({ channel: s.a, ep: s.ep, content: s.root, title: 'המקור', at: at(18) });
    // פוסט חסר תוכן ב-B באותו יום → שיוך העוקבת
    const hole = await insertPost({ channel: s.b, ep: s.ep, title: 'חסר תוכן', at: at(18, 12) });
    const attach = await call('POST', `/posts/${hole}/attach-content`, { content_id: s.follower });
    assert.equal(attach.status, 409, JSON.stringify(attach.json));
    assert.match(attach.json.error, /פוסט מקושר \("המקור"/);
    const attached = await call('POST', `/posts/${hole}/attach-content`,
      { content_id: s.follower, confirm_warnings: true });
    assert.equal(attached.status, 200, JSON.stringify(attached.json));

    // הזזת העוקבת ליום אחר — בלי אזהרה; וחזרה ליום של המקור — אזהרה
    assert.equal((await call('PATCH', `/posts/${hole}`, { scheduled_at: at(19, 12) })).status, 200);
    const back = await call('PATCH', `/posts/${hole}`, { scheduled_at: at(18, 12) });
    assert.equal(back.status, 409, JSON.stringify(back.json));
    assert.match(back.json.error, /פוסט מקושר/);

    // שתי אזהרות יחד (קישור + מרווח מול פוסט של הנקודה ב-B ב-17.11): הודעה אחת, אישור אחד.
    // מרווח 3 על הקמפיין: ברירת המחדל כאן נגזרת מהערוץ (סעיף 5 — נקודה אחת, 7 בשבוע → 1)
    await inOrg(() => db.query('update campaigns set min_gap_days = 3 where id = $1', [s.camp]));
    await insertPost({ channel: s.b, ep: s.ep, title: 'שכן', at: at(17) });
    const both = await call('PATCH', `/posts/${hole}`, { scheduled_at: at(18, 12) });
    assert.equal(both.status, 409);
    assert.equal(both.json.warning.all.length, 2, both.json.error);
    assert.match(both.json.error, /פוסט מקושר/);
    assert.match(both.json.error, /המרווח שהוגדר/);
    const done = await call('PATCH', `/posts/${hole}`, { scheduled_at: at(18, 12), confirm_warnings: true });
    assert.equal(done.status, 200, JSON.stringify(done.json));

    // POST /posts עם תוכן מקושר באותו יום
    const direct = await call('POST', '/posts', { channel_id: s.b, title: 'ידני', kind: 'value',
      content_id: s.follower, scheduled_at: at(18, 16) });
    assert.equal(direct.status, 409, JSON.stringify(direct.json));
    assert.match(direct.json.error, /פוסט מקושר/);
  } finally {
    await cleanup(s);
  }
});

test('העוזר (move_post): ההצעה מציגה פוסט מקושר ומכסה, והאישור שולח confirm_warnings', { skip }, async () => {
  const { _internals } = await import('../src/assistant.js');
  const tool = _internals.WRITE_TOOLS.move_post;
  // ב2: confirm_warnings רק כשהבדיקה הציגה אזהרה רכה — לא על עיוור
  assert.deepEqual(tool.request({ post_id: 5, scheduled_at: at(18) }, { warnings: ['x'], confirm: true }),
    { method: 'PATCH', path: '/posts/5', body: { scheduled_at: at(18), confirm_warnings: true } });
  assert.deepEqual(tool.request({ post_id: 5, scheduled_at: at(18) }, { warnings: [], confirm: false }),
    { method: 'PATCH', path: '/posts/5', body: { scheduled_at: at(18) } });

  const s = await linkedSetup({ name: 'עוזר קישור' });
  const c = await capSetup('עוזר מכסה');
  try {
    await insertPost({ channel: s.a, ep: s.ep, content: s.root, title: 'המקור', at: at(18) });
    const follower = await insertPost({ channel: s.b, ep: s.ep, content: s.follower, at: at(20) });
    await insertPost({ channel: c.ch, ep: c.ep, at: at(18) });
    await insertPost({ channel: c.ch, ep: c.ep2, at: at(19) });
    const mover = await insertPost({ channel: c.ch, at: at(25) });
    await inOrg(async () => {
      const linked = await tool.check({ post_id: follower, scheduled_at: at(18, 12) });
      assert.ok(linked.warnings.some((w) => /פוסט מקושר \("המקור"/.test(w)), linked.warnings.join(' | '));
      const same = await tool.check({ post_id: follower, scheduled_at: at(20, 12) });
      assert.ok(!same.warnings.some((w) => /פוסט מקושר/.test(w)));
      const cap = await tool.check({ post_id: mover, scheduled_at: at(20) });
      assert.ok(cap.warnings.some((w) => /2 מתוך 2 פוסטים בשבוע/.test(w)), cap.warnings.join(' | '));
    });
  } finally {
    await cleanup(s);
    await capCleanup(c);
  }
});

test('אותה נקודה באותו יום — יום לפי ישראל (01:00), ופוסט מוסתר של קמפיין מושהה לא חוסם', { skip }, async () => {
  const s = await capSetup('יום ישראל');
  try {
    // 19.11 01:00 בישראל = 18.11 23:00 UTC
    await insertPost({ channel: s.ch, ep: s.ep, title: 'לילה', at: '2030-11-19T01:00:00+02:00' });
    const prev = await call('POST', '/posts', { channel_id: s.ch, endpoint_id: s.ep, title: 'יום קודם',
      kind: 'value', scheduled_at: at(18, 12), confirm_warnings: true });
    assert.equal(prev.status, 201, JSON.stringify(prev.json));
    const same = await call('POST', '/posts', { channel_id: s.ch, endpoint_id: s.ep, title: 'אותו יום',
      kind: 'value', scheduled_at: at(19, 12), confirm_warnings: true });
    assert.equal(same.status, 400);
    assert.match(same.json.error, /לילה/);
    // מועד שנשלח ב-UTC (18.11 22:30Z = 19.11 00:30 בישראל) — אותו יום בישראל, נחסם
    const utc = await call('POST', '/posts', { channel_id: s.ch, endpoint_id: s.ep, title: 'UTC',
      kind: 'value', scheduled_at: '2030-11-18T22:30:00Z', confirm_warnings: true });
    assert.equal(utc.status, 400, JSON.stringify(utc.json));
    assert.match(utc.json.error, /לילה/, 'מול הפוסט של 19.11, לא של 18.11');
    // הזזה (PATCH) של הפוסט מ-18.11 ל-19.11 — אותה חסימה
    const moved = await call('PATCH', `/posts/${prev.json.post.id}`,
      { scheduled_at: at(19, 15), confirm_warnings: true });
    assert.equal(moved.status, 400);

    // פוסט של קמפיין מושהה ב-20.11 — ירד מהלוח ולא חוסם
    const camp = await inOrg(async () => {
      const c = (await db.one(
        `insert into campaigns (endpoint_id, name, paused_at) values ($1, 'מושהה', now()) returning id`,
        [s.ep])).id;
      const it = (await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title) values ($1,$2,'value','x')
         returning id`, [s.ep, c])).id;
      return { c, it };
    });
    await insertPost({ channel: s.ch, ep: s.ep, content: camp.it, title: 'מוסתר', at: at(20) });
    const hidden = await call('POST', '/posts', { channel_id: s.ch, endpoint_id: s.ep, title: 'מעל מוסתר',
      kind: 'value', scheduled_at: at(20, 15), confirm_warnings: true });
    assert.equal(hidden.status, 201, JSON.stringify(hidden.json));
    await inOrg(async () => {
      await db.query('delete from posts where channel_id = $1', [s.ch]);
      await db.query('delete from content_items where campaign_id = $1', [camp.c]);
      await db.query('delete from campaigns where id = $1', [camp.c]);
    });
  } finally {
    await capCleanup(s);
  }
});

test('פוסט מוסתר של קמפיין מושהה לא נספר — לא במכסה ולא ביום של קבוצת הקישור', { skip }, async () => {
  const { capWarning } = await import('../src/gap.js');
  const s = await capSetup('מכסה מושהה');
  try {
    const camp = await inOrg(async () => {
      const c = (await db.one(
        `insert into campaigns (endpoint_id, name, paused_at) values ($1, 'מושהה', now()) returning id`,
        [s.ep])).id;
      const it = (await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title) values ($1,$2,'promo','x')
         returning id`, [s.ep, c])).id;
      return { c, it };
    });
    // שני פוסטים מוסתרים בשבוע (אחד מכירתי) ופוסט אחד חי — 1 מתוך 2, אין אזהרה
    await insertPost({ channel: s.ch, ep: s.ep, content: camp.it, kind: 'promo', at: at(18) });
    await insertPost({ channel: s.ch, ep: s.ep, content: camp.it, at: at(19) });
    await insertPost({ channel: s.ch, ep: s.ep2, at: at(20) });
    await inOrg(async () => {
      assert.equal(await capWarning({ channelId: s.ch, when: at(21), kind: 'promo' }), null);
      assert.equal(await capWarning({ channelId: s.other, when: at(18, 15), kind: 'promo' }), null);
      // פורסם — נשאר תפוס גם בקמפיין מושהה
      await db.query("update posts set status = 'published' where content_id = $1 and kind = 'promo'",
        [camp.it]);
      const w = await capWarning({ channelId: s.ch, when: at(21), kind: 'promo' });
      assert.match(w.message, /2 מתוך 2 פוסטים בשבוע/);
      await db.query('delete from posts where channel_id = $1', [s.ch]);
      await db.query('delete from content_items where campaign_id = $1', [camp.c]);
      await db.query('delete from campaigns where id = $1', [camp.c]);
    });
  } finally {
    await capCleanup(s);
  }

  // המנוע: המקור משובץ ב-18.11 בקמפיין שהושהה ואז חזר — בזמן ההשהיה הוא לא תופס את היום
  const l = await linkedSetup({ name: 'קישור מושהה', openA: [1], openB: [1] });
  try {
    await insertPost({ channel: l.a, ep: l.ep, content: l.root, title: 'המקור', at: at(18) });
    await inOrg(() => db.query('update campaigns set paused_at = now() where id = $1', [l.camp]));
    const days = await inOrg(async () => (await import('../src/engine.js')).linkGroupDays(
      new Date('2030-11-17T00:00:00'), new Date('2030-11-23T23:59:59')));
    assert.equal(days.size, 0, 'פוסט מוסתר לא נספר');
    await inOrg(() => db.query('update campaigns set paused_at = null where id = $1', [l.camp]));
    const live = await inOrg(async () => (await import('../src/engine.js')).linkGroupDays(
      new Date('2030-11-17T00:00:00'), new Date('2030-11-23T23:59:59')));
    assert.deepEqual([...live.get(l.root).keys()], ['2030-11-18']);
  } finally {
    await cleanup(l);
  }
});
