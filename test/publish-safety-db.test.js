import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * בטיחות הפרסום מול Postgres אמיתי: COMMIT שהתגלגל אחורה בשקט, פרסום
 * בשלבים (בלי טרנזקציה פתוחה בזמן הקריאה ל-Graph), "פרסם עכשיו" כשהדפדפן
 * מתנתק, ועריכה/מחיקה שמתנגשות בפרסום.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_fix_b node --test test/publish-safety-db.test.js
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, runner, org, ids;

const inOrg = (fn) => db.withOrg(org, fn);
const q1 = (sql, params) => inOrg(() => db.one(sql, params));
const status = async (id) => (await q1('select status from posts where id = $1', [id]))?.status ?? null;

// כותרת שהטריגר בבדיקה מפיל עליה את שמירת ה-published — שגיאת SQL אחרי
// שהקריאה ל-Graph כבר הצליחה
const BREAKS_ON_SAVE = 'נשבר-בשמירה';

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  runner = await import('../src/publish/runner.js');
  const { encryptSecret } = await import('../src/publish/crypto.js');
  await db.migrate();
  await db.pool.query(`
    create or replace function test_break_publish_save() returns trigger language plpgsql as $$
    begin
      if new.status = 'published' and new.title like '${BREAKS_ON_SAVE}%' then
        raise exception 'שמירה שבורה (בדיקה)';
      end if;
      return new;
    end $$;
    drop trigger if exists test_break_publish_save on posts;
    create trigger test_break_publish_save before update on posts
      for each row execute function test_break_publish_save();`);
  org = (await db.pool.query("insert into orgs (name) values ('publish-safety-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings (autopublish_enabled) values (true)');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id");
    const fb = await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 7) returning id");
    await db.query(
      `insert into channel_connections (channel_id, page_id, access_token_enc, auto_enabled)
       values ($1, '9', $2, true)`, [fb.id, encryptSecret('tok')]);
    return { endpoint: ep.id, fb: fb.id };
  });
});

after(async () => {
  if (!RUN) return;
  await db.pool.query('drop trigger if exists test_break_publish_save on posts');
  await db.pool.end();
});

