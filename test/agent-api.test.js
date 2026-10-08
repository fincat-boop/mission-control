import './_env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  envOfPrefix, generateApiKey, hashApiKey, prefixOf, verifyApiKey,
} from '../src/agent-api/secret.js';
import {
  API_SCOPE_REGISTRY, API_SCOPES, ROUTES, derivedScopes, expandScopes, matchRoute, parseScopes,
} from '../src/agent-api/scopes.js';
import { PER_IP_PER_MINUTE, authenticateApiKey, bearerFrom } from '../src/agent-api/authenticate.js';
import { resetRateLimits } from '../src/agent-api/rate-limit.js';
import { buildAgentHandbook } from '../src/agent-api/handbook.js';

/* ========================= צורת המפתח ========================= */

// אותם ביטויים כמו ה-CHECK במסד (schema.sql, api_keys)
const SQL_PREFIX = /^mc_(live|test)_[a-z0-9]{4}$/;
const SQL_HASH = /^[0-9a-f]{64}$/;
const SQL_SCOPES = /^$|^[a-z_]+\.[a-z_.]+(,[a-z_]+\.[a-z_.]+)*$/;

test('מפתח שנוצר עומד ב-CHECK של המסד, בשתי הסביבות', () => {
  for (const env of ['live', 'test']) {
    const k = generateApiKey(env);
    assert.equal(k.secret.length, 68);
    assert.match(k.prefix, SQL_PREFIX);
    assert.match(k.hash, SQL_HASH);
    assert.equal(k.hash, hashApiKey(k.secret));
    assert.deepEqual(prefixOf(k.secret), { prefix: k.prefix, env });
    assert.equal(envOfPrefix(k.prefix), env);
  }
});

test('בלי תווים שמתבלבלים, ומפתחות לא חוזרים', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const { secret } = generateApiKey('live');
    assert.doesNotMatch(secret.slice(8), /[ilo01]/);
    assert.ok(!seen.has(secret));
    seen.add(secret);
  }
});

test('verifyApiKey דוחה כל שינוי במפתח', () => {
  const k = generateApiKey('live');
  assert.equal(verifyApiKey(k.secret, k.hash), true);
  const last = k.secret.at(-1) === 'a' ? 'b' : 'a';
  assert.equal(verifyApiKey(k.secret.slice(0, -1) + last, k.hash), false);
  assert.equal(verifyApiKey(k.secret, 'zz'), false);
});

test('prefixOf — אורך או קידומת לא נכונים = null', () => {
  const { secret } = generateApiKey('live');
  assert.equal(prefixOf(secret.slice(0, -1)), null);
  assert.equal(prefixOf(`bk_live_${secret.slice(8)}`), null);
  assert.equal(prefixOf(null), null);
});

test('bearerFrom — רק Bearer', () => {
  assert.equal(bearerFrom('Bearer abc'), 'abc');
  assert.equal(bearerFrom('bearer   abc '), 'abc');
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom(undefined), null);
});

/* ========================= הרשאות ========================= */

test('parseScopes מסנן זבל, מסיר כפילויות ושומר את סדר הרישום', () => {
  assert.deepEqual(parseScopes(['tasks.write', 'nope', 7, 'board.read', 'tasks.write']),
    ['board.read', 'tasks.write']);
  assert.deepEqual(parseScopes('board.read'), []);
});

test('כל הרשאה עונה על ה-CHECK במסד, מתועדת, ופותחת לפחות נתיב אחד', () => {
  assert.match(API_SCOPES.join(','), SQL_SCOPES);
  for (const s of API_SCOPES) {
    const m = API_SCOPE_REGISTRY[s];
    assert.ok(m.label && m.description, s);
    assert.ok(['read', 'write'].includes(m.group), s);
    assert.ok(ROUTES.some(([, , scope]) => scope === s), `${s} בלי נתיב`);
  }
  for (const [, , scope] of ROUTES) assert.ok(scope === null || API_SCOPE_REGISTRY[scope], scope);
});

test('implies גוזר רק קריאות — אף פעם כתיבה', () => {
  for (const s of API_SCOPES) {
    for (const d of derivedScopes([s])) assert.equal(API_SCOPE_REGISTRY[d].group, 'read', `${s} → ${d}`);
  }
  assert.deepEqual(expandScopes(['content.write']), ['campaigns.read', 'content.read', 'content.write']);
  assert.deepEqual(derivedScopes(['tasks.write']), ['tasks.read']);
});

