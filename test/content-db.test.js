import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * גל 4 מול Postgres אמיתי: "מוכן" במעבר בלבד, עוקבת שנשארת טיוטה, שמירה
 * ראשונה במקביל, מחיקת קמפיין עם התוכן, ושכפול שמעתיק meta. הנתיבים רצים
 * באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת (כמו links-db).
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/content-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;
const pending = new Set();

async function call(method, path, body, { form } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: form ? {} : { 'content-type': 'application/json' },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);
  return { status: res.status, json };
}

const q = (sql, params) => db.withOrg(org, () => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;
const variant = (id, ch) =>
  q1('select body, status, meta from content_variants where content_id = $1 and channel_id = $2', [id, ch]);

async function uploadBytes(contentId, name = 'cover.png') {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), name);
  const r = await call('POST', `/content/${contentId}/assets`, null, { form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.assets[0];
}

/** משבצת בקמפיין הכללי, דרך הנתיב — כמו הטופס */
async function slot(channelId, sortOrder, over = {}) {
  const r = await call('POST', '/content', {
    title: `פוסט ${channelId}/${sortOrder}`, kind: 'value', campaign_id: ids.general,
    slot_channel_id: channelId, sort_order: sortOrder, body: 'טקסט', status: 'draft', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.content.id;
}

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: content } = await import('../src/routes/content.js');
  const { default: campaigns } = await import('../src/routes/campaigns.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('content-test') returning id")).rows[0].id;
  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 8) returning id");
    const ch = async (name, platform) => (await db.one(
      'insert into channels (name, platform, max_per_week) values ($1,$2,7) returning id',
      [name, platform])).id;
    const ig = await ch('אינסטגרם', 'instagram');
    const yt = await ch('יוטיוב', 'manual');
    const nl = await ch('ניוזלטר', 'newsletter');
    const fb = await ch('פייסבוק', 'facebook');
    const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const general = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period)
       values ($1,'כללי',$2,$3,'general','custom') returning id`, [ep.id, start, end]);
    const angles = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on) values ($1,'זוויות',$2,$3)
       returning id`, [ep.id, start, end]);
    for (const c of [general.id, angles.id]) {
      for (const chId of [ig, yt, nl, fb]) {
        await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [c, chId]);
      }
    }
    return { endpoint: ep.id, ig, yt, nl, fb, general: general.id, angles: angles.id };
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