/** פוסט מאושר לפייסבוק עם תוכן מוכן. at — דקות מעכשיו (שלילי = עבר) */
async function duePost(title, { at = -1, status: st = 'approved' } = {}) {
  return inOrg(async () => {
    const ci = await db.one(
      `insert into content_items (title, kind, endpoint_id) values ($1, 'value', $2) returning id`,
      [title, ids.endpoint]);
    await db.query(
      `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'טקסט מוכן','ready')`,
      [ci.id, ids.fb]);
    const p = await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1,$2,$3,$4,'value', now() + ($5 || ' minutes')::interval, $6) returning id`,
      [ids.fb, ids.endpoint, ci.id, title, String(at), st]);
    return p.id;
  });
}

/**
 * Graph מדומה: כל פרסום ל-9/feed מצליח עם מזהה חדש. onPublish(path, params)
 * רץ באמצע הקריאה — בזמן שהפרסום "באוויר".
 */
async function withGraph(onPublish, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, '');
    const params = Object.fromEntries(opts.body ?? []);
    calls.push({ path, params });
    const out = await onPublish?.(path, params);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ id: `9_${calls.length}` }), { status: 200 });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

/** פוסטים של הבדיקה הזו בלבד — שאר הבדיקות לא יוצאות בטיק שלה */
async function onlyThese(...keep) {
  await inOrg(() => db.query(
    `update posts set status = 'scheduled' where status = 'approved' and not (id = any($1))`, [keep]));
}

/* ---------- COMMIT שהתגלגל אחורה ---------- */

test('withOrg: שאילתה שנכשלה ונתפסה — ה-COMMIT מתגלגל אחורה, ו-withOrg זורק', { skip }, async () => {
  const name = `נקודה-${Date.now()}`;
  await assert.rejects(
    inOrg(async () => {
      await db.query('insert into endpoints (name, importance) values ($1, 5)', [name]);
      // שגיאה שנתפסה בקוד — הטרנזקציה כבר שבורה
      await db.query('select 1/0').catch(() => {});
    }),
    (e) => e instanceof db.CommitRolledBackError);
  // שום דבר לא נשמר — והקורא יודע את זה
  assert.equal(await q1('select id from endpoints where name = $1', [name]), null);
});

test('withOrg: טרנזקציה תקינה נשמרת ומחזירה את התוצאה', { skip }, async () => {
  const name = `נקודה-${Date.now()}`;
  const out = await inOrg(async () => {
    await db.query('insert into endpoints (name, importance) values ($1, 5)', [name]);
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.ok(await q1('select id from endpoints where name = $1', [name]));
});

/* ---------- פרסום בשלבים (הטיק) ---------- */

test('טיק: שמירה שנכשלה אחרי Graph לא מחזירה ל-approved את מה שכבר יצא, ולא מפרסמת שוב', { skip }, async () => {
  const ok = await duePost('יוצא ונשמר', { at: -3 });
  const broken = await duePost(`${BREAKS_ON_SAVE} — יוצא ולא נשמר`, { at: -2 });
  const after = await duePost('יוצא אחרי השבור', { at: -1 });
  await onlyThese(ok, broken, after);

  const calls = await withGraph(async (path) => {
    // הקריאה לפלטפורמה לא רצה בתוך טרנזקציה שמחזיקה את הפוסט
    if (path === '9/feed') {
      await db.pool.query('select 1 from posts where id = any($1) for update nowait', [[ok, broken, after]]);
    }
  }, () => runner.publishTickForOrg(org));

  assert.equal(calls.filter((c) => c.path === '9/feed').length, 3);
  assert.equal(await status(ok), 'published');
  assert.equal(await status(after), 'published', 'הפוסט שאחרי השבור יצא ונשמר');
  // השבור עלה, אבל לא נשמר — נשאר publishing (לא approved, לא failed)
  assert.equal(await status(broken), 'publishing');

  // טיק שני: אף אחד לא יוצא שוב
  const again = await withGraph(null, () => runner.publishTickForOrg(org));
  assert.equal(again.length, 0);
  assert.equal(await status(ok), 'published');

  // אחרי 30 דקות — נקטע, עם "ייתכן שכבר עלה", ושוב בלי פרסום
  await inOrg(() => db.query(
    `update posts set publishing_started_at = now() - interval '40 minutes' where id = $1`, [broken]));
  const third = await withGraph(null, () => runner.publishTickForOrg(org));
  assert.equal(third.length, 0);
  const p = await q1('select status, publish_error from posts where id = $1', [broken]);
  assert.equal(p.status, 'failed');
  assert.equal(p.publish_error, runner.STUCK_SOCIAL_ERROR);
  assert.match(p.publish_error, /ייתכן שהפוסט כבר עלה/);
});

test('טיק: פוסט שהוזז קדימה בזמן שהטיק עובר על הרשימה — לא יוצא', { skip }, async () => {
  const first = await duePost('ראשון', { at: -2 });
  const moved = await duePost('הוזז בזמן הטיק', { at: -1 });
  await onlyThese(first, moved);

  let movedOnce = false;
  const calls = await withGraph(async (path) => {
    if (path === '9/feed' && !movedOnce) {
      movedOnce = true;
      // המשתמש מזיז את השני למחר בדיוק כשהראשון באוויר
      await inOrg(() => db.query(
        `update posts set scheduled_at = now() + interval '1 day' where id = $1`, [moved]));
    }
  }, () => runner.publishTickForOrg(org));

  assert.equal(calls.length, 1);
  assert.equal(await status(first), 'published');
  assert.equal(await status(moved), 'approved');
});

test('תפיסה בטיק (dueOnly): קמפיין מושהה, ערוץ בלי פרסום אוטומטי או מועד עתידי — לא נתפס', { skip }, async () => {
  const future = await duePost('עתידי', { at: 60 });
  const r1 = await withGraph(null, async () => {
    const out = await runner.publishOne(future, { orgId: org, dueOnly: true });
    assert.equal(out.ok, false);
  });
  assert.equal(r1.length, 0);
  assert.equal(await status(future), 'approved');

  const paused = await duePost('בקמפיין מושהה');
  await inOrg(async () => {
    const c = await db.one(
      `insert into campaigns (endpoint_id, name, paused_at) values ($1, 'מושהה', now()) returning id`,
      [ids.endpoint]);
    await db.query(
      'update content_items set campaign_id = $1 where id = (select content_id from posts where id = $2)',
      [c.id, paused]);
  });
  await withGraph(null, () => runner.publishOne(paused, { orgId: org, dueOnly: true }));
  assert.equal(await status(paused), 'approved');

  const off = await duePost('ערוץ כבוי');
  await inOrg(() => db.query('update channel_connections set auto_enabled = false where channel_id = $1', [ids.fb]));
  try {
    const calls = await withGraph(null, () => runner.publishOne(off, { orgId: org, dueOnly: true }));
    assert.equal(calls.length, 0);
    assert.equal(await status(off), 'approved');
  } finally {
    await inOrg(() => db.query('update channel_connections set auto_enabled = true where channel_id = $1', [ids.fb]));
  }
  // "פרסם עכשיו" (בלי dueOnly) — מועד עתידי לא חוסם
  const now = await withGraph(null, () => runner.publishOne(future, { orgId: org }));
  assert.equal(now.length, 1);
  assert.equal(await status(future), 'published');
});

test('Graph נכשל: failed עם משימה, נשמר — ולא חוזר לפרסום בטיק הבא', { skip }, async () => {
  const id = await duePost('Graph דוחה');
  await onlyThese(id);
  const calls = await withGraph(() => new Response(
    JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }), { status: 400 }),
  () => runner.publishTickForOrg(org));
  assert.equal(calls.length, 1);
  const p = await q1('select status, publish_error from posts where id = $1', [id]);
  assert.equal(p.status, 'failed');
  const t = await q1(`select urgent from tasks where post_id = $1 and kind = 'failed' and not done`, [id]);
  assert.equal(t.urgent, true);
  const log = await q1('select ok from publish_log where post_id = $1', [id]);
  assert.equal(log.ok, false);
  assert.equal((await withGraph(null, () => runner.publishTickForOrg(org))).length, 0);
});

/* ---------- דפדפן שהתנתק באמצע בקשה ---------- */

// הבקשות לשרת הבדיקה — לא דרך ה-Graph המדומה (withGraph מחליף את fetch הגלובלי)
const httpFetch = globalThis.fetch;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** שרת עם tenantScope האמיתי, ונתיבים שהבדיקה מוסיפה */
async function scopedApp(mount) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: null, name: 'בודק', is_owner: true };
    req.org = org;
    next();
  });
  app.use(db.tenantScope);
  mount(app);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, base: `http://localhost:${server.address().port}` };
}

/** מחכה עד ש-check מחזיר אמת (עד שתי שניות) */
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const countByName = async (names) => (await db.pool.query(
  'select org_id from endpoints where name = any($1)', [names])).rows;

test('tenantScope: הדפדפן התנתק והנתיב עוד רץ — הטרנזקציה לא נסגרת עד שהנתיב מסיים, והכתיבות שלו בארגון הנכון', { skip }, async () => {
  const stamp = Date.now();
  const [nameA, nameB] = [`לפני-ניתוק-${stamp}`, `אחרי-ניתוק-${stamp}`];
  const entered = deferred();
  const closed = deferred();
  const release = deferred();
  const handled = deferred();
  const { server, base } = await scopedApp((app) => {
    app.post('/slow', async (req, res, next) => {
      try {
        await db.query('insert into endpoints (name, importance) values ($1, 5)', [nameA]);
        res.on('close', () => closed.resolve());
        entered.resolve();
        await release.promise;
        const r = await db.one("select current_setting('app.current_org', true) as org");
        await db.query('insert into endpoints (name, importance) values ($1, 5)', [nameB]);
        res.json({ ok: true });
        handled.resolve(r.org);
      } catch (e) {
        handled.reject(e);
        next(e);
      }
    });
  });
  try {
    const ac = new AbortController();
    const req = fetch(`${base}/slow`, { method: 'POST', signal: ac.signal }).catch(() => null);
    await entered.promise;
    ac.abort();
    await closed.promise;
    await req;
    // הדפדפן כבר לא שם — אבל הטרנזקציה של הנתיב עוד פתוחה (לא נשמרה באמצע)
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await countByName([nameA]), [], 'הטרנזקציה נסגרה לפני שהנתיב סיים');

    release.resolve();
    assert.equal(await handled.promise, String(org), 'הכתיבה אחרי הניתוק רצה על חיבור בלי הארגון');
    assert.ok(await until(async () => (await countByName([nameA, nameB])).length === 2),
      'שתי הכתיבות נשמרו כשהנתיב סיים');
    for (const row of await countByName([nameA, nameB])) assert.equal(row.org_id, org);
  } finally {
    release.resolve();
    server.close();
  }
});

