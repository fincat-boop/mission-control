import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ה-API לסוכנים מקצה לקצה מול Postgres אמיתי: הנפקה מהממשק (בעלים), קריאה
 * וכתיבה עם Bearer, הרשימה הלבנה, בידוד בין ארגונים (RLS), יומן הפעולות
 * (via='api'), יומן הבקשות, ביטול / סוד חדש / מחיקה. האפליקציה מורכבת כמו
 * ב-server.js — /api/v1 לפני /api, אותו tenantScope ואותו audit.
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/agent-api-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, otherOrg, owner, member, ids;
let currentUser = null;

const settle = () => new Promise((r) => setTimeout(r, 150));

async function http(method, path, { body, key, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await settle();   // ה-commit של tenantScope והרישום ביומנים רצים אחרי התשובה
  return { status: res.status, json };
}

const ui = (method, path, body) => http(method, `/api${path}`, { body });
const agent = (method, path, key, body) => http(method, `/api/v1${path}`, { body, key });
const inOrg = (o, fn) => db.withOrg(o, fn);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: api } = await import('../src/routes/api.js');
  const { default: agentApi } = await import('../src/agent-api/router.js');
  const { audit } = await import('../src/audit.js');

  await db.migrate();
  const mkOrg = async (name) => (await db.pool.query('insert into orgs (name) values ($1) returning id', [name])).rows[0].id;
  org = await mkOrg('agent-api-test');
  otherOrg = await mkOrg('agent-api-other');

  ids = await inOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const stamp = Date.now();
    owner = await db.one(
      `insert into users (name, email, is_owner, perm_content, perm_settings, perm_approve, perm_users)
       values ('בעלים', $1, true, true, true, true, true) returning *`, [`owner-${stamp}@t.local`]);
    member = await db.one(
      `insert into users (name, email, is_owner, perm_content, perm_settings, perm_approve, perm_users)
       values ('חבר', $1, false, true, true, true, true) returning *`, [`member-${stamp}@t.local`]);
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const fb = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק','facebook',7) returning id")).id;
    const content = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1,'value','תוכן קיים') returning id", [ep])).id;
    const post = (await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1,$2,$3,'פוסט','value', now() + interval '2 days','pending_approval') returning id`,
      [fb, ep, content])).id;
    return { ep, fb, content, post };
  });
  await inOrg(otherOrg, async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one("insert into endpoints (name, importance) values ('זר', 5) returning id")).id;
    await db.query("insert into content_items (endpoint_id, kind, title) values ($1,'value','סוד של ארגון אחר')", [ep]);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', agentApi);
  // במקום loadUser (קוקי): המשתמש של הבדיקה
  app.use('/api', (req, _res, next) => {
    req.user = currentUser;
    req.org = currentUser?.org_id ?? null;
    next();
  }, db.tenantScope, audit, api);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  currentUser = owner;
});

after(async () => {
  if (!RUN) return;
  server?.close();
  await db.pool.end();
});

let key;      // { id, secret, prefix }

test('בעלים מנפיק מפתח; הסוד חוזר פעם אחת ולא מופיע ברשימה', { skip }, async () => {
  const r = await ui('POST', '/api-keys', { name: 'בוט כתיבה', scopes: ['content.write', 'nope'] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.secret, /^mc_test_[a-z2-9]{60}$/);
  assert.deepEqual(r.json.key.scopes, ['content.write']);
  assert.deepEqual(r.json.key.derived, ['campaigns.read', 'content.read']);
  key = { id: r.json.key.id, secret: r.json.secret, prefix: r.json.key.key_prefix };

  const list = await ui('GET', '/api-keys');
  assert.equal(list.status, 200);
  const raw = JSON.stringify(list.json);
  assert.ok(!raw.includes(key.secret));
  assert.ok(!raw.includes('key_hash'));
});

test('רק בעלים מנהל מפתחות — גם חבר עם כל ההרשאות נחסם', { skip }, async () => {
  currentUser = member;
  try {
    assert.equal((await ui('GET', '/api-keys')).status, 403);
    assert.equal((await ui('POST', '/api-keys', { name: 'x1', scopes: ['board.read'] })).status, 403);
  } finally {
    currentUser = owner;
  }
});

test('ולידציה: בלי הרשאות, שם קצר, תאריך שעבר', { skip }, async () => {
  assert.equal((await ui('POST', '/api-keys', { name: 'בוט', scopes: [] })).status, 400);
  assert.equal((await ui('POST', '/api-keys', { name: 'x', scopes: ['board.read'] })).status, 400);
  assert.equal((await ui('POST', '/api-keys', { name: 'בוט', scopes: ['board.read'], expires_on: '2020-01-01' })).status, 400);
});

test('whoami וקריאה עם המפתח', { skip }, async () => {
  const who = await agent('GET', '/whoami', key.secret);
  assert.equal(who.status, 200);
  assert.equal(who.json.key.prefix, key.prefix);
  assert.ok(who.json.scopes.some((s) => s.scope === 'content.read' && s.implied));

  const list = await agent('GET', '/content', key.secret);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const titles = JSON.stringify(list.json);
  assert.ok(titles.includes('תוכן קיים'));
  assert.ok(!titles.includes('סוד של ארגון אחר'), 'דליפה בין ארגונים');
});

test('כתיבה: יצירת תוכן נרשמת ביומן כ"סוכן" עם קידומת המפתח', { skip }, async () => {
  const r = await agent('POST', '/content', key.secret, { title: 'נכתב בידי סוכן', kind: 'value', endpoint_id: ids.ep });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const log = await inOrg(org, () => db.one(
    "select user_id, user_name, via, action, meta from activity_log where via = 'api' order by id desc limit 1"));
  assert.equal(log.via, 'api');
  assert.equal(log.user_id, null);
  assert.equal(log.user_name, 'סוכן: בוט כתיבה');
  assert.equal(log.action, 'create');
  assert.equal(log.meta.api_key, key.prefix);
});

test('הרשימה הלבנה: מחיקה ואישור לא קיימים לסוכן, והתוכן נשאר', { skip }, async () => {
  assert.equal((await agent('DELETE', `/content/${ids.content}`, key.secret)).status, 404);
  assert.equal((await agent('POST', `/posts/${ids.post}/approve`, key.secret)).status, 404);
  assert.equal((await agent('PATCH', '/settings', key.secret, { min_gap_days: 1 })).status, 404);
  assert.equal((await agent('GET', '/api-keys', key.secret)).status, 404);
  const still = await inOrg(org, () => db.one('select id from content_items where id = $1', [ids.content]));
  assert.ok(still);
});

test('הרשאה חסרה → 403; Origin → 403; בלי מפתח → 401', { skip }, async () => {
  const t = await agent('GET', '/tasks', key.secret);
  assert.equal(t.status, 403);
  assert.match(t.json.error, /tasks\.read/);
  const o = await http('GET', '/api/v1/content', { key: key.secret, headers: { origin: 'https://evil.example' } });
  assert.equal(o.status, 403);
  assert.equal((await agent('GET', '/content', null)).status, 401);
  assert.equal((await agent('GET', '/content', `${key.secret.slice(0, -1)}x`)).status, 401);
});

test('יומן הבקשות: מזוהות נרשמות (כולל 403/404), בלי query string', { skip }, async () => {
  await agent('GET', '/content?q=secret-pii', key.secret);
  await settle();
  const reqs = await inOrg(org, () => db.rows(
    'select method, path, status from api_requests where api_key_id = $1', [key.id]));
  assert.ok(reqs.some((r) => r.path === '/content' && r.status === 200));
  assert.ok(reqs.some((r) => r.status === 403));
  assert.ok(reqs.some((r) => r.status === 404));
  assert.ok(reqs.every((r) => !r.path.includes('?')));
  const last = await inOrg(org, () => db.one('select last_used_at from api_keys where id = $1', [key.id]));
  assert.ok(last.last_used_at);

  const view = await ui('GET', `/api-keys/${key.id}/requests`);
  assert.equal(view.status, 200);
  assert.ok(view.json.requests.length > 0);
});

test('עריכת הרשאות חלה מיד', { skip }, async () => {
  assert.equal((await ui('PATCH', `/api-keys/${key.id}`, { scopes: ['content.write', 'tasks.write'] })).status, 200);
  assert.equal((await agent('GET', '/tasks', key.secret)).status, 200);
});

test('כללי סוכן: תוכן מאושר נעול, בלי העברה בין קמפיינים, בלי replace, בלי מחיקת תוצאות', { skip }, async () => {
  const r = await ui('POST', '/api-keys', {
    name: 'בוט מלא', scopes: ['content.write', 'content.schedule', 'results.write'] });
  const k = r.json.secret;
  const approved = await inOrg(org, async () => {
    const c = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1,'value','מאושר') returning id", [ids.ep])).id;
    const p = (await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1,$2,$3,'מאושר','value', now() + interval '3 days','approved') returning id`,
      [ids.fb, ids.ep, c])).id;
    return { c, p };
  });

  const edit = await agent('PATCH', `/content/${approved.c}`, k, { title: 'שונה אחרי אישור' });
  assert.equal(edit.status, 409);
  assert.equal((await agent('PUT', `/content/${approved.c}/variants/${ids.fb}`, k, { body: 'x' })).status, 409);
  assert.equal((await agent('POST', `/content/${approved.c}/uploads/sign`, k, {})).status, 409);
  const kept = await inOrg(org, () => db.one('select title from content_items where id = $1', [approved.c]));
  assert.equal(kept.title, 'מאושר');

  assert.equal((await agent('PATCH', `/content/${ids.content}`, k, { campaign_id: 999999 })).status, 403);
  assert.equal((await agent('PATCH', `/content/${ids.content}`, k, { endpoint_id: String(ids.ep), title: 'שם חדש' })).status, 200);
  assert.equal((await agent('POST', `/content/${ids.content}/link`, k, { replace: true })).status, 403);
  // המסלול הישן להעלאה (multipart → המסד) והשמירה המרוכזת לא פתוחים לסוכן
  assert.equal((await agent('POST', `/content/${ids.content}/assets`, k)).status, 404);
  assert.equal((await agent('PUT', '/results', k, { rows: [] })).status, 404);

  assert.equal((await agent('PUT', `/posts/${ids.post}/results`, k, { reach: 100 })).status, 200);
  assert.equal((await agent('PUT', `/posts/${ids.post}/results`, k, { clicks: 5 })).status, 200);
  const res = await inOrg(org, () => db.one('select reach, clicks from post_results where post_id = $1', [ids.post]));
  assert.equal(Number(res.reach), 100);   // לא התאפס כשלא נשלח
  assert.equal(Number(res.clicks), 5);
  assert.equal((await agent('PUT', `/posts/${ids.post}/results`, k, { reach: null, clicks: null })).status, 400);
  // הבדיקות הבאות נשענות על השם המקורי
  await inOrg(org, () => db.query("update content_items set title = 'תוכן קיים' where id = $1", [ids.content]));
});