test('הרשימה הלבנה: בלי מחיקה, אישור, פרסום, הגדרות, משתמשים או עוזר', () => {
  for (const [method, path] of ROUTES) {
    assert.notEqual(method, 'DELETE', path);
    assert.doesNotMatch(path,
      /approve|reject|publish(?!-log)|unpublish|engine|urgent|settings|users|backups|assistant|connection|api-keys|import|bulk/,
      `${method} ${path}`);
    // פעולות על קמפיין (השהיה, שכפול, סיום...) — לא לסוכנים
    assert.doesNotMatch(path, /^\/campaigns\/./, `${method} ${path}`);
  }
});

test('matchRoute — התאמה מדויקת, בלי נתיבים שלא ברשימה', () => {
  assert.equal(matchRoute('GET', '/content').scope, 'content.read');
  assert.equal(matchRoute('HEAD', '/content').scope, 'content.read');
  assert.equal(matchRoute('PATCH', '/content/12').scope, 'content.write');
  assert.equal(matchRoute('PUT', '/content/12/variants/3').scope, 'content.write');
  assert.equal(matchRoute('GET', '/posts/candidates').scope, 'board.read');
  assert.equal(matchRoute('DELETE', '/content/12'), null);
  assert.equal(matchRoute('POST', '/posts/4/approve'), null);
  assert.equal(matchRoute('GET', '/users'), null);
  assert.equal(matchRoute('GET', '/content/12/../../users'), null);
  assert.equal(matchRoute('PATCH', '/content/12/extra'), null);
});

/**
 * כל נתיב ברשימה קיים בפועל בראוטרים, ונתיב כתיבה מוגן ב-requirePerm('content')
 * בלבד — לא approve/settings/users, שהמשתמש הסינתטי של מפתח לא מחזיק אף פעם.
 */
test('כל נתיב ברשימה קיים בראוטרים, וכתיבה דורשת בדיוק content', () => {
  const dir = new URL('../src/routes/', import.meta.url);
  const declared = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/^r\.(get|post|put|patch|delete)\('([^']+)'(.*)$/gm)) {
      declared.set(`${m[1].toUpperCase()} ${m[2]}`, m[3]);
    }
  }
  for (const [method, path] of ROUTES) {
    if (path === '/whoami') continue;   // מוגדר בראוטר של הסוכנים עצמו
    const rest = declared.get(`${method} ${path}`);
    assert.ok(rest !== undefined, `${method} ${path} לא קיים בראוטרים`);
    if (method !== 'GET') assert.match(rest, /requirePerm\('content'\)/, `${method} ${path}`);
    assert.doesNotMatch(rest, /requirePerm\('(approve|settings|users)'\)/, `${method} ${path}`);
  }
});

test('ההוראות לסוכן מכילות את הכתובת, כל ההרשאות וכל הנתיבים', () => {
  const text = buildAgentHandbook('https://mc.example.com/');
  assert.match(text, /https:\/\/mc\.example\.com\/api\/v1/);
  assert.match(text, /Authorization: Bearer/);
  for (const s of API_SCOPES) assert.ok(text.includes(s), s);
  for (const [method, path] of ROUTES) assert.ok(text.includes(`${method} ${path}`), path);
});

/* ========================= השער ========================= */

const NOW = Date.parse('2026-10-08T10:00:00Z');
const live = generateApiKey('live');
const testKey = generateApiKey('test');

function row(over = {}) {
  return { id: 7, org_id: 3, name: 'בוט', key_hash: live.hash, scopes: ['content.write'],
    expires_at: null, revoked_at: null, ...over };
}

function spyDeps({ found = row(), env = 'other' } = {}) {
  const calls = { lookup: 0, touched: [], logs: [] };
  return {
    calls,
    deps: {
      lookupByPrefix: async () => { calls.lookup++; return found; },
      touchLastUsed: (id) => calls.touched.push(id),
      environment: () => env,
      now: () => NOW,
      log: (l) => calls.logs.push(l),
    },
  };
}

const req = (over = {}) => ({
  method: 'GET', path: '/content', ip: '10.0.0.1', authorization: `Bearer ${live.secret}`, ...over,
});

beforeEach(() => resetRateLimits());

test('Origin → 403 בלי לגעת במסד', async () => {
  const { deps, calls } = spyDeps();
  const d = await authenticateApiKey(req({ origin: 'https://evil.example' }), deps);
  assert.equal(d.status, 403);
  assert.equal(calls.lookup, 0);
});

