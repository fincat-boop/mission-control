import './_env.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * ניוזלטר מול ה-HUB, מול Postgres אמיתי ו-HUB מדומה (שרת HTTP מקומי):
 * "העבר ל-HUB" (הנתיב עצמו, בתוך withOrg כמו בשרת), הטיק שלא יוצר
 * ניוזלטר ומשאיר משימה, בדיקת הסטטוס (draft / sent / 404), העברה חוזרת,
 * וטוקן SSO חד-פעמי.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   NEWSLETTER_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5517/mc_s6 node --test test/newsletter-db.test.js
 * (בלי המשתנים — מדולג, כדי ש-npm test לא ייגע במסד.)
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.NEWSLETTER_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (NEWSLETTER_TEST_DB=1 + DATABASE_URL מקומי)';

/* ---------- HUB מדומה ---------- */

const hub = {
  calls: [],          // { method, path, body }
  campaigns: new Map(), // id -> { id, external_ref, status, scheduled_at }
  byRef: new Map(),
  seq: 0,
  rawNotFound: false,  // 404 בלי JSON (פרוקסי/נתיב שגוי)
};

function hubServer() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = req.url;
      hub.calls.push({ method: req.method, path, body });
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== 'Bearer test-hub-key') return json(401, { ok: false, error: 'לא מאומת' });
      if (req.method === 'POST' && path === '/api/v1/mission-control/newsletters') {
        const existing = hub.byRef.get(body.external_ref);
        if (existing) {
          return json(200, { ok: true, idempotent: true, campaign_id: existing.id,
            status: existing.status, scheduled_at: existing.scheduled_at });
        }
        const c = { id: `00000000-0000-4000-8000-${String(++hub.seq).padStart(12, '0')}`,
          external_ref: body.external_ref, status: 'draft', scheduled_at: body.scheduled_at };
        hub.campaigns.set(c.id, c);
        hub.byRef.set(c.external_ref, c);
        return json(201, { ok: true, campaign_id: c.id, status: 'draft', requires_approval: true,
          recipient_count: 42, scheduled_at: c.scheduled_at });
      }
      const m = path.match(/^\/api\/v1\/mission-control\/newsletters\/([^/?]+)$/);
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1]);
        const c = hub.campaigns.get(id) ?? hub.byRef.get(id);
        if (!c) {
          if (hub.rawNotFound) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
          return json(404, { ok: false, error: 'קמפיין לא נמצא' });
        }
        return json(200, { ok: true, campaign_id: c.id, external_ref: c.external_ref, status: c.status,
          scheduled_at: c.scheduled_at,
          counts: { recipients: 42, delivered: 40, opened: 12, clicked: 3, bounced: 0, complained: 0 } });
      }
      if (path === '/api/v1/mission-control/events') return json(200, { ok: true });
      return json(404, { ok: false, error: 'לא נמצא' });
    });
  });
}

/** מוחק קמפיין ב-HUB (בעל העסק מחק את הטיוטה) */
const hubDelete = (id) => {
  const c = hub.campaigns.get(id);
  hub.campaigns.delete(id);
  hub.byRef.delete(c.external_ref);
};
const hubPosts = () => hub.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/newsletters'));

/* ---------- אפליקציה ומסד ---------- */

let db, runner, sso, server, hubSrv, base, org, ids;
const pending = new Set();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);
  return { status: res.status, json };
}

