import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * בדיקה מחדש של הפוסטים של קמפיין מול הכללים (revalidateCampaignPosts) אחרי
 * שינוי שמהדק אותם, מול Postgres אמיתי: סיום מוקדם יותר, מרווח גדול יותר,
 * "לא באותו יום" שנדלק, וקישור למשבצת שכבר משובצת. מה שלא עובר יורד מהלוח
 * והמילוי של הקמפיין משבץ אותו מחדש לפי הכללים.
 *
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<מסד> \
 *     TZ=Asia/Jerusalem node --test --test-concurrency=1 test/campaign-revalidate-db.test.js
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
  const { default: content } = await import('../src/routes/content.js');

  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'updated_at'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('campaign-revalidate-test') returning id")).rows[0].id;
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
const dayDiff = (a, b) => Math.round(Math.abs(new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / 86400000);

/**
 * נקודה, ערוצים (channels — כמה) וקמפיין כללי חדשים, ופוסט לכל אחד מ-posts:
 * {day, ch?: מספר הערוץ, status?, linkTo?: מספר הפוסט שזה עוקבת שלו}.
 * לכל פוסט פריט תוכן משלו (מוכן לערוץ), כדי שהמילוי יוכל לשבץ אותו מחדש.
 */
async function setup(name, { starts, ends, posts, gap = null, apart = true, channels = 1 }) {
  return inOrg(async () => {
    const ep = (await db.one(
      'insert into endpoints (name, importance) values ($1, 5) returning id', [name])).id;
    const chs = [];
    for (let i = 0; i < channels; i++) {
      chs.push((await db.one(
        `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
         values ($1, 'manual', 7, 0) returning id`, [`ערוץ ${name} ${i + 1}`])).id);
    }
    const camp = (await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct, structure,
                              min_gap_days, links_apart)
       values ($1, $2, $3, $4, 100, 'general', $5, $6) returning id`,
      [ep, name, inDays(starts), inDays(ends), gap, apart])).id;
    for (const ch of chs) await db.query('insert into campaign_channels values ($1, $2)', [camp, ch]);
    const out = [];
    for (const [i, p] of posts.entries()) {
      const ch = chs[p.ch ?? 0];
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order, slot_channel_id,
                                    linked_to_id)
         values ($1, $2, 'value', $3, $4, $5, $6) returning id`,
        [ep, camp, `${name} ${i + 1}`, i + 1, ch, p.linkTo != null ? out[p.linkTo].content : null]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status)
         values ($1, $2, 'x', 'ready')`, [it.id, ch]);
      const post = await db.one(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
         values ($1, $2, $3, $4, 'value', $5, $6) returning id`,
        [ch, ep, it.id, `${name} ${i + 1}`, at(p.day), p.status ?? 'scheduled']);
      out.push({ post: post.id, content: it.id });
    }
    return { ep, chs, camp, posts: out };
  });
}

async function cleanup({ ep, chs, camp }) {
  await inOrg(async () => {
    await db.query('delete from posts where channel_id = any($1::int[]) or endpoint_id = $2', [chs, ep]);
    await db.query('update content_items set linked_to_id = null where campaign_id = $1', [camp]);
    await db.query('delete from content_items where endpoint_id = $1', [ep]);
    await db.query('delete from campaigns where endpoint_id = $1', [ep]);
    await db.query('delete from channels where id = any($1::int[])', [chs]);
    await db.query('delete from endpoints where id = $1', [ep]);
  });
}

/** כל הפוסטים של הקמפיין, לפי המועד */
const campaignPosts = (camp) => q(
  `select p.id, p.content_id, p.channel_id, p.status, p.scheduled_at from posts p
     join content_items ci on ci.id = p.content_id
    where ci.campaign_id = $1 order by p.scheduled_at, p.id`, [camp]);
const exists = async (id) => !!(await q1('select id from posts where id = $1', [id]));