test('בלי כותרת / לא Bearer / צורה שבורה → 401 בלי לגעת במסד', async () => {
  for (const authorization of [undefined, 'Basic x', 'Bearer short']) {
    const { deps, calls } = spyDeps();
    const d = await authenticateApiKey(req({ authorization }), deps);
    assert.deepEqual(d, { status: 401, error: 'לא מאומת' });
    assert.equal(calls.lookup, 0);
  }
});

test('לא נמצא, גיבוב שגוי, מבוטל ופג — אותה תשובה בדיוק', async () => {
  const cases = [
    null,
    row({ key_hash: generateApiKey('live').hash }),
    row({ revoked_at: '2026-10-01T00:00:00Z' }),
    row({ expires_at: '2026-10-08T09:59:59Z' }),
  ];
  for (const found of cases) {
    const { deps, calls } = spyDeps({ found });
    const d = await authenticateApiKey(req(), deps);
    assert.deepEqual(d, { status: 401, error: 'לא מאומת' });
    assert.equal(calls.touched.length, 0);
    assert.match(calls.logs[0], /reason=(not_found|hash_mismatch|revoked|expired)/);
  }
});

test('הצלחה: הארגון מהשורה, ההרשאות מורחבות, ושימוש אחרון נחתם', async () => {
  const { deps, calls } = spyDeps();
  const d = await authenticateApiKey(req(), deps);
  assert.equal(d.key.orgId, 3);
  assert.equal(d.key.prefix, live.prefix);
  assert.deepEqual(d.key.granted, ['content.write']);
  assert.ok(d.key.scopes.includes('content.read'));   // נגזר
  assert.deepEqual(calls.touched, [7]);
});

test('הרשאה חסרה → 403 עם שם ההרשאה, והמפתח מזוהה (לרישום)', async () => {
  const { deps, calls } = spyDeps();
  const d = await authenticateApiKey(req({ path: '/tasks' }), deps);
  assert.equal(d.status, 403);
  assert.match(d.error, /tasks\.read/);
  assert.deepEqual(d.identified, { id: 7, orgId: 3 });
  assert.equal(calls.touched.length, 0);
});

test('כתיבה לא גוזרת קריאה של משאב אחר, וקריאה לא נותנת כתיבה', async () => {
  const { deps } = spyDeps({ found: row({ scopes: ['board.read'] }) });
  assert.equal((await authenticateApiKey(req({ method: 'POST', path: '/content' }), deps)).status, 403);
  assert.ok((await authenticateApiKey(req({ path: '/board' }), deps)).key);
});

test('נתיב שלא ברשימה → 404 גם למפתח עם כל ההרשאות', async () => {
  const { deps } = spyDeps({ found: row({ scopes: API_SCOPES }) });
  for (const [method, path] of [['DELETE', '/content/4'], ['POST', '/posts/4/approve'],
    ['POST', '/posts/4/publish-now'], ['GET', '/users'], ['POST', '/engine/apply']]) {
    const d = await authenticateApiKey(req({ method, path }), deps);
    assert.equal(d.status, 404, `${method} ${path}`);
  }
});

test('whoami פתוח לכל מפתח תקף, גם בלי הרשאות', async () => {
  const { deps } = spyDeps({ found: row({ scopes: [] }) });
  assert.ok((await authenticateApiKey(req({ path: '/whoami' }), deps)).key);
});

test('מפתח בדיקה: נדחה בפרודקשן רק אחרי אימות הגיבוב; מחוץ לפרודקשן עובר', async () => {
  const good = row({ key_hash: testKey.hash });
  const prod = spyDeps({ found: good, env: 'production' });
  const d = await authenticateApiKey(req({ authorization: `Bearer ${testKey.secret}` }), prod.deps);
  assert.equal(d.status, 403);
  assert.match(d.error, /בדיקה/);

  const wrong = spyDeps({ found: row({ key_hash: live.hash }), env: 'production' });
  assert.equal((await authenticateApiKey(req({ authorization: `Bearer ${testKey.secret}` }), wrong.deps)).status, 401);

  const dev = spyDeps({ found: good });
  assert.ok((await authenticateApiKey(req({ authorization: `Bearer ${testKey.secret}` }), dev.deps)).key);
});

test('הגבלת קצב לפי IP נעצרת לפני המסד', async () => {
  const { deps, calls } = spyDeps();
  for (let i = 0; i < PER_IP_PER_MINUTE; i++) await authenticateApiKey(req({ authorization: 'Basic x' }), deps);
  const d = await authenticateApiKey(req(), deps);
  assert.equal(d.status, 429);
  assert.equal(calls.lookup, 0);
});