const q = (sql, params) => db.withOrg(org, () => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;
const post = (id) => q1('select * from posts where id = $1', [id]);
const tick = () => db.withOrg(org, () => runner.publishTickForOrg());

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

/** ניוזלטר מוכן (גרסה ready עם נושא ומילוי) ופוסט אחד שלו */
async function newsletter({ at = inHours(48), status = 'scheduled', ready = true, subject = 'מה חדש השבוע' } = {}) {
  return db.withOrg(org, async () => {
    const ci = await db.one(
      `insert into content_items (title, kind, endpoint_id) values ('גיליון', 'value', $1) returning id`,
      [ids.endpoint]);
    await db.query(
      `insert into content_variants (content_id, channel_id, body, status, meta)
       values ($1,$2,'',$3,$4)`,
      [ci.id, ids.nl, ready ? 'ready' : 'draft',
       JSON.stringify({ subject, field_values: { 'תוכן': 'שלום לכולם', ריק: ' ' }, template_id: 'tpl-1' })]);
    const p = await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1,$2,$3,'ניוזלטר אוקטובר','value',$4,$5) returning id`,
      [ids.nl, ids.endpoint, ci.id, at, status]);
    return { post: p.id, content: ci.id };
  });
}

before(async () => {
  if (!RUN) return;
  hubSrv = hubServer().listen(0);
  process.env.HUB_API_URL = `http://localhost:${hubSrv.address().port}`;
  process.env.HUB_APP_URL = 'https://hub-dashboard.example';
  process.env.HUB_API_KEY = 'test-hub-key';

  db = await import('../src/db.js');
  runner = await import('../src/publish/runner.js');
  sso = await import('../src/hub-sso.js');
  const { default: express } = await import('express');
  const { default: publish } = await import('../src/routes/publish.js');
  const { default: board } = await import('../src/routes/board.js');
  const { default: content } = await import('../src/routes/content.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('newsletter-test') returning id")).rows[0].id;
  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings (autopublish_enabled) values (true)');
    const ep = await db.one("insert into endpoints (name, importance) values ('ניוזלטר', 5) returning id");
    const nl = await db.one(
      "insert into channels (name, platform, max_per_week) values ('ניוזלטר', 'newsletter', 7) returning id");
    return { endpoint: ep.id, nl: nl.id };
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בודק', is_owner: true };
    const p = db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(publish);
  app.use(board);
  app.use(content);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (!RUN) return;
  server?.close();
  hubSrv?.close();
  await db.pool.end();
});

beforeEach(() => {
  hub.calls.length = 0;
  hub.rawNotFound = false;
});

/* ---------- העבר ל-HUB ---------- */

test('העבר ל-HUB: נוצרת טיוטה עם המועד, התבנית והמילוי; הפוסט "בידי ה-HUB"', { skip }, async () => {
  const at = inHours(48);
  const { post: id } = await newsletter({ at });
  const r = await call('POST', `/posts/${id}/newsletter/transfer`);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const [sent] = hubPosts();
  assert.equal(sent.body.external_ref, `post-${id}`);
  assert.equal(sent.body.scheduled_at, new Date(at).toISOString());
  assert.equal(sent.body.template_id, 'tpl-1');
  assert.equal(sent.body.subject, 'מה חדש השבוע');
  assert.deepEqual(sent.body.field_values, { 'תוכן': 'שלום לכולם' });
  assert.equal(sent.body.name, 'ניוזלטר אוקטובר');

  const p = await post(id);
  assert.equal(p.status, 'publishing');
  assert.equal(p.hub_status, 'draft');
  assert.equal(p.hub_ref, `post-${id}`);
  assert.ok(p.hub_digest);
  assert.ok(p.hub_transferred_at);
  assert.equal(p.external_url, `https://hub-dashboard.example/dashboard/campaigns/${p.external_id}/edit`);
  const log = await q('select ok, external_id from publish_log where post_id = $1', [id]);
  assert.deepEqual(log.map((x) => x.ok), [true]);
});

test('העבר ל-HUB פעמיים — אותו קמפיין, ה-HUB נקרא פעם אחת (גם במקביל)', { skip }, async () => {
  const { post: id } = await newsletter();
  const [a, b] = await Promise.all([
    call('POST', `/posts/${id}/newsletter/transfer`),
    call('POST', `/posts/${id}/newsletter/transfer`),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(hubPosts().length, 1);
  assert.equal(a.json.post.external_id, b.json.post.external_id);
  assert.ok(a.json.idempotent || b.json.idempotent);
});

test('העבר ל-HUB נחסם: מועד שעבר, לא מוכן, בלי נושא — וה-HUB לא נקרא', { skip }, async () => {
  const past = await newsletter({ at: inHours(-1) });
  assert.match((await call('POST', `/posts/${past.post}/newsletter/transfer`)).json.error, /המועד עבר/);
  const draft = await newsletter({ ready: false });
  assert.match((await call('POST', `/posts/${draft.post}/newsletter/transfer`)).json.error, /מוכן/);
  const noSubj = await newsletter({ subject: '' });
  const r = await call('POST', `/posts/${noSubj.post}/newsletter/transfer`);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /נושא/);
  assert.equal(hubPosts().length, 0);
});

test('אחרי ההעברה: שינוי בגרסה מסומן "לא הגיע ל-HUB", והמועד לא זז מכאן', { skip }, async () => {
  const { post: id, content } = await newsletter();
  await call('POST', `/posts/${id}/newsletter/transfer`);
  let pv = await call('GET', `/posts/${id}/preview`);
  assert.equal(pv.json.post.hub_stale, false);

  await q(`update content_variants set meta = meta || '{"subject":"נושא אחר"}' where content_id = $1`, [content]);
  pv = await call('GET', `/posts/${id}/preview`);
  assert.equal(pv.json.post.hub_stale, true);
  const list = await call('GET', `/publish/newsletter-posts?content_id=${content}&channel_id=${ids.nl}`);
  assert.equal(list.json.posts[0].hub_stale, true);
  assert.equal('hub_digest' in list.json.posts[0], false);

  const mv = await call('PATCH', `/posts/${id}`, { scheduled_at: inHours(72) });
  assert.equal(mv.status, 409);
  assert.match(mv.json.error, /הועבר ל-HUB/);
});

test('אישור ופרסם-עכשיו לניוזלטר מפנים ל"העבר ל-HUB"', { skip }, async () => {
  const { post: id } = await newsletter();
  const a = await call('POST', `/posts/${id}/approve-publish`);
  assert.equal(a.status, 400);
  assert.match(a.json.error, /העבר ל-HUB/);
  const n = await call('POST', `/posts/${id}/publish-now`);
  assert.equal(n.status, 400);
  assert.match(n.json.error, /העבר ל-HUB/);
  assert.equal(hubPosts().length, 0);
  assert.equal((await post(id)).status, 'scheduled');
});

/* ---------- הטיק ---------- */

test('טיק: ניוזלטר שהגיע מועדו בלי העברה — נכשל עם משימה, ושום דבר לא נוצר ב-HUB', { skip }, async () => {
  const approved = await newsletter({ at: inHours(-0.5), status: 'approved' });
  const scheduled = await newsletter({ at: inHours(-2), status: 'scheduled' });
  const old = await newsletter({ at: inHours(-30), status: 'scheduled' });
  const future = await newsletter({ at: inHours(5), status: 'approved' });
  // משבצת ניוזלטר ריקה (בלי תוכן) — לא נכשלת ולא פותחת משימה
  const empty = await db.withOrg(org, () => db.one(
    `insert into posts (channel_id, title, kind, scheduled_at, status)
     values ($1, 'משבצת ריקה', 'value', $2, 'scheduled') returning id`, [ids.nl, inHours(-1)]));

  await tick();
  assert.equal(hubPosts().length, 0);
  for (const { post: id } of [approved, scheduled]) {
    const p = await post(id);
    assert.equal(p.status, 'failed');
    assert.match(p.publish_error, /לא הועבר ל-HUB/);
    const t = await q1(`select title, urgent from tasks where post_id = $1 and kind = 'failed' and not done`, [id]);
    assert.match(t.title, /ניוזלטר לא הועבר ל-HUB/);
    assert.equal(t.urgent, true);
  }
  // ישן מיממה — לא מציפים; עתידי — לא נוגעים
  assert.equal((await post(old.post)).status, 'scheduled');
  assert.equal((await post(future.post)).status, 'approved');
  assert.equal((await post(empty.id)).status, 'scheduled');
  assert.equal((await q1(`select count(*)::int as n from tasks where post_id = $1`, [empty.id])).n, 0);

  // טיק שני — לא עוד משימה
  await tick();
  const n = await q1(`select count(*)::int as n from tasks where post_id = $1 and kind = 'failed'`, [approved.post]);
  assert.equal(n.n, 1);

  // ההעברה אחרי מועד חדש סוגרת את המשימה
  await q(`update posts set scheduled_at = $2 where id = $1`, [approved.post, inHours(10)]);
  const r = await call('POST', `/posts/${approved.post}/newsletter/transfer`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const open = await q1(`select count(*)::int as n from tasks where post_id = $1 and not done`, [approved.post]);
  assert.equal(open.n, 0);
});

test('publishOne לניוזלטר (מאושר ישן) לא יוצר ב-HUB — נכשל עם הסבר', { skip }, async () => {
  const { post: id } = await newsletter({ status: 'approved' });
  const r = await db.withOrg(org, () => runner.publishOne(id));
  assert.equal(r.ok, false);
  assert.match(r.error, /לא הועבר ל-HUB/);
  assert.equal(hubPosts().length, 0);
  assert.equal((await post(id)).status, 'failed');
});

test('בדיקת סטטוס: draft נשאר וממתין, אושר → מתוזמן, נשלח → פורסם עם מדדים', { skip }, async () => {
  const { post: id } = await newsletter({ at: inHours(1) });
  await call('POST', `/posts/${id}/newsletter/transfer`);
  const ext = (await post(id)).external_id;

  let state = await db.withOrg(org, () => runner.pollNewsletterOutcomes());
  assert.equal(state.get(id).hub, 'draft');
  assert.ok(state.get(id).scheduled); // המועד של ה-HUB — לשעון התקיעה
  assert.equal((await post(id)).status, 'publishing');
  // הבדיקה הולכת לפי מזהה הקמפיין, לא לפי ה-ref
  assert.ok(hub.calls.some((c) => c.method === 'GET' && c.path.endsWith(`/newsletters/${ext}`)));

  hub.campaigns.get(ext).status = 'scheduled';
  state = await db.withOrg(org, () => runner.pollNewsletterOutcomes());
  assert.equal(state.get(id).hub, 'active');
  assert.equal((await post(id)).hub_status, 'scheduled');

  hub.campaigns.get(ext).status = 'sent';
  await tick();
  const p = await post(id);
  assert.equal(p.status, 'published');
  assert.equal(p.hub_status, 'sent');
  const res = await q1('select reach, engagement, clicks from post_results where post_id = $1', [id]);
  assert.deepEqual(res, { reach: 40, engagement: 12, clicks: 3 });
});

test('בדיקת סטטוס: הקמפיין נמחק ב-HUB (404 שלו) — נכשל עם הסבר; 404 של פרוקסי — מחכים', { skip }, async () => {
  const { post: id } = await newsletter();
  await call('POST', `/posts/${id}/newsletter/transfer`);
  const ext = (await post(id)).external_id;
  hubDelete(ext);

  hub.rawNotFound = true;
  await db.withOrg(org, () => runner.pollNewsletterOutcomes());
  assert.equal((await post(id)).status, 'publishing');

  hub.rawNotFound = false;
  await db.withOrg(org, () => runner.pollNewsletterOutcomes());
  const p = await post(id);
  assert.equal(p.status, 'failed');
  assert.equal(p.hub_status, 'missing');
  assert.match(p.publish_error, /לא נמצא ב-HUB/);

  // העברה חוזרת אחרי מחיקה — אותו מפתח, קמפיין חדש
  const r = await call('POST', `/posts/${id}/newsletter/transfer`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(hubPosts().at(-1).body.external_ref, `post-${id}`);
  assert.notEqual(r.json.post.external_id, ext);
});

test('העברה חוזרת: טיוטה שעדיין חיה ב-HUB מחוברת מחדש; נכשלה סופית — מפתח חדש', { skip }, async () => {
  const { post: id } = await newsletter();
  await call('POST', `/posts/${id}/newsletter/transfer`);
  const ext = (await post(id)).external_id;

  // שוחרר אצלנו (פרסום "תקוע") — אבל ב-HUB הטיוטה עדיין שם
  await q(`update posts set status = 'failed' where id = $1`, [id]);
  hub.calls.length = 0;
  const again = await call('POST', `/posts/${id}/newsletter/transfer`);
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true);
  assert.equal(again.json.post.external_id, ext);
  assert.equal(hubPosts().length, 0);

  // נכשל סופית ב-HUB — מפתח חדש, קמפיין חדש
  hub.campaigns.get(ext).status = 'failed';
  await q(`update posts set status = 'failed' where id = $1`, [id]);
  const third = await call('POST', `/posts/${id}/newsletter/transfer`);
  assert.equal(third.status, 200, JSON.stringify(third.json));
  assert.equal(hubPosts().at(-1).body.external_ref, `post-${id}-2`);
  assert.equal((await post(id)).hub_ref, `post-${id}-2`);
  assert.notEqual(third.json.post.external_id, ext);
});

test('תקוע: ממתין לאישור ב-HUB יממה אחרי המועד — "לא אושר"; הועבר מראש — לא תקוע', { skip }, async () => {
  const early = await newsletter({ at: inHours(1) });
  await call('POST', `/posts/${early.post}/newsletter/transfer`);
  // הועבר לפני 4 ימים, המועד בעוד שעה — לא תקוע
  await q(`update posts set publishing_started_at = now() - interval '4 days' where id = $1`, [early.post]);
  await tick();
  assert.equal((await post(early.post)).status, 'publishing');

  const late = await newsletter({ at: inHours(1) });
  await call('POST', `/posts/${late.post}/newsletter/transfer`);
  const ext = (await post(late.post)).external_id;
  hub.campaigns.get(ext).scheduled_at = inHours(-30);
  await q(`update posts set scheduled_at = now() - interval '30 hours',
                  publishing_started_at = now() - interval '40 hours' where id = $1`, [late.post]);
  await tick();
  const p = await post(late.post);
  assert.equal(p.status, 'failed');
  assert.match(p.publish_error, /ממתין לאישור ב-HUB/);
});

/* ---------- SSO ---------- */

test('SSO: jti נוצל פעם אחת בלבד; שורות שפגו נמחקות', { skip }, async () => {
  const exp = Math.floor(Date.now() / 1000) + 20;
  assert.equal(await sso.consumeSsoJti('jti-a', exp), true);
  assert.equal(await sso.consumeSsoJti('jti-a', exp), false);
  await db.pool.query(`insert into sso_used_jti (jti, expires_at) values ('old', now() - interval '1 minute')`);
  assert.equal(await sso.consumeSsoJti('jti-b', exp), true);
  const left = await db.pool.query(`select jti from sso_used_jti where jti = 'old'`);
  assert.equal(left.rowCount, 0);
});
