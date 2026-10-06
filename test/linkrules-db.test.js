import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * קישור עמודות (POST /campaigns/:id/link-rules) מול Postgres אמיתי.
 *
 * (הסביבה זהה ל-convert-db.test.js.) המרת קמפיין לפי זוויות לכללי (POST /campaigns/:id/to-general) מול Postgres
 * אמיתי: כל ניסוח הופך לפוסט בערוץ שלו, עם הטקסט, המצב, ה-meta, הקבצים
 * והפוסטים שכבר שובצו; "לא רלוונטי" לא הופך לפוסט; שתי זוויות באותו מקום
 * מקבלות משבצות שונות.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKRULES_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/convert-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKRULES_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKRULES_TEST_DB=1 + DATABASE_URL מקומי)';

process.env.R2_ACCOUNT_ID ??= 'acc';
process.env.R2_ACCESS_KEY_ID ??= 'key';
process.env.R2_SECRET_ACCESS_KEY ??= 'secret';
process.env.R2_BUCKET ??= 'backup';
process.env.R2_PUBLIC_BUCKET ??= 'media-test';
process.env.R2_PUBLIC_BASE_URL ??= 'https://media.example.test';

let db, server, base, org, ids, copies;
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

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: content } = await import('../src/routes/content.js');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { mediaStore } = await import('../src/media.js');

  await db.migrate();
  copies = [];
  mediaStore.copy = async (src, dst) => { copies.push([src, dst]); };

  org = (await db.pool.query("insert into orgs (name) values ('linkrules-test') returning id")).rows[0].id;
  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const ep = await db.one("insert into endpoints (name, importance) values ('אתגר', 6) returning id");
    const ch = async (name, platform, order) => (await db.one(
      'insert into channels (name, platform, max_per_week, sort_order) values ($1,$2,3,$3) returning id',
      [name, platform, order])).id;
    return {
      endpoint: ep.id,
      fb: await ch('פייסבוק', 'manual', 1),
      li: await ch('לינקדאין', 'manual', 2),
      nl: await ch('ניוזלטר', 'newsletter', 3),
      yt: await ch('יוטיוב שורטס', 'manual', 4),
    };
  });

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
  app.use(content);
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


async function general(name) {
  const r = await call('POST', '/campaigns', {
    name, endpoint_id: ids.endpoint, starts_on: '2027-03-01', period: '1m',
    channel_ids: [ids.fb, ids.li, ids.nl, ids.yt],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.campaign.id;
}

async function post(campaignId, channelId, n, title) {
  const r = await call('POST', '/content', {
    title, kind: 'value', body: `טקסט ${title}`, status: 'draft',
    campaign_id: campaignId, slot_channel_id: channelId, sort_order: n,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const slots = (campaignId, channelId) => q(
  `select id, sort_order, title, linked_to_id from content_items
    where campaign_id = $1 and slot_channel_id = $2 order by sort_order`, [campaignId, channelId]);

test('קישור עמודות: חוקים לא תקינים נדחים', { skip }, async () => {
  const id = await general('חוקים');
  const bad = async (rules, re) => {
    const r = await call('POST', `/campaigns/${id}/link-rules`, { rules });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, re);
  };
  await bad([{ from: ids.fb, to: ids.fb }], /לעצמו/);
  await bad([{ from: ids.fb, to: ids.nl }], /ניוזלטר/);
  await bad([{ from: ids.fb, to: ids.yt }, { from: ids.yt, to: ids.li }], /לא יכול להעתיק הלאה/);
  await bad([{ from: ids.fb, to: 999999 }], /שבקמפיין/);
  await bad('x', /לא תקינה/);
});

test('קישור עמודות: קיימים מועתקים למשבצת הפנויה הבאה, חדשים — לבד; הסרה עוצרת', { skip }, async () => {
  const id = await general('רילס');
  const a = await post(id, ids.fb, 1, 'א');
  await post(id, ids.fb, 3, 'ב');
  await post(id, ids.yt, 1, 'שורט ידני');   // משבצת 1 ביוטיוב תפוסה

  const rules = [{ from: ids.fb, to: ids.yt }];
  const dry = await call('POST', `/campaigns/${id}/link-rules`, { rules, dry_run: true });
  assert.equal(dry.json.copies, 2);
  assert.equal((await slots(id, ids.yt)).length, 1, 'dry_run לא כותב');

  const r = await call('POST', `/campaigns/${id}/link-rules`, { rules });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.linked, 2);
  let yt = await slots(id, ids.yt);
  assert.deepEqual(yt.map((x) => [x.sort_order, x.title]), [[1, 'שורט ידני'], [2, 'א'], [3, 'ב']]);
  assert.equal(yt[1].linked_to_id, a.content.id);

  // שמירה חוזרת — לא מעתיקה שוב
  const again = await call('POST', `/campaigns/${id}/link-rules`, { rules });
  assert.equal(again.json.linked, 0);

  // פוסט חדש בפייסבוק — מועתק לבד, והתשובה אומרת
  const c = await post(id, ids.fb, 2, 'ג');
  assert.equal(c.copied.linked, 1);
  yt = await slots(id, ids.yt);
  assert.deepEqual(yt.map((x) => [x.sort_order, x.title]).at(-1), [4, 'ג']);

  // פוסט חדש ביוטיוב (עמודת יעד) לא מועתק לשום מקום
  const y = await post(id, ids.yt, 5, 'שורט');
  assert.equal(y.copied.linked, 0);

  // הסרת החוק: פוסט חדש לא מועתק, הקיימים נשארים מקושרים
  await call('POST', `/campaigns/${id}/link-rules`, { rules: [] });
  const d = await post(id, ids.fb, 4, 'ד');
  assert.equal(d.copied.linked, 0);
  assert.equal((await slots(id, ids.yt)).filter((x) => x.linked_to_id).length, 3);
});

test('קישור עמודות: שכפול הקמפיין שומר את החוקים', { skip }, async () => {
  const id = await general('לשכפול');
  await call('POST', `/campaigns/${id}/link-rules`, { rules: [{ from: ids.fb, to: ids.li }] });
  const r = await call('POST', `/campaigns/${id}/duplicate`, {
    name: 'עותק', endpoint_id: ids.endpoint, starts_on: '2027-06-01', period: '1m',
    channel_ids: [ids.fb, ids.li],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.campaign.link_rules, [{ from: ids.fb, to: ids.li }]);
  const p = await post(r.json.campaign.id, ids.fb, 1, 'בעותק');
  assert.equal(p.copied.linked, 1);
});