test('קיצור הסיום: מה שאחרי הסיום החדש יורד ומשובץ מחדש בתוך החלון', { skip }, async () => {
  const x = await setup('קיצור', {
    starts: 1, ends: 30,
    posts: [{ day: 3 }, { day: 20, status: 'approved' }, { day: 25 }],
  });
  try {
    // הטופס שולח את שני התאריכים יחד; ההתחלה לא זזה — אין הזזה
    const r = await call('PATCH', `/campaigns/${x.camp}`,
      { starts_on: inDays(1), ends_on: inDays(12), period: 'custom' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.shift, { kept: 1, rescheduled: 2, approved: 1 });
    assert.equal(r.json.moved_posts, 0);
    assert.ok(await exists(x.posts[0].post), 'הפוסט שבתוך החלון נשאר');
    assert.ok(!(await exists(x.posts[1].post)));
    assert.ok(!(await exists(x.posts[2].post)));
    const all = await campaignPosts(x.camp);
    for (const p of all) {
      assert.ok(ymd(new Date(p.scheduled_at)) <= inDays(12), `פוסט אחרי הסיום: ${p.scheduled_at}`);
    }
    // התוכן של שניהם חזר ללוח בתוך החלון, מתוכנן (המאושר איבד את האישור)
    for (const i of [1, 2]) {
      const again = all.filter((p) => p.content_id === x.posts[i].content);
      assert.equal(again.length, 1, `התוכן ${i + 1} שובץ מחדש`);
      assert.equal(again[0].status, 'scheduled');
    }
  } finally {
    await cleanup(x);
  }
});

test('קיצור הסיום בודק רק את החלון — פוסט ידני קרוב מדי לשכן (אחרי אזהרה) נשאר', { skip }, async () => {
  const x = await setup('קיצור ידני', {
    starts: 1, ends: 30, gap: 7,
    // יום 4 הוצב ידנית בתוך המרווח מיום 2 (ואושר); יום 25 ייצא מהחלון
    posts: [{ day: 2 }, { day: 4, status: 'approved' }, { day: 25 }],
  });
  try {
    const r = await call('PATCH', `/campaigns/${x.camp}`,
      { starts_on: inDays(1), ends_on: inDays(15), period: 'custom' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.shift, { kept: 2, rescheduled: 1, approved: 0 });
    const manual = await q1('select status, scheduled_at from posts where id = $1', [x.posts[1].post]);
    assert.equal(manual?.status, 'approved', 'הפוסט הידני נשאר מאושר');
    assert.equal(new Date(manual.scheduled_at).getTime(), at(4).getTime());
    assert.ok(await exists(x.posts[0].post));
    assert.ok(!(await exists(x.posts[2].post)));
  } finally {
    await cleanup(x);
  }
});

test('מרווח 7 ← 14: פוסטים קרובים מדי יורדים, ומה שחוזר שומר על 14 ימים', { skip }, async () => {
  const x = await setup('מרווח', {
    starts: 1, ends: 70, gap: 7,
    posts: [{ day: 2 }, { day: 9, status: 'approved' }, { day: 16 }, { day: 23 }],
  });
  try {
    const r = await call('PATCH', `/campaigns/${x.camp}`, { min_gap_days: 14 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // 2 נשאר, 9 קרוב מדי, 16 נשאר (14 מ-2), 23 קרוב מדי
    assert.deepEqual(r.json.shift, { kept: 2, rescheduled: 2, approved: 1 });
    assert.ok(await exists(x.posts[0].post));
    assert.ok(!(await exists(x.posts[1].post)));
    assert.ok(await exists(x.posts[2].post));
    assert.ok(!(await exists(x.posts[3].post)));
    const days = (await campaignPosts(x.camp)).map((p) => ymd(new Date(p.scheduled_at)));
    for (let i = 1; i < days.length; i++) {
      assert.ok(dayDiff(days[i - 1], days[i]) >= 14, `קרובים מדי: ${days.join(', ')}`);
    }
    assert.equal(days.length, 4, `כל התוכן חזר ללוח: ${days.join(', ')}`);
  } finally {
    await cleanup(x);
  }
});

test('הקטנת מרווח / שינוי שם — אין בדיקה מחדש, שום פוסט לא יורד', { skip }, async () => {
  const x = await setup('רפוי', {
    starts: 1, ends: 40, gap: 7, posts: [{ day: 2, status: 'approved' }, { day: 9 }],
  });
  try {
    const r = await call('PATCH', `/campaigns/${x.camp}`, { min_gap_days: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.shift, { moved: 0, rescheduled: 0, approved: 0 });
    const n = await call('PATCH', `/campaigns/${x.camp}`, { name: 'שם אחר', goal: 'מטרה' });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    assert.deepEqual(n.json.shift, { moved: 0, rescheduled: 0, approved: 0 });
    const st = await q1('select status from posts where id = $1', [x.posts[0].post]);
    assert.equal(st.status, 'approved');
    assert.ok(await exists(x.posts[1].post));
  } finally {
    await cleanup(x);
  }
});

test('"לא באותו יום" נדלק: זוג מקושר באותו יום מתפצל', { skip }, async () => {
  const x = await setup('נפרדים', {
    starts: 1, ends: 30, apart: false, channels: 2,
    posts: [{ day: 5, ch: 0 }, { day: 5, ch: 1, linkTo: 0 }],
  });
  try {
    const r = await call('POST', `/campaigns/${x.camp}/link-rules`, { rules: [], links_apart: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // המקור (המוקדם לפי המזהה) נשאר; העוקבת יורדת ומשובצת ביום אחר
    assert.deepEqual(r.json.shift, { kept: 1, rescheduled: 1, approved: 0 });
    assert.ok(await exists(x.posts[0].post));
    assert.ok(!(await exists(x.posts[1].post)));
    const again = (await campaignPosts(x.camp)).filter((p) => p.content_id === x.posts[1].content);
    assert.equal(again.length, 1, 'העוקבת שובצה מחדש');
    assert.notEqual(ymd(new Date(again[0].scheduled_at)), inDays(5));

    // שמירה חוזרת עם הכלל כבר דלוק — אין בדיקה מחדש
    const same = await call('POST', `/campaigns/${x.camp}/link-rules`, { rules: [], links_apart: true });
    assert.equal(same.status, 200, JSON.stringify(same.json));
    assert.equal(same.json.shift, null);
  } finally {
    await cleanup(x);
  }
});

test('קישור למשבצת שכבר משובצת באותו יום: הפוסט שלה עובר ליום אחר', { skip }, async () => {
  const x = await setup('קישור', {
    starts: 1, ends: 30, channels: 2,
    posts: [{ day: 5, ch: 0 }, { day: 5, ch: 1 }],
  });
  try {
    const r = await call('POST', `/content/${x.posts[0].content}/link`,
      { target_content_id: x.posts[1].content, replace: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const linked = await q1('select linked_to_id from content_items where id = $1', [x.posts[1].content]);
    assert.equal(linked.linked_to_id, x.posts[0].content);
    // רק הפוסטים של העוקבת נבדקים; המקור קבוע
    assert.deepEqual(r.json.shift, { kept: 0, rescheduled: 1, approved: 0 });
    assert.ok(await exists(x.posts[0].post));
    const all = await campaignPosts(x.camp);
    const source = all.filter((p) => p.content_id === x.posts[0].content);
    const follower = all.filter((p) => p.content_id === x.posts[1].content);
    assert.equal(follower.length, 1, 'העוקבת שובצה מחדש');
    assert.notEqual(ymd(new Date(follower[0].scheduled_at)), ymd(new Date(source[0].scheduled_at)));
  } finally {
    await cleanup(x);
  }
});

test('קישור כשהכלל כבוי — הפוסטים נשארים באותו יום, בלי בדיקה מחדש', { skip }, async () => {
  const x = await setup('קישור כבוי', {
    starts: 1, ends: 30, channels: 2, apart: false,
    posts: [{ day: 5, ch: 0 }, { day: 5, ch: 1 }],
  });
  try {
    const r = await call('POST', `/content/${x.posts[0].content}/link`,
      { target_content_id: x.posts[1].content, replace: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.shift, null);
    assert.ok(await exists(x.posts[1].post));
  } finally {
    await cleanup(x);
  }
});

test('קישור בודק רק "לא באותו יום" — פוסט של העוקבת ביום אחר נשאר, גם קרוב לשכן', { skip }, async () => {
  const x = await setup('קישור מרווח', {
    starts: 1, ends: 30, channels: 2, gap: 7,
    // בערוץ השני: פוסט ביום 4 ופוסט ביום 6 (הוצב ידנית, בתוך המרווח)
    posts: [{ day: 5, ch: 0 }, { day: 6, ch: 1, status: 'approved' }, { day: 4, ch: 1 }],
  });
  try {
    const r = await call('POST', `/content/${x.posts[0].content}/link`,
      { target_content_id: x.posts[1].content, replace: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.shift, { kept: 1, rescheduled: 0, approved: 0 });
    const kept = await q1('select status, scheduled_at from posts where id = $1', [x.posts[1].post]);
    // נשאר במקומו. האישור כן חוזר — העוקבת יוצאת מעכשיו עם התוכן של המקור,
    // לא עם מה שאושר (סעיף 31)
    assert.equal(kept.status, 'scheduled');
    assert.equal(r.json.approval_reset, 1);
    assert.equal(new Date(kept.scheduled_at).getTime(), at(6).getTime());
    assert.ok(await exists(x.posts[2].post), 'פוסט שלא נגע בקישור לא נבדק');
  } finally {
    await cleanup(x);
  }
});