/** זווית בקמפיין לפי זוויות, עם גרסת טיוטה לכל ערוץ */
async function angle(sortOrder) {
  const r = await call('POST', '/content', {
    title: `זווית ${sortOrder}`, kind: 'value', campaign_id: ids.angles, sort_order: sortOrder,
    channel_ids: [ids.ig, ids.yt, ids.nl] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.content.id;
}

test('"מוכן" במעבר בלבד: אינסטגרם בלי מדיה נדחה; גרסה שכבר מוכנה נשמרת עם warn', { skip }, async () => {
  const a = await angle(1);
  let r = await call('PUT', `/content/${a}/variants/${ids.ig}`, { body: 'טקסט', status: 'ready' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /תמונה או וידאו/);
  assert.equal((await variant(a, ids.ig)).status, 'draft', 'הדחייה לא כתבה כלום');

  // גרסה שסומנה מוכנה לפני הבדיקה (נתונים ישנים)
  await q(`update content_variants set status = 'ready' where content_id = $1 and channel_id = $2`,
    [a, ids.ig]);
  r = await call('PUT', `/content/${a}/variants/${ids.ig}`, { body: 'טקסט מתוקן', status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.warn, /תמונה או וידאו/);
  assert.equal((await variant(a, ids.ig)).body, 'טקסט מתוקן');

  // עם מדיה — המעבר עובר, בלי warn
  const b = await angle(2);
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'x.png');
  assert.equal((await call('POST', `/content/${b}/variants/${ids.ig}/assets`, null, { form })).status, 201);
  r = await call('PUT', `/content/${b}/variants/${ids.ig}`, { body: '', status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.warn, null);
});

test('"מוכן" במעבר בלבד — משבצת (PATCH): יצירה/מעבר נדחים, מוכנה קיימת נשמרת עם warn', { skip }, async () => {
  const r0 = await call('POST', '/content', {
    title: 'ריל', kind: 'value', campaign_id: ids.general, slot_channel_id: ids.ig,
    sort_order: 1, body: 'x', status: 'ready' });
  assert.equal(r0.status, 400, 'יצירה כמוכן בלי מדיה');
  const a = await slot(ids.ig, 1);
  let r = await call('PATCH', `/content/${a}`, { status: 'ready' });
  assert.equal(r.status, 400);
  await q(`update content_variants set status = 'ready' where content_id = $1`, [a]);
  r = await call('PATCH', `/content/${a}`, { body: 'עריכה' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.warn, /תמונה או וידאו/);
});

test('קישור: "מוכן" לא עובר לעוקבת באינסטגרם בלי מדיה — היא נשארת טיוטה, ובתשובה', { skip }, async () => {
  const a = await slot(ids.yt, 10, { body: 'כיתוב', status: 'ready' });
  let r = await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.ig, sort_order: 10 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = r.json.follower.id;
  assert.deepEqual(await variant(b, ids.ig), { body: 'כיתוב', status: 'draft', meta: null });
  assert.equal(r.json.downgraded.length, 1);
  assert.equal(r.json.downgraded[0].channel_name, 'אינסטגרם');
  assert.match(r.json.downgraded[0].reason, /תמונה או וידאו/);
  assert.equal((await variant(a, ids.yt)).status, 'ready', 'המקור נשאר מוכן');

  // אחרי שלמקור יש תמונה: עריכת טקסט לא משנה מצב (העוקבת נשארת טיוטה), וסימון
  // העוקבת "מוכן" עובר — המדיה של המקור מספיקה לאינסטגרם
  await uploadBytes(a);
  r = await call('PATCH', `/content/${a}`, { body: 'כיתוב חדש' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await variant(b, ids.ig), { body: 'כיתוב חדש', status: 'draft', meta: null });
  r = await call('PATCH', `/content/${b}`, { status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.downgraded, []);
  assert.deepEqual(await variant(b, ids.ig), { body: 'כיתוב חדש', status: 'ready', meta: null });
  assert.equal((await variant(a, ids.yt)).status, 'ready');
});

test('שמירה ראשונה במקביל (base null): אחת נשמרת, השנייה 409 — לא דורסת', { skip }, async () => {
  const a = await call('POST', '/content', {
    title: 'בלי גרסאות', kind: 'value', campaign_id: ids.angles, sort_order: 20 });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const id = a.json.content.id;
  const [r1, r2] = await Promise.all(['ראשון', 'שני'].map((body) =>
    call('PUT', `/content/${id}/variants/${ids.yt}`, { body, status: 'draft', base_updated_at: null })));
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([r1.json, r2.json]));
  const won = r1.status === 200 ? 'ראשון' : 'שני';
  assert.equal((await variant(id, ids.yt)).body, won);
  const lost = r1.status === 409 ? r1 : r2;
  assert.equal(lost.json.stale, true);
  assert.equal(lost.json.current.body, won);
});

test('מחיקת קמפיין עם התוכן: גם פוסט שהמועד שלו עבר ולא פורסם יורד; publishing נשאר', { skip }, async () => {
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on) values ($1,'למחיקה',
       current_date, current_date + 20) returning id`, [ids.endpoint]);
  const it = await q1(
    `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
     values ($1,$2,'value','ת',1) returning id`, [ids.endpoint, c.id]);
  const post = (status, days) => q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, status, scheduled_at)
     values ($1,$2,$3,'ת','value',$4, now() + make_interval(days => $5)) returning id`,
    [ids.yt, ids.endpoint, it.id, status, days]);
  const future = await post('scheduled', 3);
  const pastFailed = await post('failed', -3);
  const publishing = await post('publishing', -1);
  const published = await post('published', -5);

  const imp = await call('GET', `/campaigns/${c.id}/delete-impact`);
  assert.deepEqual(imp.json, { content: 1, future_posts: 1, unpublished_posts: 2, published: 1 });

  const r = await call('DELETE', `/campaigns/${c.id}?content=delete`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.removed, { content: 1, posts: 2 });
  const left = await q('select id, status, content_id from posts where id = any($1::int[]) order by id',
    [[future.id, pastFailed.id, publishing.id, published.id]]);
  assert.deepEqual(left.map((p) => p.status).sort(), ['published', 'publishing']);
  assert.ok(left.every((p) => p.content_id === null));
});

test('שכפול קמפיין מעתיק את ה-meta של הגרסאות (נושא הניוזלטר)', { skip }, async () => {
  const a = await angle(30);
  await q(`update content_variants set meta = '{"subject":"נושא"}'::jsonb
            where content_id = $1 and channel_id = $2`, [a, ids.nl]);
  const r = await call('POST', `/campaigns/${ids.angles}/duplicate`, {
    name: 'עותק', endpoint_id: ids.endpoint, starts_on: new Date().toISOString().slice(0, 10),
    period: '1m', channel_ids: [ids.ig, ids.yt, ids.nl] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const copy = await q1(
    `select v.meta from content_variants v join content_items ci on ci.id = v.content_id
      where ci.campaign_id = $1 and ci.title = 'זווית 30' and v.channel_id = $2`,
    [r.json.campaign.id, ids.nl]);
  assert.deepEqual(copy.meta, { subject: 'נושא' });
});

test('הסרת קובץ מחזירה warn לגרסה "מוכן" שאיבדה את המדיה שלה', { skip }, async () => {
  const a = await angle(40);
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'x.png');
  const up = await call('POST', `/content/${a}/variants/${ids.ig}/assets`, null, { form });
  assert.equal((await call('PUT', `/content/${a}/variants/${ids.ig}`,
    { body: '', status: 'ready' })).status, 200);
  const r = await call('DELETE', `/assets/${up.json.assets[0].id}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const w = r.json.warns.find((x) => x.content_id === a && x.channel_id === ids.ig);
  assert.match(w.warn, /תמונה או וידאו/);
});

test('עריכת טקסט בעוקבת שנשארה טיוטה: העוקבת טיוטה, המקור נשאר מוכן, הטקסט עובר למקור', { skip }, async () => {
  const a = await slot(ids.fb, 60, { body: 'פוסט פייסבוק', status: 'ready' });
  let r = await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.ig, sort_order: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = r.json.follower.id;
  assert.equal((await variant(b, ids.ig)).status, 'draft', 'אינסטגרם בלי מדיה נשאר טיוטה');
  assert.equal((await variant(a, ids.fb)).status, 'ready');

  // עריכת טקסט בלבד בעוקבת
  r = await call('PATCH', `/content/${b}`, { body: 'נערך באינסטגרם' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await variant(b, ids.ig), { body: 'נערך באינסטגרם', status: 'draft', meta: null });
  assert.deepEqual(await variant(a, ids.fb), { body: 'נערך באינסטגרם', status: 'ready', meta: null });

  // כמו הטופס: שולח גם את המצב, בלי לשנות אותו (טיוטה) — המקור עדיין מוכן
  r = await call('PATCH', `/content/${b}`, { body: 'שוב מהטופס', status: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await variant(a, ids.fb), { body: 'שוב מהטופס', status: 'ready', meta: null });
  assert.equal((await variant(b, ids.ig)).status, 'draft');

  // ועריכת טקסט במקור (בלי שינוי מצב) לא מעבירה "מוכן" לעוקבת
  r = await call('PUT', `/content/${a}/variants/${ids.fb}`, { body: 'מהמקור', status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await variant(b, ids.ig), { body: 'מהמקור', status: 'draft', meta: null });
});

test('שדות נוספים לפי פלטפורמה (meta): נשמרים, קישור לא תקין נדחה, שער לא נספר ב"מוכן"', { skip }, async () => {
  const a = await angle(60);
  // פייסבוק: קישור javascript: לא נשמר בכלל — גם לא כטיוטה
  let r = await call('PUT', `/content/${a}/variants/${ids.fb}`,
    { body: 'טקסט', status: 'draft', meta: { link: 'javascript:alert(1)' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /הקישור לא תקין/);

  // קישור לבד מספיק ל"מוכן" בפייסבוק; meta של אחרים (נושא) נשמר כמו שנשלח
  r = await call('PUT', `/content/${a}/variants/${ids.fb}`,
    { body: '', status: 'ready', meta: { link: 'https://fincat.co.il/x', first_comment: 'תגובה' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await variant(a, ids.fb)).meta, { link: 'https://fincat.co.il/x', first_comment: 'תגובה' });
  // שמירה בלי meta — לא נוגעת בקיים
  r = await call('PUT', `/content/${a}/variants/${ids.fb}`, { body: 'טקסט', status: 'ready' });
  assert.equal((await variant(a, ids.fb)).meta.first_comment, 'תגובה');

  // אינסטגרם: סרטון + תמונה = קרוסלה של 2. כסטורי — נדחה, אלא אם התמונה היא השער
  const b = await angle(61);
  for (const [name, type] of [['v.mp4', 'video/mp4'], ['c.png', 'image/png']]) {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('DATA')], { type }), name);
    assert.equal((await call('POST', `/content/${b}/variants/${ids.ig}/assets`, null, { form })).status, 201);
  }
  const cover = await q1(`select id from content_assets where content_id = $1 and filename = 'c.png'`, [b]);
  r = await call('PUT', `/content/${b}/variants/${ids.ig}`,
    { body: '', status: 'ready', meta: { format: 'story' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /סטורי יוצא עם תמונה או סרטון אחד — יש 2/);
  r = await call('PUT', `/content/${b}/variants/${ids.ig}`,
    { body: '', status: 'ready', meta: { format: 'story', cover_asset_id: cover.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.warn, null);
});

test('פרסום עם תגובה ראשונה: הפוסט נרשם "פורסם" לפני התגובה; תגובה שנכשלה = משימה, לא כשל', { skip }, async () => {
  const { publishOne } = await import('../src/publish/runner.js');
  const { encryptSecret } = await import('../src/publish/crypto.js');
  const a = await angle(62);
  const r = await call('PUT', `/content/${a}/variants/${ids.fb}`, { body: 'שלום', status: 'ready',
    meta: { link: 'https://fincat.co.il/x', first_comment: 'הקישור בתגובה' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await q(`insert into channel_connections (channel_id, page_id, access_token_enc, auto_enabled)
           values ($1, '9', $2, true) on conflict (channel_id) do update set page_id = '9',
             access_token_enc = excluded.access_token_enc`, [ids.fb, encryptSecret('tok')]);
  const post = await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
     values ($1,$2,$3,'עם תגובה','value', now(), 'approved') returning id`, [ids.fb, ids.endpoint, a]);

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, '');
    // מה מצב הפוסט ברגע שהתגובה נשלחת — באותה טרנזקציה
    const status = path.endsWith('/comments')
      ? (await db.one('select status from posts where id = $1', [post.id])).status : null;
    seen.push({ path, status, params: Object.fromEntries(opts.body ?? []) });
    if (path.endsWith('/comments')) {
      return new Response(JSON.stringify({ error: { message: '(#200) pages_manage_engagement', code: 200 } }),
        { status: 400 });
    }
    return new Response(JSON.stringify({ id: '9_1' }), { status: 200 });
  };
  let out;
  try {
    out = await db.withOrg(org, () => publishOne(post.id));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(seen.map((s) => s.path), ['9/feed', '9_1/comments']);
  assert.equal(seen[0].params.link, 'https://fincat.co.il/x');
  assert.equal(seen[1].status, 'published', 'התגובה נשלחה רק אחרי שהפוסט נרשם');
  assert.equal((await q1('select status from posts where id = $1', [post.id])).status, 'published');
  const task = await q1(`select kind, done, title, subtitle from tasks where post_id = $1 and kind = 'general'`, [post.id]);
  assert.equal(task.done, false);
  assert.match(task.subtitle, /הקישור בתגובה/);
});

test('משבצת בקמפיין כללי: שדות הפרסום נשמרים ביצירה ובעריכה, קישור לא תקין נדחה', { skip }, async () => {
  // יצירה עם meta — קישור לבד מספיק ל"מוכן" בפייסבוק
  let r = await call('POST', '/content', {
    title: 'עם קישור', kind: 'value', campaign_id: ids.general, slot_channel_id: ids.fb,
    sort_order: 70, body: '', status: 'ready',
    meta: { link: 'https://fincat.co.il/x', first_comment: 'תגובה' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = r.json.content.id;
  assert.deepEqual((await variant(id, ids.fb)).meta, { link: 'https://fincat.co.il/x', first_comment: 'תגובה' });

  r = await call('POST', '/content', {
    title: 'רע', kind: 'value', campaign_id: ids.general, slot_channel_id: ids.fb,
    sort_order: 71, body: 'x', meta: { link: 'javascript:alert(1)' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /הקישור לא תקין/);

  // עריכה: meta לבד מתעדכן, הטקסט והמצב נשארים; בלי meta — לא נוגעים בקיים
  r = await call('PATCH', `/content/${id}`, { meta: { alt_text: 'תיאור' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let v = await variant(id, ids.fb);
  assert.deepEqual(v.meta, { alt_text: 'תיאור' });
  assert.equal(v.status, 'ready');
  r = await call('PATCH', `/content/${id}`, { title: 'עם קישור', body: 'טקסט', status: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  v = await variant(id, ids.fb);
  assert.deepEqual(v.meta, { alt_text: 'תיאור' });
  assert.equal(v.body, 'טקסט');
  r = await call('PATCH', `/content/${id}`, { meta: { link: 'ftp://x' } });
  assert.equal(r.status, 400);

  // אינסטגרם: סטורי עם שני קבצים לא עובר ל"מוכן" (meta שנשלח באותה בקשה נבדק)
  const ig = (await call('POST', '/content', {
    title: 'סטורי', kind: 'value', campaign_id: ids.general, slot_channel_id: ids.ig,
    sort_order: 70, body: '', status: 'draft' })).json.content.id;
  for (const name of ['a.png', 'b.png']) await uploadBytes(ig, name);
  r = await call('PATCH', `/content/${ig}`, { status: 'ready', meta: { format: 'story' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /סטורי יוצא עם תמונה או סרטון אחד/);
});