test('מפתח של ארגון אחר לא רואה ולא כותב כאן', { skip }, async () => {
  const other = await inOrg(otherOrg, async () => {
    const u = await db.one(
      `insert into users (name, email, is_owner) values ('בעלים זר', $1, true) returning *`,
      [`other-${Date.now()}@t.local`]);
    return u;
  });
  currentUser = other;
  let otherKey;
  try {
    const r = await ui('POST', '/api-keys', { name: 'בוט זר', scopes: ['content.write'] });
    assert.equal(r.status, 201);
    otherKey = r.json.secret;
    // הרשימה של הבעלים הזר לא כוללת את המפתח שלנו
    const list = await ui('GET', '/api-keys');
    assert.ok(!list.json.keys.some((k) => k.id === key.id));
    // ניהול מפתח של ארגון אחר — לא נמצא, ולא מבוטל
    assert.equal((await ui('POST', `/api-keys/${key.id}/revoke`)).status, 404);
    assert.equal((await ui('DELETE', `/api-keys/${key.id}`)).status, 404);
  } finally {
    currentUser = owner;
  }
  const seen = JSON.stringify((await agent('GET', '/content', otherKey)).json);
  assert.ok(!seen.includes('תוכן קיים'));
  const w = await agent('PATCH', `/content/${ids.content}`, otherKey, { title: 'נחטף' });
  assert.equal(w.status, 404);
  const title = await inOrg(org, () => db.one('select title from content_items where id = $1', [ids.content]));
  assert.equal(title.title, 'תוכן קיים');
  assert.equal((await agent('GET', '/whoami', key.secret)).status, 200);
});

