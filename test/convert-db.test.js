import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * המרת קמפיין לפי זוויות לכללי (POST /campaigns/:id/to-general) מול Postgres
 * אמיתי: כל ניסוח הופך לפוסט בערוץ שלו, עם הטקסט, המצב, ה-meta, הקבצים
 * והפוסטים שכבר שובצו; "לא רלוונטי" לא הופך לפוסט; שתי זוויות באותו מקום
 * מקבלות משבצות שונות.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   CONVERT_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/convert-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.CONVERT_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (CONVERT_TEST_DB=1 + DATABASE_URL מקומי)';

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

  org = (await db.pool.query("insert into orgs (name) values ('convert-test') returning id")).rows[0].id;
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

async function angleCampaign(name, over = {}) {
  const r = await call('POST', '/campaigns', {
    name, endpoint_id: ids.endpoint, starts_on: '2027-03-01', period: '1m', structure: 'angles',
    channel_ids: [ids.fb, ids.li, ids.nl], ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.campaign.id;
}

async function angle(campaignId, sortOrder, title) {
  const r = await call('POST', '/content', {
    title, kind: 'value', campaign_id: campaignId, sort_order: sortOrder, body: `גוף ${title}`,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.content.id;
}

async function variant(contentId, channelId, body, extra = {}) {
  const r = await call('PUT', `/content/${contentId}/variants/${channelId}`,
    { body, status: 'draft', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.variant?.id ?? (await q1(
    'select id from content_variants where content_id = $1 and channel_id = $2',
    [contentId, channelId])).id;
}

test('המרה לכללי: ניסוח לכל ערוץ = פוסט משלו, עם הטקסט, ה-meta, הקבצים והפוסטים', { skip }, async () => {
  const id = await angleCampaign('אתגר הפלאפל');
  const a1 = await angle(id, 1, 'זווית ראשונה');
  await variant(a1, ids.fb, 'ניסוח לפייסבוק');
  const liV = await variant(a1, ids.li, 'ניסוח ללינקדאין');
  await variant(a1, ids.nl, '<p>מייל</p>', { meta: { subject: 'נושא', list_ids: ['L1'], segment_ids: [] } });
  // שתי זוויות באותו מקום — השנייה מקבלת את המשבצת הפנויה הבאה
  // (הטופס לא מאפשר — נוצרת במקום 2 ומוזזת, כמו זווית "מעבר לתכנון" מגרסה ישנה)
  const a2 = await angle(id, 2, 'זווית כפולה');
  await q('update content_items set sort_order = 1 where id = $1', [a2]);
  await variant(a2, ids.fb, 'עוד ניסוח');
  await variant(a2, ids.li, 'לא כאן', { status: 'not_relevant' });
  // זווית בלי אף ניסוח
  await angle(id, 3, 'רק כותרת');

  // קובץ משותף (R2) + קובץ של הגרסה ללינקדאין + פוסט משובץ בלינקדאין
  await q(`insert into content_assets (content_id, filename, mime, size_bytes, storage_key)
           values ($1,'shared.png','image/png',10,$2)`, [a1, `media/${org}/${crypto.randomUUID()}/shared.png`]);
  await q(`insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data)
           values ($1,$2,'li.png','image/png',3,'\\x414243')`, [a1, liV]);
  await q(`insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
           values ($1,$2,$3,'משובץ','value','2027-03-03 10:00+02')`, [ids.li, ids.endpoint, a1]);
  copies.length = 0;

  const r = await call('POST', `/campaigns/${id}/to-general`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.converted.angles, 3);

  const camp = await q1('select structure, target_posts from campaigns where id = $1', [id]);
  assert.equal(camp.structure, 'general');

  const items = await q(
    `select ci.id, ci.title, ci.body, ci.slot_channel_id as ch, ci.sort_order as n, ci.linked_to_id,
            v.body as vbody, v.status, v.meta
       from content_items ci
       left join content_variants v on v.content_id = ci.id and v.channel_id = ci.slot_channel_id
      where ci.campaign_id = $1 order by ci.slot_channel_id, ci.sort_order`, [id]);
  const at = (ch, n) => items.find((x) => x.ch === ch && x.n === n);

  // זווית 1: הפריט המקורי נשאר בפייסבוק #1, לינקדאין וניוזלטר — פריטים חדשים
  assert.equal(at(ids.fb, 1).id, a1);
  assert.equal(at(ids.fb, 1).vbody, 'ניסוח לפייסבוק');
  assert.equal(at(ids.li, 1).vbody, 'ניסוח ללינקדאין');
  assert.equal(at(ids.li, 1).body, 'ניסוח ללינקדאין');
  assert.equal(at(ids.nl, 1).meta.subject, 'נושא');
  assert.ok(items.every((x) => x.linked_to_id == null), 'לא מקושרים — כל ערוץ שומר ניסוח');
  // זווית כפולה: פייסבוק #2; "לא רלוונטי" ללינקדאין לא הפך לפוסט
  assert.equal(at(ids.fb, 2).title, 'זווית כפולה');
  assert.equal(items.filter((x) => x.title === 'זווית כפולה').length, 1);
  // בלי ניסוח: טיוטה בערוץ הראשון עם הטקסט של הזווית
  assert.equal(at(ids.fb, 3).title, 'רק כותרת');
  assert.equal(at(ids.fb, 3).status, 'draft');
  assert.equal(at(ids.fb, 3).vbody, 'גוף רק כותרת');
  // לכל פריט גרסה אחת בדיוק — לערוץ שלו
  const stray = await q(
    `select v.id from content_variants v join content_items ci on ci.id = v.content_id
      where ci.campaign_id = $1 and v.channel_id <> ci.slot_channel_id`, [id]);
  assert.equal(stray.length, 0);

  // קבצים: המשותף נשאר במקורי ומועתק (ב-R2) לשני הפוסטים הנוספים; של הגרסה עבר איתה
  const assets = await q(
    `select a.content_id, a.filename, a.variant_id, a.storage_key from content_assets a
       join content_items ci on ci.id = a.content_id where ci.campaign_id = $1`, [id]);
  for (const it of [at(ids.fb, 1), at(ids.li, 1), at(ids.nl, 1)]) {
    assert.equal(assets.filter((a) => a.content_id === it.id && a.filename === 'shared.png').length, 1);
  }
  assert.equal(copies.length, 2);
  assert.equal(new Set(assets.filter((a) => a.storage_key).map((a) => a.storage_key)).size, 3);
  assert.equal(assets.find((a) => a.filename === 'li.png').content_id, at(ids.li, 1).id);

  // הפוסט שכבר שובץ בלינקדאין עבר לפוסט של לינקדאין
  const post = await q1(`select content_id from posts where title = 'משובץ' and channel_id = $1`, [ids.li]);
  assert.equal(post.content_id, at(ids.li, 1).id);

  // פעם שנייה — כבר כללי
  const again = await call('POST', `/campaigns/${id}/to-general`, {});
  assert.equal(again.status, 400);
});

test('המרה לכללי: בלי תאריך סיום — נדחה, ושום דבר לא משתנה', { skip }, async () => {
  const id = await angleCampaign('בלי סוף', { period: 'open' });
  await angle(id, 1, 'זווית');
  const r = await call('POST', `/campaigns/${id}/to-general`, {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /תאריך סיום/);
  const camp = await q1('select structure from campaigns where id = $1', [id]);
  assert.equal(camp.structure, 'angles');
});