test('"פרסם עכשיו": הדפדפן התנתק בזמן הקריאה ל-Graph — הפוסט נרשם "פורסם" עם המזהה', { skip }, async () => {
  const { default: publish } = await import('../src/routes/publish.js');
  const id = await duePost('פרסם עכשיו וניתוק', { at: 120, status: 'scheduled' });
  const inGraph = deferred();
  const release = deferred();
  const { server, base } = await scopedApp((app) => app.use(publish));
  try {
    const ac = new AbortController();
    let calls;
    const graphDone = withGraph(async () => {
      inGraph.resolve();
      await release.promise;
    }, async () => {
      const req = httpFetch(`${base}/posts/${id}/publish-now`, { method: 'POST', signal: ac.signal })
        .catch(() => null);
      await inGraph.promise;
      // הפוסט כבר נתפס ונשמר כ-publishing — לפני הקריאה ל-Graph
      assert.equal((await db.pool.query('select status from posts where id = $1', [id])).rows[0].status,
        'publishing');
      ac.abort();
      await req;
      await new Promise((r) => setTimeout(r, 50));
      release.resolve();
      assert.ok(await until(async () =>
        (await db.pool.query('select status from posts where id = $1', [id])).rows[0].status === 'published'));
    }).then((c) => { calls = c; });
    await graphDone;
    assert.equal(calls.length, 1);
    const p = await q1('select status, external_id from posts where id = $1', [id]);
    assert.equal(p.status, 'published');
    assert.equal(p.external_id, '9_1');
  } finally {
    release.resolve();
    server.close();
  }
});