test('מפתח שפג → 401', { skip }, async () => {
  const r = await ui('POST', '/api-keys', { name: 'זמני', scopes: ['board.read'] });
  await inOrg(org, () => db.query("update api_keys set expires_at = now() - interval '1 minute' where id = $1", [r.json.key.id]));
  assert.equal((await agent('GET', '/board', r.json.secret)).status, 401);
});

test('ביטול חוסם מיד; סוד חדש מחזיר לפעולה, והישן מת לעולם', { skip }, async () => {
  assert.equal((await ui('POST', `/api-keys/${key.id}/revoke`)).status, 200);
  assert.equal((await agent('GET', '/content', key.secret)).status, 401);

  const renewed = await ui('POST', `/api-keys/${key.id}/renew`, {});
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.json.secret, key.secret);
  assert.equal(renewed.json.key.id, key.id);
  assert.deepEqual(renewed.json.key.scopes, ['content.write', 'tasks.write']);
  assert.equal((await agent('GET', '/content', renewed.json.secret)).status, 200);
  assert.equal((await agent('GET', '/content', key.secret)).status, 401);
  key.secret = renewed.json.secret;
});

test('מחיקה מבטלת קודם, ומוחקת את יומן הבקשות; יומן הפעולות נשאר', { skip }, async () => {
  const del = await ui('DELETE', `/api-keys/${key.id}`);
  assert.equal(del.status, 200);
  assert.equal((await agent('GET', '/content', key.secret)).status, 401);
  const left = await inOrg(org, () => db.one('select count(*)::int as n from api_requests where api_key_id = $1', [key.id]));
  assert.equal(left.n, 0);
  const acts = await inOrg(org, () => db.one("select count(*)::int as n from activity_log where via = 'api'"));
  assert.ok(acts.n > 0);
  const ownLog = await inOrg(org, () => db.one(
    "select summary from activity_log where entity = 'api-keys' and action = 'delete' order by id desc limit 1"));
  assert.match(ownLog.summary, /מפתח API/);
});