/* ---------- עריכה ומחיקה מול פרסום ---------- */

async function boardCall(method, path, body) {
  const { default: board } = await import('../src/routes/board.js');
  const { server, base } = await scopedApp((app) => app.use(board));
  try {
    const res = await httpFetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    // ה-commit של הבקשה קורה אחרי שהתשובה נשלחה
    await new Promise((r) => setTimeout(r, 50));
    return { status: res.status, json };
  } finally {
    server.close();
  }
}

test('עריכה ומחיקה של פוסט ב-publishing — 409, והשורה לא משתנה', { skip }, async () => {
  const id = await duePost('באמצע פרסום', { at: 30 });
  await inOrg(() => db.query(
    `update posts set status = 'publishing', publishing_started_at = now() where id = $1`, [id]));

  let r = await boardCall('PATCH', `/posts/${id}`, { note: 'הערה' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'הפוסט מתפרסם ממש עכשיו — נסו שוב בעוד דקה');
  r = await boardCall('PATCH', `/posts/${id}`, { scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(r.status, 409);
  r = await boardCall('DELETE', `/posts/${id}`);
  assert.equal(r.status, 409);
  const p = await q1('select status, note from posts where id = $1', [id]);
  assert.equal(p.status, 'publishing');
  assert.equal(p.note, null);
});

test('פוסט שפורסם: הזזה נחסמת, הסרה מהלוח מותרת (כמו בממשק)', { skip }, async () => {
  const id = await duePost('כבר באוויר', { at: -60 });
  await inOrg(() => db.query(`update posts set status = 'published', published_at = now() where id = $1`, [id]));
  let r = await boardCall('PATCH', `/posts/${id}`, { scheduled_at: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /שכבר פורסם/);
  r = await boardCall('DELETE', `/posts/${id}`);
  assert.equal(r.status, 200);
  assert.equal(await status(id), null);
});

test('עריכה שמחזיקה את השורה: התפיסה בטיק מחכה לה ורואה את המועד החדש — לא יוצא', { skip }, async () => {
  const id = await duePost('נעול בעריכה');
  const locked = deferred();
  const hold = deferred();
  // כמו PATCH: select ... for update, הזזה, והטרנזקציה עוד פתוחה
  const editing = inOrg(async () => {
    await db.one('select id from posts where id = $1 for update', [id]);
    await db.query(`update posts set scheduled_at = now() + interval '1 day' where id = $1`, [id]);
    locked.resolve();
    await hold.promise;
  });
  await locked.promise;
  let calls;
  const publishing = withGraph(null, () => runner.publishOne(id, { orgId: org, dueOnly: true }))
    .then((c) => { calls = c; });
  await new Promise((r) => setTimeout(r, 100));
  hold.resolve();
  await editing;
  await publishing;
  assert.equal(calls.length, 0);
  assert.equal(await status(id), 'approved');
});
